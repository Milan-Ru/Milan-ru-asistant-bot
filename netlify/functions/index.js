const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nacl = require('tweetnacl');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DEFAULT_PASSWORD = 'admin#123';
const SESSION_HOURS = 24;

// ===================== PROVIDER DISPATCH =====================

async function callGeminiText(apiKey, model, messages) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
    }));
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Gemini API error');
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini: respons kosong');
    return text;
}

async function callGeminiImage(apiKey, model, prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['IMAGE'] }
        })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Gemini Image API error');
    const parts = data.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData);
    if (!imagePart) throw new Error('Tidak ada gambar dihasilkan');
    return imagePart.inlineData.data;
}

async function callOpenAICompatible(baseUrl, apiKey, model, messages, extraHeaders = {}) {
    const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ...extraHeaders
        },
        body: JSON.stringify({
            model: model,
            messages: messages.map(m => ({ role: m.role, content: m.content }))
        })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `${baseUrl} error`);
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('Respons kosong dari provider');
    return text;
}

async function callProviderText(provider, apiKey, model, messages) {
    switch (provider) {
        case 'gemini': return callGeminiText(apiKey, model, messages);
        case 'groq': return callOpenAICompatible('https://api.groq.com/openai/v1/chat/completions', apiKey, model, messages);
        case 'openrouter': return callOpenAICompatible('https://openrouter.ai/api/v1/chat/completions', apiKey, model, messages, {
            'HTTP-Referer': 'https://netlify.app',
            'X-Title': 'AI Bot'
        });
        default: throw new Error(`Provider tidak dikenal: ${provider}`);
    }
}

// ===================== SHARED DATA HELPERS =====================

async function getBotConfig() {
    const { data, error } = await supabase.from('bot_config').select('*').eq('id', 1).maybeSingle();
    if (error || !data) throw new Error('Bot config tidak ditemukan');
    return data;
}

async function getActiveApiKeys() {
    const { data, error } = await supabase
        .from('api_keys').select('*').eq('active', true).order('created_at', { ascending: true });
    if (error) throw new Error('Gagal ambil api_keys: ' + error.message);
    return data || [];
}

async function getSession(platform, userId) {
    const { data, error } = await supabase
        .from('sessions').select('messages, active_provider_id')
        .eq('platform', platform).eq('user_id', userId).maybeSingle();
    if (error) {
        console.error('Get session error:', error.message);
        return { messages: [], active_provider_id: null };
    }
    return data || { messages: [], active_provider_id: null };
}

async function saveSession(platform, userId, messages, activeProviderId) {
    const { error } = await supabase.from('sessions').upsert({
        platform, user_id: userId, messages, active_provider_id: activeProviderId,
        updated_at: new Date().toISOString()
    });
    if (error) console.error('Save session error:', error.message);
}

function pickActiveKey(apiKeys, session, config) {
    let key = apiKeys.find(k => k.id === session.active_provider_id);
    if (!key) key = apiKeys.find(k => k.id === config.default_provider_id) || apiKeys[0];
    return key;
}

async function generateReply(activeKey, userText, session) {
    if (activeKey.output_type === 'image') {
        const base64 = await callGeminiImage(activeKey.api_key, activeKey.model_name, userText);
        return { type: 'image', data: base64 };
    }
    const messages = [...session.messages, { role: 'user', content: userText }];
    const reply = await callProviderText(activeKey.provider, activeKey.api_key, activeKey.model_name, messages);
    return { type: 'text', data: reply, updatedMessages: [...messages, { role: 'assistant', content: reply }] };
}

// ===================== TELEGRAM =====================

async function sendTelegramMessage(token, chatId, text) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text })
    });
}

async function sendTelegramPhoto(token, chatId, base64Image, caption) {
    const buffer = Buffer.from(base64Image, 'base64');
    const blob = new Blob([buffer], { type: 'image/png' });
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption || '');
    form.append('photo', blob, 'generated.png');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.description || 'Gagal kirim foto ke Telegram');
    }
}

