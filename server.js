const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
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

// Сохранить новое состояние (из админки)
app.post('/api/state', async (req, res) => {
    const { password, newState } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Неверный пароль" });

    const { error } = await supabase.from('app_state').update({ data: newState }).eq('id', 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));