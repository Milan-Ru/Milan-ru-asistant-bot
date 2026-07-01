const { createClient } = require('@supabase/supabase-js');
const HonchoChat = require('../../honcho.js');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sendTelegramMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text })
    });
}

async function getSession(telegramId) {
    const { data, error } = await supabase
        .from('honcho_sessions')
        .select('messages')
        .eq('telegram_id', telegramId)
        .maybeSingle();

    if (error) {
        console.error('Get session error:', error.message);
        return [];
    }
    return data ? data.messages : [];
}

async function saveSession(telegramId, messages) {
    const { error } = await supabase
        .from('honcho_sessions')
        .upsert({
            telegram_id: telegramId,
            messages: messages,
            updated_at: new Date().toISOString()
        });

    if (error) {
        console.error('Save session error:', error.message);
    }
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 200, body: 'Bot webhook active' };
    }

    try {
        const update = JSON.parse(event.body);
        const message = update.message;

        if (!message || !message.text) {
            return { statusCode: 200, body: 'ok' };
        }

        const chatId = message.chat.id;
        const text = message.text;

        if (text === '/start') {
            await sendTelegramMessage(chatId, 'Halo. Tanya apa aja, saya bantu jawab.');
            return { statusCode: 200, body: 'ok' };
        }

        if (text === '/reset') {
            await saveSession(chatId, []);
            await sendTelegramMessage(chatId, 'Chat history direset.');
            return { statusCode: 200, body: 'ok' };
        }

        const previousMessages = await getSession(chatId);
        const honcho = new HonchoChat(previousMessages);
        const result = await honcho.chat(text);

        if (result.success) {
            await saveSession(chatId, honcho.messages);
            await sendTelegramMessage(chatId, result.data.reply);
        } else {
            await sendTelegramMessage(chatId, 'Maaf, ada error: ' + result.error);
        }

        return { statusCode: 200, body: 'ok' };
    } catch (err) {
        console.error('Handler error:', err.message);
        return { statusCode: 200, body: 'error handled' };
    }
};