async function syncTelegramCommands(token, apiKeys) {
    if (!token) return;
    const commands = [
        { command: 'start', description: 'Lihat daftar model' },
        { command: 'reset', description: 'Reset riwayat chat' },
        ...apiKeys.map(k => ({ command: k.command, description: k.label.slice(0, 256) }))
    ];
    try {
        await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commands })
        });
    } catch (e) {
        console.error('Sync telegram commands failed:', e.message);
    }
}

async function handleTelegramWebhook(event) {
    try {
        const update = JSON.parse(event.body);
        const message = update.message;
        if (!message || !message.text) return { statusCode: 200, body: 'ok' };

        const chatId = String(message.chat.id);
        const text = message.text.trim();

        const config = await getBotConfig();
        const token = config.telegram_token;
        if (!token) return { statusCode: 200, body: 'ok' };

        const apiKeys = await getActiveApiKeys();

        if (text === '/start') {
            if (apiKeys.length === 0) {
                await sendTelegramMessage(token, chatId, 'Belum ada model dikonfigurasi. Hubungi admin.');
                return { statusCode: 200, body: 'ok' };
            }
            const list = apiKeys.map(k => `/${k.command} - ${k.label}`).join('\n');
            await sendTelegramMessage(token, chatId, `Halo. Pilih model:\n\n${list}\n\nAtau langsung tanya, saya pakai model default.`);
            return { statusCode: 200, body: 'ok' };
        }

        if (text === '/reset') {
            const session = await getSession('telegram', chatId);
            await saveSession('telegram', chatId, [], session.active_provider_id);
            await sendTelegramMessage(token, chatId, 'Riwayat chat direset.');
            return { statusCode: 200, body: 'ok' };
        }

        if (text.startsWith('/')) {
            if (!config.allow_model_switch) {
                await sendTelegramMessage(token, chatId, 'Ganti model dinonaktifkan admin.');
                return { statusCode: 200, body: 'ok' };
            }
            const cmd = text.slice(1).toLowerCase();
            const matched = apiKeys.find(k => k.command.toLowerCase() === cmd);
            if (matched) {
                const session = await getSession('telegram', chatId);
                await saveSession('telegram', chatId, session.messages, matched.id);
                await sendTelegramMessage(token, chatId, `Model diganti ke: ${matched.label}`);
                return { statusCode: 200, body: 'ok' };
            }
            await sendTelegramMessage(token, chatId, 'Command tidak dikenal. Kirim /start untuk lihat pilihan.');
            return { statusCode: 200, body: 'ok' };
        }

        const session = await getSession('telegram', chatId);
        const activeKey = pickActiveKey(apiKeys, session, config);
        if (!activeKey) {
            await sendTelegramMessage(token, chatId, 'Belum ada model aktif. Hubungi admin.');
            return { statusCode: 200, body: 'ok' };
        }

        try {
            const result = await generateReply(activeKey, text, session);
            if (result.type === 'image') {
                await sendTelegramPhoto(token, chatId, result.data, text);
            } else {
                await saveSession('telegram', chatId, result.updatedMessages, activeKey.id);
                await sendTelegramMessage(token, chatId, result.data);
            }
        } catch (apiError) {
            console.error('Provider error:', apiError.message);
            await sendTelegramMessage(token, chatId, `Maaf, error dari ${activeKey.label}: ${apiError.message}`);
        }

        return { statusCode: 200, body: 'ok' };
    } catch (err) {
        console.error('Telegram handler error:', err.message);
        return { statusCode: 200, body: 'error handled' };
    }
}

// ===================== DISCORD =====================

function verifyDiscordSignature(event, publicKey) {
    const signature = event.headers['x-signature-ed25519'];
    const timestamp = event.headers['x-signature-timestamp'];
    if (!signature || !timestamp || !publicKey) return false;
    try {
        return nacl.sign.detached.verify(
            Buffer.from(timestamp + event.body),
            Buffer.from(signature, 'hex'),
            Buffer.from(publicKey, 'hex')
        );
    } catch (e) {
        return false;
    }
}

