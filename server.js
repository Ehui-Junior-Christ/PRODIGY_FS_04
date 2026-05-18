require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

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

        await db.execute(`CREATE TABLE IF NOT EXISTS room_members (
            room_id INTEGER,
            user_id INTEGER,
            PRIMARY KEY(room_id, user_id),
            FOREIGN KEY(room_id) REFERENCES rooms(id),
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

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await db.execute({
            sql: `INSERT INTO users (username, password) VALUES (?, ?)`,
            args: [username, hashedPassword]
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

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, user: { id: user.id, username: user.username } });
    } catch (error) {
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

app.get('/api/users', async (req, res) => {
    try {
        const result = await db.execute(`SELECT id, username, status, last_seen FROM users`);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Erreur serveur.' });
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
