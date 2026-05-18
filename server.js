const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3001;
const JWT_SECRET = 'super_secret_prodigy_key_2026';

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database Setup
const db = new sqlite3.Database('./chat.db', (err) => {
    if (err) console.error('Erreur de connexion à la base de données:', err.message);
    else console.log('Connecté à la base de données SQLite.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        status TEXT DEFAULT 'offline',
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        type TEXT DEFAULT 'public' -- 'public' ou 'private'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER,
        sender_id INTEGER,
        content TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(room_id) REFERENCES rooms(id),
        FOREIGN KEY(sender_id) REFERENCES users(id)
    )`);
    
    // Insert default room
    db.run(`INSERT OR IGNORE INTO rooms (id, name, type) VALUES (1, 'Général', 'public')`);
});

// Auth Routes
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Nom d'utilisateur et mot de passe requis." });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, hashedPassword], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(400).json({ error: "Ce nom d'utilisateur existe déjà." });
                }
                return res.status(500).json({ error: 'Erreur serveur.' });
            }
            res.status(201).json({ message: 'Compte créé avec succès.', userId: this.lastID });
        });
    } catch (error) {
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Erreur serveur.' });
        if (!user) return res.status(401).json({ error: 'Identifiants incorrects.' });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Identifiants incorrects.' });

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, user: { id: user.id, username: user.username } });
    });
});

app.get('/api/users', (req, res) => {
    db.all(`SELECT id, username, status, last_seen FROM users`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Erreur serveur.' });
        res.json(rows);
    });
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

io.on('connection', (socket) => {
    const userId = socket.user.id;
    onlineUsers.set(userId, socket.id);

    // Update status to online
    db.run(`UPDATE users SET status = 'online' WHERE id = ?`, [userId]);
    io.emit('user_status_change', { userId, status: 'online' });

    // Join general room by default
    socket.join('room_1');

    // Send history for general room
    db.all(`
        SELECT m.*, u.username 
        FROM messages m 
        JOIN users u ON m.sender_id = u.id 
        WHERE m.room_id = 1 
        ORDER BY m.timestamp ASC LIMIT 50
    `, [], (err, rows) => {
        if (!err) socket.emit('chat_history', { roomId: 1, messages: rows });
    });

    socket.on('send_message', (data) => {
        const { roomId, content } = data;
        db.run(`INSERT INTO messages (room_id, sender_id, content) VALUES (?, ?, ?)`, [roomId, userId, content], function(err) {
            if (err) return console.error(err);
            
            const messageData = {
                id: this.lastID,
                room_id: roomId,
                sender_id: userId,
                content,
                timestamp: new Date().toISOString(),
                username: socket.user.username
            };
            
            io.to(`room_${roomId}`).emit('new_message', messageData);
        });
    });

    socket.on('typing', (data) => {
        socket.to(`room_${data.roomId}`).emit('user_typing', { username: socket.user.username, roomId: data.roomId });
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(userId);
        db.run(`UPDATE users SET status = 'offline', last_seen = CURRENT_TIMESTAMP WHERE id = ?`, [userId]);
        io.emit('user_status_change', { userId, status: 'offline', last_seen: new Date().toISOString() });
    });
});

server.listen(PORT, () => {
    console.log("Serveur en écoute sur le port " + PORT);
});
