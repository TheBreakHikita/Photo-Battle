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
    const { error } = await supabase.from('app_state').update({ data: newState }).eq('id', 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));