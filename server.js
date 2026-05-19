require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BHI3mBbx5toiBbhVK7u8nI_bMgqsnHQtLBLcJe-SSMvk6GjrBTZJnDFP6Hj7AXUOBa4Y-wINSOiFOcuY7eTuKzI';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'cH5Aym2Hrkmz0OqHIouTaponQyPG8h19WA9RazfzhmY';

webpush.setVapidDetails(
    'mailto:support@prodigy-chat.ci',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 25 * 1024 * 1024 // Limite à 25 Mo pour supporter les fichiers encodés en base64 de 15 Mo
});

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_prodigy_key_2026';

// Middleware
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1d', // Cacher les ressources statiques pendant 1 jour pour un chargement instantané
    etag: true
}));

// Database Setup (Turso / libSQL)
const dbUrl = process.env.TURSO_DATABASE_URL || 'file:./chat.db';
const db = createClient({
    url: dbUrl,
    authToken: process.env.TURSO_AUTH_TOKEN
});

async function initDb() {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            status TEXT DEFAULT 'offline',
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        await db.execute(`CREATE TABLE IF NOT EXISTS rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            type TEXT DEFAULT 'public'
        )`);

        await db.execute(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER,
            sender_id INTEGER,
            content TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(room_id) REFERENCES rooms(id),
            FOREIGN KEY(sender_id) REFERENCES users(id)
        )`);
        
        // Insert default room
        await db.execute(`INSERT OR IGNORE INTO rooms (id, name, type) VALUES (1, 'Général', 'public')`);
        
        try { await db.execute(`ALTER TABLE rooms ADD COLUMN creator_id INTEGER`); } catch(e){}
        try { await db.execute(`ALTER TABLE rooms ADD COLUMN is_locked INTEGER DEFAULT 0`); } catch(e){}
        try { await db.execute(`ALTER TABLE messages ADD COLUMN reply_to_id INTEGER`); } catch(e){}
        try { await db.execute(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`); } catch(e){}

        await db.execute(`CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            category TEXT,
            title TEXT,
            description TEXT,
            status TEXT DEFAULT 'pending',
            admin_note TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )`);

        await db.execute(`CREATE TABLE IF NOT EXISTS room_members (
            room_id INTEGER,
            user_id INTEGER,
            PRIMARY KEY(room_id, user_id),
            FOREIGN KEY(room_id) REFERENCES rooms(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        )`);

        await db.execute(`CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            subscription TEXT UNIQUE,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )`);

        // Nettoyage périodique automatique toutes les 10 minutes des messages et fichiers vieux de plus de 24 heures (GMT / Côte d'Ivoire)
        setInterval(async () => {
            try {
                const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
                
                // 1. Récupérer les messages qui vont être supprimés pour repérer leurs fichiers physiques
                const filesToClean = await db.execute({
                    sql: `SELECT content FROM messages WHERE timestamp < ?`,
                    args: [twentyFourHoursAgo]
                });
                
                // 2. Supprimer les messages de la base de données
                const res = await db.execute({
                    sql: `DELETE FROM messages WHERE timestamp < ?`,
                    args: [twentyFourHoursAgo]
                });
                
                if (res.rowsAffected > 0) {
                    console.log(`[Nettoyage 24h] ${res.rowsAffected} message(s) supprimé(s).`);
                    io.emit('messages_cleaned');
                }
                
                // 3. Supprimer les fichiers physiques associés du disque dur
                const fs = require('fs');
                filesToClean.rows.forEach(row => {
                    const content = row.content;
                    if (content && (content.startsWith('[FILE]:') || content.startsWith('[AUDIO]:') || content.startsWith('[STICKER]:'))) {
                        const isSticker = content.startsWith('[STICKER]:');
                        const prefix = isSticker ? '[STICKER]:' : (content.startsWith('[FILE]:') ? '[FILE]:' : '[AUDIO]:');
                        let relativeUrl = '';
                        if (isSticker) {
                            relativeUrl = content.substring(prefix.length);
                        } else {
                            const parts = content.substring(prefix.length).split('|');
                            relativeUrl = parts[parts.length - 1];
                        }
                        
                        if (relativeUrl && relativeUrl.startsWith('/uploads/')) {
                            const fileName = relativeUrl.substring(9);
                            const filePath = path.join(__dirname, 'public', 'uploads', fileName);
                            if (fs.existsSync(filePath)) {
                                try {
                                    fs.unlinkSync(filePath);
                                    console.log(`[Nettoyage Fichiers] Fichier expiré supprimé (>24h Côte d'Ivoire) : ${fileName}`);
                                } catch (e) {}
                            }
                        }
                    }
                });
            } catch(e) {
                console.error("Erreur lors du nettoyage périodique :", e);
            }
        }, 10 * 60 * 1000);

        // S'assurer du répertoire d'uploads
        const fs = require('fs');
        const uploadsDir = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }

        console.log('Connecté à la base de données (Turso/SQLite).');
    } catch (err) {
        console.error("Erreur d'initialisation DB:", err);
    }
}
initDb();

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Accès refusé' });
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token invalide' });
        req.user = user;
        next();
    });
}

