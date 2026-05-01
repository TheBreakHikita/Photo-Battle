require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public')); 

// Берем секреты из переменных окружения (ENV)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "superadmin123";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Подключаемся к базе данных
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Отдаем данные зрителям
app.get('/api/data', async (req, res) => {
    const { data, error } = await supabase
        .from('battle_data')
        .select('*')
        .eq('id', 1)
        .single();
    
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// Сохраняем данные из админки
app.post('/api/save', async (req, res) => {
    const { password, newData } = req.body;

    if (password !== ADMIN_PASSWORD) {
        return res.status(403).json({ error: "Неверный пароль!" });
    }

    // Обновляем строку в базе данных
    const { error } = await supabase
        .from('battle_data')
        .update({
            photo1: newData.photo1,
            photo2: newData.photo2,
            postLink: newData.postLink,
            timer: newData.timer,
            winners: newData.winners
        })
        .eq('id', 1);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));