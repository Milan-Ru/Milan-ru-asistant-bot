const { createClient } = require('@supabase/supabase-js');
const nacl = require('tweetnacl');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, ...extraHeaders },
        body: JSON.stringify({ model, messages: messages.map(m => ({ role: m.role, content: m.content })) })
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
            'HTTP-Referer': 'https://netlify.app', 'X-Title': 'AI Bot'
        });
        default: throw new Error(`Provider tidak dikenal: ${provider}`);
    }
}

// ===================== SHARED HELPERS =====================

async function getBotConfig() {
    const { data, error } = await supabase.from('bot_config').select('*').eq('id', 1).maybeSingle();
    if (error || !data) throw new Error('Bot config tidak ditemukan');
    return data;
}

async function getActiveApiKeys() {
    const { data, error } = await supabase.from('api_keys').select('*').eq('active', true).order('created_at', { ascending: true });
    if (error) throw new Error('Gagal ambil api_keys: ' + error.message);
    return data || [];
}

async function getAllApiKeys() {
    const { data, error } = await supabase.from('api_keys').select('*').order('created_at', { ascending: true });
    if (error) throw new Error('Gagal ambil api_keys: ' + error.message);
    return data || [];
}

async function getSession(platform, userId) {
    const { data, error } = await supabase.from('sessions').select('messages, active_provider_id')
        .eq('platform', platform).eq('user_id', userId).maybeSingle();
    if (error) { console.error('Get session error:', error.message); return { messages: [], active_provider_id: null }; }
    return data || { messages: [], active_provider_id: null };
}

async function saveSession(platform, userId, messages, activeProviderId) {
    const { error } = await supabase.from('sessions').upsert({
        platform, user_id: userId, messages, active_provider_id: activeProviderId, updated_at: new Date().toISOString()
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

// ===================== TELEGRAM SEND HELPERS =====================

async function sendTelegramMessage(token, chatId, text) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
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
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands })
        });
    } catch (e) { console.error('Sync telegram commands failed:', e.message); }
}

async function registerTelegramWebhook(token, role) {
    const siteUrl = process.env.URL || process.env.DEPLOY_URL;
    if (!siteUrl) return { ok: false, error: 'Site URL tidak terdeteksi' };
    const webhookUrl = `${siteUrl}/.netlify/functions/index?role=${role}`;
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
    return res.json();
}

async function resyncAllCommands() {
    const config = await getBotConfig();
    const apiKeys = await getActiveApiKeys();
    if (config.telegram_token) await syncTelegramCommands(config.telegram_token, apiKeys);
    if (config.discord_app_id && config.discord_bot_token) {
        await syncDiscordCommands(config.discord_app_id, config.discord_bot_token, apiKeys).catch(() => {});
    }
}

// ===================== USER BOT (Bot A) =====================

async function handleUserTelegramWebhook(event) {
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
        console.error('User bot handler error:', err.message);
        return { statusCode: 200, body: 'error handled' };
    }
}

// ===================== ADMIN BOT (Bot B) =====================

function parseMultilineFields(text) {
    const lines = text.split('\n').slice(1);
    const fields = {};
    for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (key) fields[key] = value;
    }
    return fields;
}

const ADMIN_HELP = `Command admin:

/status - Lihat status bot
/listmodel - Daftar semua model
/togglemodel <command> - Aktif/nonaktifkan model
/removemodel <command> - Hapus model
/setdefault <command> - Set model default
/allowswitch on/off - Izinkan user ganti model

/addmodel (multiline)
provider: gemini
command: gemini
label: Gemini Flash
model: gemini-2.0-flash
apikey: xxxxx
output: text

/settoken <token_bot_user>

/setdiscord (multiline)
appid: xxx
bottoken: xxx
publickey: xxx`;