async function sendDiscordFollowup(appId, interactionToken, payload, isImage) {
    const url = `https://discord.com/api/v10/webhooks/${appId}/${interactionToken}/messages/@original`;
    if (isImage) {
        const buffer = Buffer.from(payload.data, 'base64');
        const blob = new Blob([buffer], { type: 'image/png' });
        const form = new FormData();
        form.append('payload_json', JSON.stringify({ content: payload.caption || '' }));
        form.append('files[0]', blob, 'generated.png');
        await fetch(url, { method: 'PATCH', body: form });
    } else {
        await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: payload.slice(0, 2000) })
        });
    }
}

async function processDiscordCommand(config, apiKeys, interaction) {
    const userId = String(interaction.member?.user?.id || interaction.user?.id);
    const commandName = interaction.data.name;
    const appId = config.discord_app_id;
    const token = interaction.token;

    try {
        if (commandName === 'reset') {
            const session = await getSession('discord', userId);
            await saveSession('discord', userId, [], session.active_provider_id);
            await sendDiscordFollowup(appId, token, 'Riwayat chat direset.', false);
            return;
        }

        const matched = apiKeys.find(k => k.command === commandName);
        if (!matched) {
            await sendDiscordFollowup(appId, token, 'Model tidak ditemukan.', false);
            return;
        }

        const messageOption = interaction.data.options?.find(o => o.name === 'pesan');
        const userText = messageOption ? messageOption.value : '';

        if (!userText) {
            if (!config.allow_model_switch) {
                await sendDiscordFollowup(appId, token, 'Ganti model dinonaktifkan admin.', false);
                return;
            }
            const session = await getSession('discord', userId);
            await saveSession('discord', userId, session.messages, matched.id);
            await sendDiscordFollowup(appId, token, `Model diganti ke: ${matched.label}`, false);
            return;
        }

        const session = await getSession('discord', userId);
        const result = await generateReply(matched, userText, session);
        if (result.type === 'image') {
            await sendDiscordFollowup(appId, token, { data: result.data, caption: userText }, true);
        } else {
            await saveSession('discord', userId, result.updatedMessages, matched.id);
            await sendDiscordFollowup(appId, token, result.data, false);
        }
    } catch (err) {
        console.error('Discord process error:', err.message);
        await sendDiscordFollowup(appId, token, `Error: ${err.message}`, false).catch(() => {});
    }
}

async function handleDiscordWebhook(event) {
    const config = await getBotConfig();
    if (!verifyDiscordSignature(event, config.discord_public_key)) {
        return { statusCode: 401, body: 'invalid signature' };
    }

    const interaction = JSON.parse(event.body);

    if (interaction.type === 1) {
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 1 }) };
    }

    if (interaction.type === 2) {
        const apiKeys = await getActiveApiKeys();
        processDiscordCommand(config, apiKeys, interaction).catch(e => console.error('Async discord error:', e.message));
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 5 })
        };
    }

    return { statusCode: 200, body: 'ok' };
}

