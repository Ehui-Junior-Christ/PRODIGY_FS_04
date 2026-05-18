document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const authContainer = document.getElementById('auth-container');
    const appContainer = document.getElementById('app-container');
    const authForm = document.getElementById('auth-form');
    const tabs = document.querySelectorAll('.tab');
    const authError = document.getElementById('auth-error');
    const authSubmit = document.getElementById('auth-submit');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const logoutBtn = document.getElementById('logout-btn');
    
    const messagesContainer = document.getElementById('messages-container');
    const messageForm = document.getElementById('message-form');
    const messageInput = document.getElementById('message-input');
    const attachBtn = document.getElementById('attach-btn');
    const fileInput = document.getElementById('file-input');
    const typingIndicator = document.getElementById('typing-indicator');
    
    const usersList = document.getElementById('users-list');
    const onlineCount = document.getElementById('online-count');
    const currentUserAvatar = document.getElementById('current-user-avatar');
    const currentUsername = document.getElementById('current-username');

    // State
    let currentTab = 'login';
    let socket = null;
    let currentUser = null;
    let currentRoomId = 1; // Default General room
    let typingTimeout = null;

    // Check Authentication on load
    const token = localStorage.getItem('prodigy_token');
    const savedUser = localStorage.getItem('prodigy_user');
    
    if (token && savedUser) {
        currentUser = JSON.parse(savedUser);
        initApp(token);
    }

    // UI Events
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentTab = tab.dataset.tab;
            authSubmit.textContent = currentTab === 'login' ? "Accéder à l'interface" : 'Créer le compte';
            authError.textContent = '';
        });
    });

    authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = usernameInput.value.trim();
        const password = passwordInput.value;
        
        if (!username || !password) return;
        
        authSubmit.disabled = true;
        authSubmit.textContent = 'Chargement...';
        authError.textContent = '';

        const endpoint = currentTab === 'login' ? '/api/login' : '/api/register';
        
        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            
            const textData = await res.text();
            let data;
            try {
                data = textData ? JSON.parse(textData) : {};
            } catch (e) {
                console.error("Réponse non-JSON du serveur:", textData);
                throw new Error('Erreur de communication avec le serveur');
            }
            
            if (!res.ok) {
                throw new Error(data.error || 'Une erreur est survenue');
            }

            if (currentTab === 'register') {
                // Auto login after register
                currentTab = 'login';
                authForm.dispatchEvent(new Event('submit'));
                return;
            }

            localStorage.setItem('prodigy_token', data.token);
            localStorage.setItem('prodigy_user', JSON.stringify(data.user));
            currentUser = data.user;
            initApp(data.token);

        } catch (error) {
            authError.textContent = error.message;
        } finally {
            authSubmit.disabled = false;
            authSubmit.textContent = currentTab === 'login' ? "Accéder à l'interface" : 'Créer le compte';
        }
    });

    logoutBtn.addEventListener('click', () => {
        localStorage.removeItem('prodigy_token');
        localStorage.removeItem('prodigy_user');
        if (socket) socket.disconnect();
        window.location.reload();
    });

    // App Initialization
    function initApp(token) {
        authContainer.classList.add('hidden');
        appContainer.classList.remove('hidden');
        
        currentUsername.textContent = currentUser.username;
        currentUserAvatar.textContent = currentUser.username.charAt(0).toUpperCase();

        connectSocket(token);
        fetchUsers();
    }

    async function fetchUsers() {
        try {
            const res = await fetch('/api/users');
            if (res.ok) {
                const textData = await res.text();
                if (textData) {
                    try {
                        const users = JSON.parse(textData);
                        renderUsersList(users);
                    } catch(e) {
                        console.error('Erreur JSON utilisateurs:', textData);
                    }
                }
            }
        } catch (error) {
            console.error('Erreur lors de la récupération des utilisateurs', error);
        }
    }

    function renderUsersList(users) {
        usersList.innerHTML = '';
        let online = 0;
        
        users.forEach(user => {
            if (user.id === currentUser.id) return; // Skip self
            
            if (user.status === 'online') online++;
            
            const li = document.createElement('li');
            li.id = `user-${user.id}`;
            li.innerHTML = `
                <div class="status-dot ${user.status === 'online' ? 'online' : ''}"></div>
                <span>${user.username}</span>
            `;
            usersList.appendChild(li);
        });
        
        onlineCount.textContent = online + 1; // +1 for current user
    }

    // Socket Interactions
    function connectSocket(token) {
        socket = io({
            auth: { token }
        });

        socket.on('connect', () => {
            console.log('Connecté au serveur de messagerie');
        });

        socket.on('connect_error', (err) => {
            console.error('Erreur de connexion socket:', err.message);
            if (err.message === 'Authentication error') {
                logoutBtn.click();
            }
        });

        socket.on('chat_history', (data) => {
            if (data.roomId === currentRoomId) {
                messagesContainer.innerHTML = '';
                data.messages.forEach(msg => appendMessage(msg));
                scrollToBottom();
            }
        });

        socket.on('new_message', (msg) => {
            if (msg.room_id === currentRoomId) {
                appendMessage(msg);
                scrollToBottom();
                typingIndicator.classList.add('hidden');
            }
        });

        socket.on('user_status_change', (data) => {
            const userEl = document.getElementById(`user-${data.userId}`);
            if (userEl) {
                const dot = userEl.querySelector('.status-dot');
                if (data.status === 'online') {
                    dot.classList.add('online');
                } else {
                    dot.classList.remove('online');
                }
            } else {
                fetchUsers(); // Refresh if new user
            }
        });

        socket.on('user_typing', (data) => {
            if (data.roomId === currentRoomId) {
                typingIndicator.classList.remove('hidden');
                clearTimeout(typingTimeout);
                typingTimeout = setTimeout(() => {
                    typingIndicator.classList.add('hidden');
                }, 3000);
            }
        });
    }

    // Messaging
    messageForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const content = messageInput.value.trim();
        if (!content || !socket) return;

        socket.emit('send_message', {
            roomId: currentRoomId,
            content: content
        });

        messageInput.value = '';
    });

    attachBtn.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file || !socket) return;

        // Limit file size to 2MB for base64 transmission
        if (file.size > 2 * 1024 * 1024) {
            alert('Le fichier est trop volumineux (max 2MB)');
            return;
        }

        const reader = new FileReader();
        reader.onload = (ev) => {
            const content = `[FILE]:${file.name}|${file.type}|${ev.target.result}`;
            socket.emit('send_message', {
                roomId: currentRoomId,
                content: content
            });
        };
        reader.readAsDataURL(file);
        fileInput.value = '';
    });

    messageInput.addEventListener('input', () => {
        if (socket) {
            socket.emit('typing', { roomId: currentRoomId });
        }
    });

    function appendMessage(msg) {
        const isSelf = msg.sender_id === currentUser.id;
        const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        let displayContent = escapeHTML(msg.content);
        
        // Check if message is a file
        if (msg.content && msg.content.startsWith('[FILE]:')) {
            try {
                const parts = msg.content.substring(7).split('|');
                const fileName = parts[0];
                const fileType = parts[1];
                const fileData = parts[2];
                
                if (fileType.startsWith('image/')) {
                    displayContent = `<img src="${fileData}" alt="${escapeHTML(fileName)}" style="max-width: 100%; border-radius: 8px; margin-top: 5px;">`;
                } else {
                    displayContent = `
                        <div style="display: flex; align-items: center; gap: 8px; padding: 10px; background: rgba(255,255,255,0.05); border-radius: 8px; margin-top: 5px;">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
                            <a href="${fileData}" download="${escapeHTML(fileName)}" style="color: inherit; text-decoration: none;">${escapeHTML(fileName)}</a>
                        </div>
                    `;
                }
            } catch(e) {
                displayContent = "Fichier corrompu";
            }
        }
        
        const div = document.createElement('div');
        div.className = `message ${isSelf ? 'self' : ''}`;
        
        div.innerHTML = `
            <div class="message-avatar">${msg.username.charAt(0).toUpperCase()}</div>
            <div class="message-content">
                <div class="message-meta">
                    <span class="message-sender">${msg.username}</span>
                    <span class="message-time">${time}</span>
                </div>
                <div class="message-bubble">${displayContent}</div>
            </div>
        `;
        
        messagesContainer.appendChild(div);
    }

    function scrollToBottom() {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
});
