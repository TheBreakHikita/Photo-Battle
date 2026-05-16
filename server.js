const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const crypto = require('crypto'); // Добавляем криптографию для токенов

const app = express();
const authTokens = new Set(); // Хранилище активных сессий (токенов)
const sseClients = new Set(); // Хранилище подключенных клиентов для Realtime
app.use(express.json({ limit: '50mb' })); // Увеличиваем лимит для сохранения картинок
app.use(express.static('public'));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
// --- Server-Sent Events (SSE) Стрим ---
app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
});

// --- Подписка на Supabase Realtime ---
// Бэкенд слушает изменения в БД и рассылает их всем подключенным пользователям
supabase.channel('schema-db-changes')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_state' }, (payload) => {
        const newState = payload.new.data;
        const dataStr = `data: ${JSON.stringify(newState)}\n\n`;
        for (let client of sseClients) {
            client.write(dataStr);
        }
    })
    .subscribe();

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

// --- РЕАКЦИИ ---
// Оптимизированный эндпоинт для пачки реакций (Debounce)
app.post('/api/react-bulk', async (req, res) => {
    const { reactions } = req.body;
    if (!reactions) return res.status(400).json({ error: 'Bad params' });

    try {
        const { data, error } = await supabase.from('app_state').select('data').eq('id', 1).single();
        if (error) throw error;

        let state = data.data;
        if (!state.reactions) state.reactions = {};

        let updated = false;
        for (const key in reactions) {
            const [battleId, participant, reaction] = key.split('|');
            const count = reactions[key];

            if (!state.reactions[battleId]) state.reactions[battleId] = { '1': {}, '2': {} };
            if (!state.reactions[battleId][participant]) state.reactions[battleId][participant] = {};

            state.reactions[battleId][participant][reaction] = (state.reactions[battleId][participant][reaction] || 0) + count;
            updated = true;
        }

        if (updated) {
            await supabase.from('app_state').update({ data: state }).eq('id', 1);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/react', async (req, res) => {
    const { battleId, participant, reaction } = req.body;
    if (!battleId || !participant || !reaction) return res.status(400).json({ error: 'Bad params' });

    try {
        const { data, error } = await supabase.from('app_state').select('data').eq('id', 1).single();
        if (error) throw error;

        let state = data.data;
        if (!state.reactions) state.reactions = {};
        if (!state.reactions[battleId]) state.reactions[battleId] = { '1': {}, '2': {} };
        if (!state.reactions[battleId][participant]) state.reactions[battleId][participant] = {};
        
        state.reactions[battleId][participant][reaction] = (state.reactions[battleId][participant][reaction] || 0) + 1;

        await supabase.from('app_state').update({ data: state }).eq('id', 1);
        res.json({ success: true, count: state.reactions[battleId][participant][reaction] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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
    if (currentState && currentState.data) {
        if (currentState.data.analytics) newState.analytics = currentState.data.analytics;
        if (currentState.data.reactions) {
            if (newState.reactions && Object.keys(newState.reactions).length === 0) {
                // Админ сбросил турнир (очищаем реакции полностью)
                newState.reactions = {};
            } else {
                // Оставляем только те реакции из базы, ключи которых всё ещё присутствуют в newState от админа.
                // Это позволяет админу удалять реакции конкретного боя, не теряя свежие клики в остальных боях.
                const mergedReactions = {};
                for (let key in currentState.data.reactions) {
                    if (newState.reactions[key]) {
                        mergedReactions[key] = currentState.data.reactions[key];
                    }
                }
                newState.reactions = mergedReactions;
            }
        }
    }

    const { error } = await supabase.from('app_state').update({ data: newState }).eq('id', 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));