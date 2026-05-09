const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const crypto = require('crypto'); // Добавляем криптографию для токенов

const app = express();
const authTokens = new Set(); // Хранилище активных сессий (токенов)
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Получить текущее состояние
app.get('/api/state', async (req, res) => {
    const { data, error } = await supabase.from('app_state').select('data').eq('id', 1).single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data.data);
});

// Учет статистики посещений
app.post('/api/track', async (req, res) => {
    const { page } = req.body;
    if (!page) return res.status(400).json({ error: 'Page is required' });

    try {
        const { data, error } = await supabase.from('app_state').select('data').eq('id', 1).single();
        if (error) throw error;

        let state = data.data;
        if (!state.analytics) state.analytics = { index: 0, bracket: 0, info: 0, total: 0 };

        state.analytics[page] = (state.analytics[page] || 0) + 1;
        state.analytics.total = (state.analytics.total || 0) + 1;

        await supabase.from('app_state').update({ data: state }).eq('id', 1);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- АНОНИМНАЯ ПОЧТА ---
// Отправка письма (публичный доступ)
app.post('/api/mail', async (req, res) => {
    const { name, message, captchaToken } = req.body;
    // Получаем IP пользователя
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!message || message.length > 1000) {
        return res.status(400).json({ error: 'Сообщение не должно быть пустым и превышать 1000 символов' });
    }

    try {
        // Проверка лимита: 1 сообщение в 24 часа с одного IP
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: recentMail } = await supabase
            .from('anonymous_mail')
            .select('id')
            .eq('ip', ip)
            .gte('created_at', yesterday);

        if (recentMail && recentMail.length > 0) {
            return res.status(429).json({ error: 'Вы уже отправляли сообщение сегодня. Попробуйте завтра!' });
        }

        // Сохранение в БД
        const { error } = await supabase.from('anonymous_mail').insert([
            { name: name || 'Аноним', message: message, ip: ip }
        ]);

        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Получение всех писем (только админ)
app.get('/api/mail', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token || !authTokens.has(token)) return res.status(401).json({ error: "Не авторизован" });

    const { data, error } = await supabase.from('anonymous_mail').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// Удаление одного письма (только админ)
app.delete('/api/mail/:id', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token || !authTokens.has(token)) return res.status(401).json({ error: "Не авторизован" });

    const { error } = await supabase.from('anonymous_mail').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// Удаление всех писем (только админ)
app.delete('/api/mail', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token || !authTokens.has(token)) return res.status(401).json({ error: "Не авторизован" });

    // Удаляем всё, где id не равен null (то есть вообще всё)
    const { error } = await supabase.from('anonymous_mail').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// Авторизация админа
app.post('/api/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        const token = crypto.randomBytes(16).toString('hex');
        authTokens.add(token);
        res.json({ success: true, token });
    } else {
        res.status(403).json({ error: 'Неверный пароль' });
    }
});

// Сохранить новое состояние (из админки)
app.post('/api/state', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token || !authTokens.has(token)) return res.status(401).json({ error: "Не авторизован" });

    const { newState } = req.body;
    
    // Подтягиваем актуальную статистику из базы, чтобы админ случайно не перезаписал (не обнулил) её старыми данными
    const { data: currentState } = await supabase.from('app_state').select('data').eq('id', 1).single();
    if (currentState && currentState.data && currentState.data.analytics) {
        newState.analytics = currentState.data.analytics;
    }

    const { error } = await supabase.from('app_state').update({ data: newState }).eq('id', 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));