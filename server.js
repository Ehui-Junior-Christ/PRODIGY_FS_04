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
const io = new Server(server);

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_prodigy_key_2026';

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
        console.log('Connecté à la base de données (Turso/SQLite).');
    } catch (err) {
        console.error("Erreur d'initialisation DB:", err);
    }
}
initDb();

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

        socket.join('room_1');

        const result = await db.execute({
            sql: `
                SELECT m.*, u.username 
                FROM messages m 
                JOIN users u ON m.sender_id = u.id 
                WHERE m.room_id = 1 
                ORDER BY m.timestamp ASC LIMIT 50
            `,
            args: []
        });
        
        socket.emit('chat_history', { roomId: 1, messages: result.rows });
    } catch (e) {
        console.error(e);
    }

    socket.on('send_message', async (data) => {
        const { roomId, content } = data;
        try {
            const result = await db.execute({
                sql: `INSERT INTO messages (room_id, sender_id, content) VALUES (?, ?, ?)`,
                args: [roomId, userId, content]
            });
            
            const messageData = {
                id: Number(result.lastInsertRowid),
                room_id: roomId,
                sender_id: userId,
                content,
                timestamp: new Date().toISOString(),
                username: socket.user.username
            };
            
            io.to(`room_${roomId}`).emit('new_message', messageData);
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