// Auth Routes
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Nom d'utilisateur et mot de passe requis." });

    const role = (username.toLowerCase() === 'admin') ? 'admin' : 'user';
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await db.execute({
            sql: `INSERT INTO users (username, password, role) VALUES (?, ?, ?)`,
            args: [username, hashedPassword, role]
        });
        
        const userId = Number(result.lastInsertRowid);
        res.status(201).json({ message: 'Compte créé avec succès.', userId });
    } catch (error) {
        if (error.message && error.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: "Ce nom d'utilisateur existe déjà." });
        }
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.execute({
            sql: `SELECT * FROM users WHERE username = ?`,
            args: [username]
        });
        
        const user = result.rows[0];
        if (!user) return res.status(401).json({ error: 'Identifiants incorrects.' });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Identifiants incorrects.' });

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role || 'user' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, user: { id: user.id, username: user.username, role: user.role || 'user' } });
    } catch (error) {
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

app.get('/api/users', async (req, res) => {
    try {
        const result = await db.execute(`SELECT id, username, status, last_seen, role FROM users`);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

// --- WEB PUSH SUBSCRIPTIONS ---
app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: "Abonnement manquant" });

    try {
        await db.execute({
            sql: `INSERT OR REPLACE INTO push_subscriptions (user_id, subscription) VALUES (?, ?)`,
            args: [req.user.id, JSON.stringify(subscription)]
        });
        res.status(201).json({ success: true, message: "Abonnement push enregistré." });
    } catch(e) {
        console.error("Erreur lors de l'enregistrement de l'abonnement push:", e);
        res.status(500).json({ error: "Erreur serveur." });
    }
});

// --- SUPPORT TICKETS & ADMIN API ---