async function syncDiscordCommands(appId, botToken, apiKeys) {
    if (!appId || !botToken) return { ok: false, error: 'App ID atau Bot Token belum diset' };

    const commands = [
        { name: 'reset', description: 'Reset riwayat chat' },
        ...apiKeys.map(k => ({
            name: k.command,
            description: k.label.slice(0, 100),
            options: [{ name: 'pesan', description: 'Pesan atau prompt kamu', type: 3, required: false }]
        }))
    ];

    const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
        method: 'PUT',
        headers: {
            'Authorization': `Bot ${botToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(commands)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.message || 'Gagal sync commands' };
    return { ok: true, count: commands.length };
}

// ===================== ADMIN API =====================

function json(statusCode, body) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function maskKey(key) {
    if (!key || key.length < 8) return '****';
    return key.slice(0, 4) + '...' + key.slice(-4);
}

async function requireAuth(event) {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return false;
    const { data, error } = await supabase
        .from('admin_sessions').select('token, expires_at').eq('token', token).maybeSingle();
    if (error || !data) return false;
    if (new Date(data.expires_at) < new Date()) return false;
    return true;
}

async function handleLogin(body) {
    const { password } = body;
    if (!password) return json(400, { error: 'Password wajib diisi' });

    let config = await getBotConfig().catch(() => null);
    if (!config) return json(500, { error: 'Bot config tidak ditemukan, jalankan schema.sql dulu' });

    if (!config.admin_password_hash) {
        const hash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
        await supabase.from('bot_config').update({ admin_password_hash: hash }).eq('id', 1);
        config.admin_password_hash = hash;
    }

    const valid = await bcrypt.compare(password, config.admin_password_hash);
    if (!valid) return json(401, { error: 'Password salah' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
    await supabase.from('admin_sessions').insert({ token, expires_at: expiresAt });
    return json(200, { token, expires_at: expiresAt });
}

async function handleGetConfig() {
    const config = await getBotConfig();
    const { data: apiKeys } = await supabase.from('api_keys').select('*').order('created_at', { ascending: true });

    return json(200, {
        telegram_token_set: !!config.telegram_token,
        telegram_token_masked: config.telegram_token ? maskKey(config.telegram_token) : null,
        discord_configured: !!(config.discord_bot_token && config.discord_app_id && config.discord_public_key),
        discord_app_id: config.discord_app_id || null,
        allow_model_switch: config.allow_model_switch,
        default_provider_id: config.default_provider_id,
        api_keys: (apiKeys || []).map(k => ({
            id: k.id,
            provider: k.provider,
            label: k.label,
            model_name: k.model_name,
            command: k.command,
            active: k.active,
            output_type: k.output_type || 'text',
            api_key_full: k.api_key
        }))
    });
}

async function registerTelegramWebhook(token) {
    const siteUrl = process.env.URL || process.env.DEPLOY_URL;
    if (!siteUrl) return { ok: false, error: 'Site URL tidak terdeteksi' };
    const webhookUrl = `${siteUrl}/.netlify/functions/index`;
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
    return res.json();
}

async function handleUpdateTelegramToken(body) {
    const { token } = body;
    if (!token) return json(400, { error: 'Token wajib diisi' });
    await supabase.from('bot_config').update({ telegram_token: token }).eq('id', 1);
    const webhookResult = await registerTelegramWebhook(token);
    const apiKeys = await getActiveApiKeys();
    await syncTelegramCommands(token, apiKeys);
    return json(200, { success: true, webhook: webhookResult });
}

async function handleUpdateDiscordConfig(body) {
    const { bot_token, app_id, public_key } = body;
    if (!bot_token || !app_id || !public_key) return json(400, { error: 'Semua field Discord wajib diisi' });

    await supabase.from('bot_config').update({
        discord_bot_token: bot_token, discord_app_id: app_id, discord_public_key: public_key
    }).eq('id', 1);

    const apiKeys = await getActiveApiKeys();
    const syncResult = await syncDiscordCommands(app_id, bot_token, apiKeys);

    const siteUrl = process.env.URL || process.env.DEPLOY_URL;
    return json(200, {
        success: true,
        sync: syncResult,
        interactions_endpoint: `${siteUrl}/.netlify/functions/index`
    });
}

async function handleChangePassword(body) {
    const { new_password } = body;
    if (!new_password || new_password.length < 6) return json(400, { error: 'Password minimal 6 karakter' });
    const hash = await bcrypt.hash(new_password, 10);
    await supabase.from('bot_config').update({ admin_password_hash: hash }).eq('id', 1);
    return json(200, { success: true });
}

async function handleSetDefaultProvider(body) {
    const { id } = body;
    await supabase.from('bot_config').update({ default_provider_id: id || null }).eq('id', 1);
    return json(200, { success: true });
}

async function handleSetAllowSwitch(body) {
    const { allow } = body;
    await supabase.from('bot_config').update({ allow_model_switch: !!allow }).eq('id', 1);
    return json(200, { success: true });
}

async function resyncAllCommands() {
    const config = await getBotConfig();
    const apiKeys = await getActiveApiKeys();
    if (config.telegram_token) await syncTelegramCommands(config.telegram_token, apiKeys);
    if (config.discord_app_id && config.discord_bot_token) {
        await syncDiscordCommands(config.discord_app_id, config.discord_bot_token, apiKeys).catch(() => {});
    }
}

async function handleAddApiKey(body) {
    const { provider, label, api_key, model_name, command, output_type } = body;
    if (!provider || !label || !api_key || !model_name || !command) {
        return json(400, { error: 'Semua field wajib diisi' });
    }
    const cleanCommand = command.replace(/^\//, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!cleanCommand) return json(400, { error: 'Command tidak valid' });

    const { data: existing } = await supabase.from('api_keys').select('id').eq('command', cleanCommand).maybeSingle();
    if (existing) return json(400, { error: `Command /${cleanCommand} sudah dipakai` });

    const { error } = await supabase.from('api_keys').insert({
        provider, label, api_key, model_name, command: cleanCommand,
        output_type: output_type === 'image' ? 'image' : 'text', active: true
    });
    if (error) return json(500, { error: error.message });

    await resyncAllCommands();
    return json(200, { success: true });
}

async function handleUpdateApiKey(body) {
    const { id, ...fields } = body;
    if (!id) return json(400, { error: 'ID wajib diisi' });
    const allowed = ['provider', 'label', 'api_key', 'model_name', 'command', 'active', 'output_type'];
    const updates = {};
    for (const key of allowed) if (fields[key] !== undefined) updates[key] = fields[key];

    const { error } = await supabase.from('api_keys').update(updates).eq('id', id);
    if (error) return json(500, { error: error.message });

    await resyncAllCommands();
    return json(200, { success: true });
}

async function handleDeleteApiKey(body) {
    const { id } = body;
    if (!id) return json(400, { error: 'ID wajib diisi' });
    const { error } = await supabase.from('api_keys').delete().eq('id', id);
    if (error) return json(500, { error: error.message });

    await resyncAllCommands();
    return json(200, { success: true });
}

async function handleAdminApi(event, action) {
    let body = {};
    try {
        body = event.body ? JSON.parse(event.body) : {};
    } catch (e) {
        return json(400, { error: 'Body tidak valid' });
    }

    if (action === 'login') return handleLogin(body);

    const authed = await requireAuth(event);
    if (!authed) return json(401, { error: 'Sesi tidak valid, silakan login ulang' });

    switch (action) {
        case 'get_config': return handleGetConfig();
        case 'update_telegram_token': return handleUpdateTelegramToken(body);
        case 'update_discord_config': return handleUpdateDiscordConfig(body);
        case 'change_password': return handleChangePassword(body);
        case 'set_default_provider': return handleSetDefaultProvider(body);
        case 'set_allow_switch': return handleSetAllowSwitch(body);
        case 'add_api_key': return handleAddApiKey(body);
        case 'update_api_key': return handleUpdateApiKey(body);
        case 'delete_api_key': return handleDeleteApiKey(body);
        default: return json(400, { error: 'Action tidak dikenal' });
    }
}

// ===================== ROUTER =====================

exports.handler = async (event) => {
    const action = event.queryStringParameters?.action;
    if (action) return handleAdminApi(event, action);

    if (event.httpMethod !== 'POST') return { statusCode: 200, body: 'Bot webhook active' };

    const isDiscord = event.headers['x-signature-ed25519'] !== undefined;
    if (isDiscord) return handleDiscordWebhook(event);

    return handleTelegramWebhook(event);
};