async function processAdminCommand(text, replyFn) {
    const config = await getBotConfig();

    if (text === '/start' || text === '/help') {
        await replyFn(ADMIN_HELP);
        return;
    }

    if (text === '/status') {
        const apiKeys = await getAllApiKeys();
        const activeCount = apiKeys.filter(k => k.active).length;
        const msg = `Status Bot:

User Bot Token: ${config.telegram_token ? 'terpasang' : 'belum diset'}
Discord: ${config.discord_app_id ? 'terkonfigurasi' : 'belum diset'}
Model aktif: ${activeCount}/${apiKeys.length}
Ganti model oleh user: ${config.allow_model_switch ? 'diizinkan' : 'dikunci'}`;
        await replyFn(msg);
        return;
    }

    if (text === '/listmodel') {
        const apiKeys = await getAllApiKeys();
        if (!apiKeys.length) { await replyFn('Belum ada model.'); return; }
        const list = apiKeys.map(k =>
            `/${k.command} - ${k.label} [${k.active ? 'AKTIF' : 'OFF'}] (${k.provider}, ${k.output_type})`
        ).join('\n');
        await replyFn(list);
        return;
    }

    if (text.startsWith('/togglemodel ')) {
        const cmd = text.slice(13).trim().replace(/^\//, '');
        const { data: found } = await supabase.from('api_keys').select('*').eq('command', cmd).maybeSingle();
        if (!found) { await replyFn(`Model /${cmd} tidak ditemukan.`); return; }
        await supabase.from('api_keys').update({ active: !found.active }).eq('id', found.id);
        await resyncAllCommands();
        await replyFn(`Model /${cmd} sekarang ${!found.active ? 'AKTIF' : 'NONAKTIF'}.`);
        return;
    }

    if (text.startsWith('/removemodel ')) {
        const cmd = text.slice(14).trim().replace(/^\//, '');
        const { error } = await supabase.from('api_keys').delete().eq('command', cmd);
        if (error) { await replyFn(`Gagal hapus: ${error.message}`); return; }
        await resyncAllCommands();
        await replyFn(`Model /${cmd} dihapus.`);
        return;
    }

    if (text.startsWith('/setdefault ')) {
        const cmd = text.slice(12).trim().replace(/^\//, '');
        const { data: found } = await supabase.from('api_keys').select('id').eq('command', cmd).maybeSingle();
        if (!found) { await replyFn(`Model /${cmd} tidak ditemukan.`); return; }
        await supabase.from('bot_config').update({ default_provider_id: found.id }).eq('id', 1);
        await replyFn(`Model default diset ke /${cmd}.`);
        return;
    }

    if (text.startsWith('/allowswitch ')) {
        const val = text.slice(13).trim().toLowerCase();
        if (val !== 'on' && val !== 'off') { await replyFn('Gunakan: /allowswitch on atau /allowswitch off'); return; }
        await supabase.from('bot_config').update({ allow_model_switch: val === 'on' }).eq('id', 1);
        await replyFn(`Ganti model oleh user sekarang: ${val === 'on' ? 'diizinkan' : 'dikunci'}.`);
        return;
    }

    if (text.startsWith('/settoken ')) {
        const token = text.slice(10).trim();
        if (!token) { await replyFn('Format: /settoken <token>'); return; }
        await supabase.from('bot_config').update({ telegram_token: token }).eq('id', 1);
        const webhookResult = await registerTelegramWebhook(token, 'user');
        const apiKeys = await getActiveApiKeys();
        await syncTelegramCommands(token, apiKeys);
        await replyFn(`Token user bot disimpan. Webhook: ${webhookResult.ok ? 'berhasil' : 'gagal - ' + JSON.stringify(webhookResult)}`);
        return;
    }

    if (text.startsWith('/addmodel')) {
        const f = parseMultilineFields(text);
        if (!f.provider || !f.command || !f.label || !f.model || !f.apikey) {
            await replyFn('Format tidak lengkap. Kirim /help untuk lihat contoh format /addmodel.');
            return;
        }
        const cleanCommand = f.command.replace(/^\//, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
        const { data: existing } = await supabase.from('api_keys').select('id').eq('command', cleanCommand).maybeSingle();
        if (existing) { await replyFn(`Command /${cleanCommand} sudah dipakai.`); return; }

        const { error } = await supabase.from('api_keys').insert({
            provider: f.provider, label: f.label, api_key: f.apikey, model_name: f.model,
            command: cleanCommand, output_type: f.output === 'image' ? 'image' : 'text', active: true
        });
        if (error) { await replyFn(`Gagal tambah model: ${error.message}`); return; }
        await resyncAllCommands();
        await replyFn(`Model /${cleanCommand} (${f.label}) berhasil ditambahkan.`);
        return;
    }

    if (text.startsWith('/setdiscord')) {
        const f = parseMultilineFields(text);
        if (!f.appid || !f.bottoken || !f.publickey) {
            await replyFn('Format tidak lengkap. Kirim /help untuk lihat contoh format /setdiscord.');
            return;
        }
        await supabase.from('bot_config').update({
            discord_app_id: f.appid, discord_bot_token: f.bottoken, discord_public_key: f.publickey
        }).eq('id', 1);
        const apiKeys = await getActiveApiKeys();
        const syncResult = await syncDiscordCommands(f.appid, f.bottoken, apiKeys);
        const siteUrl = process.env.URL || process.env.DEPLOY_URL;
        await replyFn(`Discord tersimpan. Sync: ${syncResult.ok ? 'berhasil' : 'gagal - ' + syncResult.error}\n\nInteractions Endpoint URL (paste di Discord Developer Portal):\n${siteUrl}/.netlify/functions/index?role=discord`);
        return;
    }

    await replyFn('Command tidak dikenal. Kirim /help untuk lihat daftar command.');
}

async function handleAdminTelegramWebhook(event) {
    try {
        const update = JSON.parse(event.body);
        const message = update.message;
        if (!message || !message.text) return { statusCode: 200, body: 'ok' };

        const fromId = String(message.from.id);
        const chatId = String(message.chat.id);
        const text = message.text.trim();

        if (fromId !== String(ADMIN_TELEGRAM_ID)) {
            await sendTelegramMessage(ADMIN_BOT_TOKEN, chatId, 'Akses ditolak.');
            return { statusCode: 200, body: 'ok' };
        }

        await processAdminCommand(text, (msg) => sendTelegramMessage(ADMIN_BOT_TOKEN, chatId, msg));
        return { statusCode: 200, body: 'ok' };
    } catch (err) {
        console.error('Admin bot handler error:', err.message);
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
            Buffer.from(timestamp + event.body), Buffer.from(signature, 'hex'), Buffer.from(publicKey, 'hex')
        );
    } catch (e) { return false; }
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
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
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
        if (!matched) { await sendDiscordFollowup(appId, token, 'Model tidak ditemukan.', false); return; }

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
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 5 }) };
    }

    return { statusCode: 200, body: 'ok' };
}

async function syncDiscordCommands(appId, botToken, apiKeys) {
    if (!appId || !botToken) return { ok: false, error: 'App ID atau Bot Token belum diset' };
    const commands = [
        { name: 'reset', description: 'Reset riwayat chat' },
        ...apiKeys.map(k => ({
            name: k.command, description: k.label.slice(0, 100),
            options: [{ name: 'pesan', description: 'Pesan atau prompt kamu', type: 3, required: false }]
        }))
    ];
    const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
        method: 'PUT', headers: { 'Authorization': `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(commands)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.message || 'Gagal sync commands' };
    return { ok: true, count: commands.length };
}

// ===================== ROUTER =====================

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 200, body: 'Bot webhook active' };

    const role = event.queryStringParameters?.role;
    const isDiscord = event.headers['x-signature-ed25519'] !== undefined;

    if (isDiscord || role === 'discord') return handleDiscordWebhook(event);
    if (role === 'admin') return handleAdminTelegramWebhook(event);
    return handleUserTelegramWebhook(event);
};