// Support tickets endpoint
app.get('/api/tickets', authenticateToken, async (req, res) => {
    try {
        let result;
        if (req.user.role === 'admin') {
            // Admin receives ALL complaints with details of the submitter
            result = await db.execute(`
                SELECT t.*, u.username 
                FROM tickets t 
                JOIN users u ON t.user_id = u.id 
                ORDER BY t.id DESC
            `);
        } else {
            // Standard user receives only their own complaints
            result = await db.execute({
                sql: `SELECT * FROM tickets WHERE user_id = ? ORDER BY id DESC`,
                args: [req.user.id]
            });
        }
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

app.post('/api/tickets', authenticateToken, async (req, res) => {
    const { category, title, description } = req.body;
    if (!category || !title || !description) {
        return res.status(400).json({ error: "Tous les champs sont requis." });
    }
    
    try {
        const result = await db.execute({
            sql: `INSERT INTO tickets (user_id, category, title, description) VALUES (?, ?, ?, ?)`,
            args: [req.user.id, category, title, description]
        });
        const ticketId = Number(result.lastInsertRowid);
        
        // Notify admin sockets about the new ticket if possible
        io.emit('new_ticket', { id: ticketId, category, title, description, user_id: req.user.id, username: req.user.username });
        
        res.status(201).json({ success: true, message: "Plainte enregistrée avec succès.", id: ticketId });
    } catch (error) {
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

// Admin Action: Resolve / respond to ticket
app.post('/api/tickets/:id/resolve', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: "Accès refusé. Admin uniquement." });
    const ticketId = Number(req.params.id);
    const { admin_note, status } = req.body; // status can be resolved or open
    const finalStatus = status || 'resolved';

    try {
        await db.execute({
            sql: `UPDATE tickets SET status = ?, admin_note = ? WHERE id = ?`,
            args: [finalStatus, admin_note || '', ticketId]
        });
        
        // Notify the specific ticket owner
        const ticketRes = await db.execute({
            sql: `SELECT user_id FROM tickets WHERE id = ?`,
            args: [ticketId]
        });
        
        if (ticketRes.rows.length > 0) {
            const userId = Number(ticketRes.rows[0].user_id);
            const sockets = await io.fetchSockets();
            for (const s of sockets) {
                if (s.user && Number(s.user.id) === userId) {
                    s.emit('ticket_updated', { id: ticketId, status: finalStatus, admin_note });
                }
            }
        }
        
        res.json({ success: true, message: "Ticket mis à jour avec succès." });
    } catch (error) {
        res.status(500).json({ error: "Erreur serveur." });
    }
});

// Admin Action: View all users list
app.get('/api/admin/users', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: "Accès refusé. Admin uniquement." });
    try {
        const result = await db.execute(`SELECT id, username, role, status FROM users ORDER BY username ASC`);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: "Erreur serveur." });
    }
});

// Admin Action: Change user role
app.post('/api/admin/users/:id/role', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: "Accès refusé. Admin uniquement." });
    const targetUserId = Number(req.params.id);
    const { role } = req.body;
    if (role !== 'user' && role !== 'admin') return res.status(400).json({ error: "Rôle invalide." });
    
    // Prevent admin from removing their own admin status
    if (targetUserId === req.user.id) return res.status(400).json({ error: "Vous ne pouvez pas modifier votre propre rôle." });

    try {
        await db.execute({
            sql: `UPDATE users SET role = ? WHERE id = ?`,
            args: [role, targetUserId]
        });
        
        // Notify the target user to re-authenticate or refresh their UI
        const sockets = await io.fetchSockets();
        for (const s of sockets) {
            if (s.user && Number(s.user.id) === targetUserId) {
                s.emit('role_changed', { role });
            }
        }
        
        res.json({ success: true, message: `Rôle mis à jour avec succès.` });
    } catch (error) {
        res.status(500).json({ error: "Erreur serveur." });
    }
});

// Admin Action: Delete/Ban User
app.delete('/api/admin/users/:id', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: "Accès refusé. Admin uniquement." });
    const targetUserId = Number(req.params.id);
    
    if (targetUserId === req.user.id) return res.status(400).json({ error: "Vous ne pouvez pas supprimer votre propre compte." });

    try {
        // Delete user's messages, room_members, and user entry
        await db.execute({ sql: `DELETE FROM messages WHERE sender_id = ?`, args: [targetUserId] });
        await db.execute({ sql: `DELETE FROM room_members WHERE user_id = ?`, args: [targetUserId] });
        await db.execute({ sql: `DELETE FROM tickets WHERE user_id = ?`, args: [targetUserId] });
        await db.execute({ sql: `DELETE FROM users WHERE id = ?`, args: [targetUserId] });
        
        // Disconnect and log out target user sockets
        const sockets = await io.fetchSockets();
        for (const s of sockets) {
            if (s.user && Number(s.user.id) === targetUserId) {
                s.emit('user_banned');
                s.disconnect(true);
            }
        }
        
        io.emit('user_status_change', { userId: targetUserId, status: 'offline' });
        res.json({ success: true, message: "Compte utilisateur supprimé avec succès." });
    } catch (error) {
        res.status(500).json({ error: "Erreur serveur." });
    }
});

// Admin/Creator Action: Delete Message
app.delete('/api/messages/:id', authenticateToken, async (req, res) => {
    const msgId = Number(req.params.id);
    try {
        const msgRes = await db.execute({
            sql: `SELECT * FROM messages WHERE id = ?`,
            args: [msgId]
        });
        const msg = msgRes.rows[0];
        if (!msg) return res.status(404).json({ error: "Message introuvable" });

        // Allowed ONLY if user is admin
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: "Action non autorisée. Seuls les administrateurs peuvent supprimer les messages." });
        }

        // Delete from database
        await db.execute({
            sql: `DELETE FROM messages WHERE id = ?`,
            args: [msgId]
        });

        // Notify client sockets about message deletion in real-time
        io.emit('message_deleted', { id: msgId, roomId: msg.room_id });
        res.json({ success: true, message: "Message supprimé avec succès." });
    } catch (error) {
        res.status(500).json({ error: "Erreur serveur." });
    }
});

// Admin/Creator Action: Delete Room
app.delete('/api/rooms/:id', authenticateToken, async (req, res) => {
    const roomId = Number(req.params.id);
    if (roomId === 1) return res.status(400).json({ error: "Impossible de supprimer le canal Général." });

    try {
        const roomRes = await db.execute({
            sql: `SELECT * FROM rooms WHERE id = ?`,
            args: [roomId]
        });
        const room = roomRes.rows[0];
        if (!room) return res.status(404).json({ error: "Canal introuvable" });

        // Allowed if user is admin OR if user is the creator of the room
        if (req.user.role !== 'admin' && Number(room.creator_id) !== Number(req.user.id)) {
            return res.status(403).json({ error: "Action non autorisée." });
        }

        // Delete all messages in the room
        await db.execute({ sql: `DELETE FROM messages WHERE room_id = ?`, args: [roomId] });
        await db.execute({ sql: `DELETE FROM room_members WHERE room_id = ?`, args: [roomId] });
        await db.execute({ sql: `DELETE FROM rooms WHERE id = ?`, args: [roomId] });

        // Notify client sockets in real-time
        io.emit('room_deleted', { roomId });
        res.json({ success: true, message: "Canal supprimé avec succès." });
    } catch (error) {
        res.status(500).json({ error: "Erreur serveur." });
    }
});

app.get('/api/rooms', async (req, res) => {
    try {
        const result = await db.execute(`SELECT * FROM rooms`);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

app.post('/api/rooms', authenticateToken, async (req, res) => {
    const { name, is_locked } = req.body;
    if (!name) return res.status(400).json({ error: "Nom du canal requis." });

    const lockedVal = is_locked ? 1 : 0;
    try {
        const result = await db.execute({
            sql: `INSERT INTO rooms (name, type, creator_id, is_locked) VALUES (?, 'public', ?, ?)`,
            args: [name, req.user.id, lockedVal]
        });
        const roomId = Number(result.lastInsertRowid);
        const roomData = { id: roomId, name, type: 'public', creator_id: req.user.id, is_locked: lockedVal };
        io.emit('room_created', roomData);
        res.status(201).json(roomData);
    } catch (error) {
        if (error.message && error.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: "Ce canal existe déjà." });
        }
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

app.post('/api/rooms/:id/toggle_lock', authenticateToken, async (req, res) => {
    const roomId = Number(req.params.id);
    try {
        const roomRes = await db.execute({
            sql: `SELECT * FROM rooms WHERE id = ?`,
            args: [roomId]
        });
        const room = roomRes.rows[0];
        if (!room) return res.status(404).json({ error: "Canal introuvable" });
        if (room.creator_id !== req.user.id) return res.status(403).json({ error: "Seul le créateur peut verrouiller ce canal" });

        const newLock = room.is_locked === 1 ? 0 : 1;
        await db.execute({
            sql: `UPDATE rooms SET is_locked = ? WHERE id = ?`,
            args: [newLock, roomId]
        });
        io.emit('room_updated', { id: roomId, is_locked: newLock });
        res.json({ success: true, is_locked: newLock });
    } catch(e) {
        res.status(500).json({ error: "Erreur serveur" });
    }
});

app.post('/api/rooms/:id/invite', authenticateToken, async (req, res) => {
    const roomId = Number(req.params.id);
    const { username } = req.body;
    try {
        const roomRes = await db.execute({
            sql: `SELECT * FROM rooms WHERE id = ?`,
            args: [roomId]
        });
        const room = roomRes.rows[0];
        if (!room) return res.status(404).json({ error: "Canal introuvable" });
        if (room.creator_id !== req.user.id) return res.status(403).json({ error: "Seul le créateur peut inviter des membres" });

        const userRes = await db.execute({
            sql: `SELECT * FROM users WHERE username = ?`,
            args: [username]
        });
        const targetUser = userRes.rows[0];
        if (!targetUser) return res.status(404).json({ error: "Utilisateur introuvable" });

        await db.execute({
            sql: `INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)`,
            args: [roomId, targetUser.id]
        });
        
        io.emit('user_invited', { roomId, roomName: room.name, userId: targetUser.id });
        res.json({ success: true, message: `${username} a été invité avec succès.` });
    } catch(e) {
        res.status(500).json({ error: "Erreur serveur" });
    }
});

// Authentication middleware for sockets
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error'));
    
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error('Authentication error'));
        socket.user = decoded;
        next();
    });
});

const onlineUsers = new Map();

io.on('connection', async (socket) => {
    const userId = socket.user.id;
    onlineUsers.set(userId, socket.id);

    try {
        await db.execute({
            sql: `UPDATE users SET status = 'online' WHERE id = ?`,
            args: [userId]
        });
        io.emit('user_status_change', { userId, status: 'online' });

    } catch (e) {
        console.error(e);
    }

    socket.on('send_message', async (data) => {
        const roomId = Number(data.roomId);
        let { content } = data;
        
        // Optimiser l'extraction des données Base64 (Fichiers, Audio, Stickers personnalisés) vers le disque
        if (content && (content.startsWith('[FILE]:') || content.startsWith('[AUDIO]:') || content.startsWith('[STICKER]:'))) {
            try {
                const isAudio = content.startsWith('[AUDIO]:');
                const isSticker = content.startsWith('[STICKER]:');
                const isFile = content.startsWith('[FILE]:');
                
                let base64Data = '';
                let prefix = '';
                
                if (isSticker) {
                    prefix = '[STICKER]:';
                    base64Data = content.substring(prefix.length);
                } else if (isAudio) {
                    prefix = '[AUDIO]:';
                    const parts = content.substring(prefix.length).split('|');
                    base64Data = parts[3];
                } else if (isFile) {
                    prefix = '[FILE]:';
                    const parts = content.substring(prefix.length).split('|');
                    base64Data = parts[2];
                }
                
                if (base64Data && base64Data.startsWith('data:')) {
                    const match = base64Data.match(/^data:([^;]+);base64,(.+)$/);
                    if (match) {
                        const fileType = match[1];
                        const rawBase64 = match[2];
                        const buffer = Buffer.from(rawBase64, 'base64');
                        
                        const fs = require('fs');
                        const uploadsDir = path.join(__dirname, 'public', 'uploads');
                        if (!fs.existsSync(uploadsDir)) {
                            fs.mkdirSync(uploadsDir, { recursive: true });
                        }
                        
                        // Déterminer l'extension
                        let ext = '.bin';
                        if (fileType.includes('png')) ext = '.png';
                        else if (fileType.includes('gif')) ext = '.gif';
                        else if (fileType.includes('jpeg') || fileType.includes('jpg')) ext = '.jpg';
                        else if (fileType.includes('webp')) ext = '.webp';
                        else if (fileType.includes('webm')) ext = '.webm';
                        else if (fileType.includes('mp4')) ext = '.mp4';
                        else if (fileType.includes('wav')) ext = '.wav';
                        
                        let originalName = 'file';
                        if (isFile || isAudio) {
                            const parts = content.substring(prefix.length).split('|');
                            originalName = parts[0];
                        }
                        const cleanName = originalName.replace(/[^a-zA-Z0-9.-]/g, '_');
                        const uniqueName = Date.now() + '_' + Math.random().toString(36).substring(2, 9) + '_' + cleanName;
                        
                        const filePath = path.join(uploadsDir, uniqueName);
                        fs.writeFileSync(filePath, buffer);
                        
                        const relativeUrl = `/uploads/${uniqueName}`;
                        
                        if (isSticker) {
                            content = `[STICKER]:${relativeUrl}`;
                        } else if (isAudio) {
                            const parts = content.substring(prefix.length).split('|');
                            content = `[AUDIO]:${parts[0]}|${parts[1]}|${parts[2]}|${relativeUrl}`;
                        } else if (isFile) {
                            const parts = content.substring(prefix.length).split('|');
                            content = `[FILE]:${parts[0]}|${parts[1]}|${relativeUrl}`;
                        }
                    }
                }
            } catch (err) {
                console.error("Erreur d'extraction Base64 sur le serveur :", err);
            }
        }

        let replyToId = data.replyToId || null;
        let replyUsername = null;
        let replyContent = null;
        
        if (replyToId) {
            try {
                const repRes = await db.execute({
                    sql: `SELECT m.content, u.username FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?`,
                    args: [replyToId]
                });
                if (repRes.rows.length > 0) {
                    replyUsername = repRes.rows[0].username;
                    replyContent = repRes.rows[0].content;
                } else {
                    replyToId = null;
                }
            } catch(e) {
                replyToId = null;
            }
        }

        try {
            const roomRes = await db.execute({
                sql: `SELECT is_locked, creator_id FROM rooms WHERE id = ?`,
                args: [roomId]
            });
            const room = roomRes.rows[0];
            if (!room) return;

            const standardTimestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
            const result = await db.execute({
                sql: `INSERT INTO messages (room_id, sender_id, content, timestamp, reply_to_id) VALUES (?, ?, ?, ?, ?)`,
                args: [roomId, userId, content, standardTimestamp, replyToId]
            });
            
            const messageData = {
                id: Number(result.lastInsertRowid),
                room_id: roomId,
                sender_id: userId,
                content,
                timestamp: standardTimestamp,
                username: socket.user.username,
                reply_to_id: replyToId,
                reply_username: replyUsername,
                reply_content: replyContent
            };
            
            if (room.is_locked === 1) {
                // Pour un canal verrouillé, récupérer les membres autorisés
                const membersRes = await db.execute({
                    sql: `SELECT user_id FROM room_members WHERE room_id = ?`,
                    args: [roomId]
                });
                const memberIds = new Set(membersRes.rows.map(row => Number(row.user_id)));
                if (room.creator_id) {
                    memberIds.add(Number(room.creator_id));
                }
                
                // Envoyer uniquement aux sockets des membres autorisés
                const sockets = await io.fetchSockets();
                for (const s of sockets) {
                    if (s.user && memberIds.has(Number(s.user.id))) {
                        s.emit('new_message', messageData);
                    }
                }
            } else {
                // Pour un canal public, diffusion globale
                io.emit('new_message', messageData);
            }

            // Envoyer des notifications Push Web en arrière-plan aux membres hors ligne/inactifs
            try {
                let subsSql = `SELECT user_id, subscription FROM push_subscriptions WHERE user_id != ?`;
                let subsArgs = [userId];
                
                if (room.is_locked === 1) {
                    // Pour les canaux verrouillés, n'envoyer qu'aux membres autorisés
                    const membersRes = await db.execute({
                        sql: `SELECT user_id FROM room_members WHERE room_id = ?`,
                        args: [roomId]
                    });
                    const memberIds = membersRes.rows.map(row => Number(row.user_id));
                    if (room.creator_id) {
                        memberIds.push(Number(room.creator_id));
                    }
                    
                    if (memberIds.length > 0) {
                        const placeholders = memberIds.map(() => '?').join(',');
                        subsSql = `SELECT user_id, subscription FROM push_subscriptions WHERE user_id != ? AND user_id IN (${placeholders})`;
                        subsArgs = [userId, ...memberIds];
                    } else {
                        subsSql = ''; // Aucun autre membre
                    }
                }
                
                if (subsSql) {
                    const subsRes = await db.execute({
                        sql: subsSql,
                        args: subsArgs
                    });
                    
                    for (const row of subsRes.rows) {
                        const subUserId = Number(row.user_id);
                        if (!onlineUsers.has(subUserId)) {
                            const subscription = JSON.parse(row.subscription);
                            let excerpt = content;
                            if (excerpt.startsWith('[FILE]:')) excerpt = "📎 Fichier joint";
                            else if (excerpt.startsWith('[AUDIO]:')) excerpt = "🎤 Message vocal";
                            else if (excerpt.startsWith('[STICKER]:')) excerpt = "🖼️ Sticker";
                            
                            const payload = JSON.stringify({
                                title: `Nouveau message dans #${room.name}`,
                                options: {
                                    body: `${socket.user.username}: ${excerpt}`,
                                    icon: '/favicon.ico',
                                    badge: '/favicon.ico',
                                    tag: `room-${roomId}`,
                                    data: {
                                        roomId: roomId,
                                        roomName: room.name
                                    }
                                }
                            });
                            
                            webpush.sendNotification(subscription, payload).catch(err => {
                                if (err.statusCode === 410 || err.statusCode === 404) {
                                    db.execute({
                                        sql: `DELETE FROM push_subscriptions WHERE subscription = ?`,
                                        args: [row.subscription]
                                    }).catch(() => {});
                                }
                            });
                        }
                    }
                }
            } catch (pushErr) {
                console.error("Erreur lors de l'envoi des notifications push:", pushErr);
            }
        } catch (e) {
            console.error(e);
        }
    });

    socket.on('join_room', async (data) => {
        const roomId = Number(data.roomId);
        
        try {
            const roomRes = await db.execute({
                sql: `SELECT * FROM rooms WHERE id = ?`,
                args: [roomId]
            });
            const room = roomRes.rows[0];
            if (!room) return;

            if (room.is_locked === 1 && room.creator_id !== socket.user.id) {
                const memberRes = await db.execute({
                    sql: `SELECT * FROM room_members WHERE room_id = ? AND user_id = ?`,
                    args: [roomId, socket.user.id]
                });
                if (memberRes.rows.length === 0) {
                    socket.emit('room_access_denied', { roomId, message: "Ce canal est verrouillé et vous n'y êtes pas invité." });
                    return;
                }
            }
        } catch(e) {
            console.error(e);
            return;
        }

        // Leave other rooms starting with room_
        const rooms = Array.from(socket.rooms);
        rooms.forEach(r => {
            if (r.startsWith('room_')) {
                socket.leave(r);
            }
        });
        
        socket.join(`room_${roomId}`);
        
        try {
            const result = await db.execute({
                sql: `
                    SELECT * FROM (
                        SELECT m.*, u.username,
                               rm.content AS reply_content,
                               ru.username AS reply_username
                        FROM messages m 
                        JOIN users u ON m.sender_id = u.id 
                        LEFT JOIN messages rm ON m.reply_to_id = rm.id
                        LEFT JOIN users ru ON rm.sender_id = ru.id
                        WHERE m.room_id = ? 
                        ORDER BY m.id DESC LIMIT 50
                    ) ORDER BY id ASC
                `,
                args: [roomId]
            });
            socket.emit('chat_history', { roomId, messages: result.rows });
        } catch (e) {
            console.error(e);
        }
    });

    socket.on('typing', (data) => {
        socket.to(`room_${data.roomId}`).emit('user_typing', { username: socket.user.username, roomId: data.roomId });
    });

    socket.on('disconnect', async () => {
        onlineUsers.delete(userId);
        try {
            await db.execute({
                sql: `UPDATE users SET status = 'offline', last_seen = CURRENT_TIMESTAMP WHERE id = ?`,
                args: [userId]
            });
            io.emit('user_status_change', { userId, status: 'offline', last_seen: new Date().toISOString() });
        } catch (e) {
            console.error(e);
        }
    });
});

server.listen(PORT, () => {
    console.log("Serveur en écoute sur le port " + PORT);
});
