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
    const menuToggleBtn = document.getElementById('menu-toggle-btn');
    const sidebar = document.querySelector('.sidebar');
    
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
    const createRoomBtn = document.getElementById('create-room-btn');
    const roomList = document.getElementById('room-list');
    const currentRoomName = document.getElementById('current-room-name');
    const createRoomModal = document.getElementById('create-room-modal');
    const newRoomNameInput = document.getElementById('new-room-name');
    const newRoomLockedCheckbox = document.getElementById('new-room-locked');
    const cancelRoomBtn = document.getElementById('cancel-room-btn');
    const confirmRoomBtn = document.getElementById('confirm-room-btn');
    
    const roomSearchInput = document.getElementById('room-search-input');
    const toggleLockBtn = document.getElementById('toggle-lock-btn');
    const inviteMemberBtn = document.getElementById('invite-member-btn');
    const inviteModal = document.getElementById('invite-modal');
    const inviteUsernameInput = document.getElementById('invite-username');
    const cancelInviteBtn = document.getElementById('cancel-invite-btn');
    const confirmInviteBtn = document.getElementById('confirm-invite-btn');
    const micBtn = document.getElementById('mic-btn');
    const recordingTimer = document.getElementById('recording-timer');
    const recordingTimeDisplay = document.getElementById('recording-time');

    // DOM Elements for Reply
    const replyPreviewContainer = document.getElementById('reply-preview-container');
    const replyPreviewUsername = document.getElementById('reply-preview-username');
    const replyPreviewText = document.getElementById('reply-preview-text');
    const replyPreviewCloseBtn = document.getElementById('reply-preview-close-btn');

    // State
    let replyingToMessageId = null;
    let currentTab = 'login';
    let socket = null;
    let currentUser = null;
    let currentRoomId = 1; // Default General room
    let typingTimeout = null;
    let unreadCounts = {};
    let allRooms = [];
    let currentRoomData = null;
    let mediaRecorder = null;
    let audioChunks = [];
    let recordingInterval = null;
    let recordingSeconds = 0;
    let appUsers = [];
    let activeMentionIndex = 0;
    let filteredUsersForMention = [];
    let mentionAtIndex = -1;

    // Demander les permissions de notifications et enregistrer le Service Worker immédiatement à l'entrée sur le site
    if ('Notification' in window) {
        if (Notification.permission === 'default') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    console.log('Notifications autorisées par l\'utilisateur.');
                }
            });
        }
    }

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js')
            .then(reg => {
                console.log('Service Worker enregistré à l\'entrée du site !');
                initPushNotifications();
            })
            .catch(err => console.error('Erreur d\'enregistrement du Service Worker:', err));
    }

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

        const openAdminBtn = document.getElementById('open-admin-btn');
        if (openAdminBtn) {
            if (currentUser && currentUser.role === 'admin') {
                openAdminBtn.classList.remove('hidden');
            } else {
                openAdminBtn.classList.add('hidden');
            }
        }

        // Synchroniser l'abonnement push en arrière-plan
        initPushNotifications();

        connectSocket(token);
        fetchUsers();
        fetchRooms();
    }

    async function fetchUsers() {
        try {
            const res = await fetch('/api/users');
            if (res.ok) {
                const textData = await res.text();
                if (textData) {
                    try {
                        const users = JSON.parse(textData);
                        appUsers = users;
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
            if (user.id === currentUser.id || user.role === 'admin') return; // Skip self & admins
            
            if (user.status === 'online') online++;
            
            const li = document.createElement('li');
            li.id = `user-${user.id}`;
            li.innerHTML = `
                <div class="status-dot ${user.status === 'online' ? 'online' : ''}"></div>
                <span>${user.username}</span>
            `;
            usersList.appendChild(li);
        });
        
        const currentIsAdmin = currentUser && currentUser.role === 'admin';
        onlineCount.textContent = online + (currentIsAdmin ? 0 : 1);
    }

    async function fetchRooms() {
        try {
            const res = await fetch('/api/rooms');
            if (res.ok) {
                const textData = await res.text();
                if (textData) {
                    try {
                        allRooms = JSON.parse(textData);
                        currentRoomData = allRooms.find(r => Number(r.id) === Number(currentRoomId));
                        renderRoomsList(allRooms);
                        updateRoomActions();
                        
                        if (currentRoomData) {
                            let headerIcon = currentRoomData.is_locked === 1 ? '🔒' : '#';
                            currentRoomName.textContent = `${headerIcon} ${currentRoomData.name}`;
                        }
                    } catch (e) {
                        console.error('Erreur JSON canaux:', textData);
                    }
                }
            }
        } catch (error) {
            console.error('Erreur lors de la récupération des canaux', error);
        }
    }

    function renderRoomsList(rooms) {
        roomList.innerHTML = '';
        rooms.forEach(room => {
            const li = document.createElement('li');
            li.dataset.room = room.id;
            
            let icon = '#';
            if (room.is_locked === 1) {
                icon = '🔒';
            }
            
            li.innerHTML = `<span style="margin-right:0.5rem; font-size:0.9rem;">${icon}</span> ${room.name}`;
            if (Number(room.id) === Number(currentRoomId)) {
                li.classList.add('active');
            }
            
            li.addEventListener('click', () => {
                switchRoom(room.id, room.name);
            });
            
            roomList.appendChild(li);
            updateRoomBadge(room.id);
        });
    }

    if (roomSearchInput) {
        roomSearchInput.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            const filtered = allRooms.filter(r => r.name.toLowerCase().includes(term));
            renderRoomsList(filtered);
        });
    }

    function switchRoom(roomId, roomName) {
        if (Number(roomId) === Number(currentRoomId)) return;
        
        currentRoomId = roomId;
        currentRoomData = allRooms.find(r => Number(r.id) === Number(roomId));
        
        let headerIcon = currentRoomData && currentRoomData.is_locked === 1 ? '🔒' : '#';
        currentRoomName.textContent = `${headerIcon} ${roomName}`;
        
        updateRoomActions();
        
        // Clear unread count
        unreadCounts[roomId] = 0;
        updateRoomBadge(roomId);
        
        // Update active class in sidebar
        const roomItems = roomList.querySelectorAll('li');
        roomItems.forEach(item => {
            if (Number(item.dataset.room) === Number(roomId)) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });
        
        // Clear message container and load history
        messagesContainer.innerHTML = '';
        if (socket) {
            socket.emit('join_room', { roomId });
        }
        
        // Close sidebar on mobile
        if (sidebar && sidebar.classList.contains('open')) {
            sidebar.classList.remove('open');
        }
    }

    // Socket Interactions
    function connectSocket(token) {
        const statusDot = document.getElementById('connection-status-dot');
        const statusText = document.getElementById('connection-status-text');

        function updateUIStatus(state) {
            if (!statusDot || !statusText) return;
            statusDot.classList.remove('online', 'reconnecting');
            
            if (state === 'online') {
                statusDot.classList.add('online');
                statusText.textContent = 'Connecté';
            } else if (state === 'reconnecting') {
                statusDot.classList.add('reconnecting');
                statusText.textContent = 'Reconnexion...';
            } else {
                statusText.textContent = 'Déconnecté';
            }
        }

        socket = io({
            auth: { token },
            transports: ['polling', 'websocket'], // Force HTTP Polling first for 100% mobile connectivity, then upgrade to WebSocket
            upgrade: true,
            rememberUpgrade: true,
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000
        });

        socket.on('connect', () => {
            console.log('Connecté au serveur de messagerie');
            updateUIStatus('online');
            // Synchronisation automatique : Rejoindre immédiatement le canal en cours de visualisation lors de la connexion ou d'une reconnexion
            socket.emit('join_room', { roomId: currentRoomId });
        });

        socket.on('disconnect', (reason) => {
            console.log('Déconnecté du serveur:', reason);
            updateUIStatus('offline');
        });

        socket.on('reconnect_attempt', () => {
            console.log('Tentative de reconnexion...');
            updateUIStatus('reconnecting');
        });

        socket.on('connect_error', (err) => {
            console.error('Erreur de connexion socket:', err.message);
            updateUIStatus('offline');
            if (err.message === 'Authentication error') {
                logoutBtn.click();
            }
        });

        socket.on('chat_history', (data) => {
            if (Number(data.roomId) === Number(currentRoomId)) {
                messagesContainer.innerHTML = '';
                data.messages.forEach(msg => appendMessage(msg));
                scrollToBottom();
            }
        });

        socket.on('new_message', (msg) => {
            const isMentioned = msg.content && msg.content.includes(`@${currentUser.username}`);
            
            if (Number(msg.room_id) === Number(currentRoomId)) {
                appendMessage(msg);
                scrollToBottom();
                typingIndicator.classList.add('hidden');
                
                // Play sound and show notification if message is not from self
                if (msg.sender_id !== currentUser.id) {
                    if (isMentioned) {
                        playNotificationSound('mention');
                        showNativeNotification(msg, true); // Force notification even if window is open
                    } else if (document.hidden) {
                        playNotificationSound('message');
                        showNativeNotification(msg, false);
                    }
                }
            } else {
                unreadCounts[msg.room_id] = (unreadCounts[msg.room_id] || 0) + 1;
                updateRoomBadge(msg.room_id);
                showToastNotification(msg);
                
                // Play sound and show notification if message is not from self
                if (msg.sender_id !== currentUser.id) {
                    if (isMentioned) {
                        playNotificationSound('mention');
                        showNativeNotification(msg, true);
                    } else {
                        playNotificationSound('message');
                        showNativeNotification(msg, false);
                    }
                }
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
        
        socket.on('room_access_denied', (data) => {
            alert(data.message);
            // Revert back to general
            if (Number(currentRoomId) !== 1) {
                switchRoom(1, 'Général');
            }
        });
        
        socket.on('room_updated', (data) => {
            fetchRooms();
        });
        
        socket.on('user_invited', (data) => {
            if (data.userId === currentUser.id) {
                alert(`Vous avez été invité au canal privé: ${data.roomName}`);
                fetchRooms();
            }
        });

        socket.on('user_typing', (data) => {
            if (Number(data.roomId) === Number(currentRoomId)) {
                typingIndicator.classList.remove('hidden');
                clearTimeout(typingTimeout);
                typingTimeout = setTimeout(() => {
                    typingIndicator.classList.add('hidden');
                }, 3000);
            }
        });

        socket.on('room_created', (room) => {
            fetchRooms();
        });

        socket.on('message_deleted', (data) => {
            const msgEl = document.getElementById('msg-' + data.id);
            if (msgEl) {
                msgEl.style.transition = 'all 0.3s ease';
                msgEl.style.opacity = '0';
                msgEl.style.transform = 'scale(0.9)';
                setTimeout(() => {
                    msgEl.remove();
                }, 300);
            }
        });

        socket.on('room_deleted', (data) => {
            if (Number(currentRoomId) === Number(data.roomId)) {
                alert("Ce canal a été supprimé par un administrateur.");
                switchRoom(1, 'Général');
            }
            fetchRooms();
        });

        socket.on('new_ticket', (ticket) => {
            if (currentUser && currentUser.role === 'admin') {
                showToastNotification({
                    username: ticket.username,
                    content: `Nouvelle plainte: ${ticket.title} (Catégorie: ${ticket.category})`,
                    room_name: 'Console Admin'
                });
                
                const adminModal = document.getElementById('admin-modal');
                if (adminModal && !adminModal.classList.contains('hidden')) {
                    fetchAdminTickets();
                }
            }
        });

        socket.on('ticket_updated', (data) => {
            showToastNotification({
                username: 'Support Admin',
                content: `Votre plainte #${data.id} a été résolue ! Note: ${data.admin_note}`,
                room_name: 'Support & Plaintes'
            });
            
            const supportModal = document.getElementById('support-modal');
            if (supportModal && !supportModal.classList.contains('hidden')) {
                fetchMyTickets();
            }
        });

        socket.on('role_changed', (data) => {
            alert(`Votre rôle a été mis à jour en: ${data.role}. Le site va se recharger.`);
            currentUser.role = data.role;
            localStorage.setItem('prodigy_user', JSON.stringify(currentUser));
            window.location.reload();
        });

        socket.on('user_banned', () => {
            alert("Votre compte a été banni ou supprimé par un administrateur.");
            localStorage.removeItem('prodigy_token');
            localStorage.removeItem('prodigy_user');
            window.location.reload();
        });
    }

    // Messaging
    messageForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const content = messageInput.value.trim();
        if (!content || !socket) return;

        socket.emit('send_message', {
            roomId: currentRoomId,
            content: content,
            replyToId: replyingToMessageId
        });

        messageInput.value = '';
        cancelReply();
    });

    attachBtn.addEventListener('click', () => {
        fileInput.click();
    });

    if (createRoomBtn) {
        createRoomBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            createRoomModal.classList.remove('hidden');
            newRoomNameInput.value = '';
            newRoomNameInput.focus();
        });
    }

    if (cancelRoomBtn) {
        cancelRoomBtn.addEventListener('click', () => {
            createRoomModal.classList.add('hidden');
        });
    }

    if (confirmRoomBtn) {
        confirmRoomBtn.addEventListener('click', async () => {
            const roomName = newRoomNameInput.value.trim();
            const isLocked = newRoomLockedCheckbox ? newRoomLockedCheckbox.checked : false;
            
            if (!roomName) return;
            
            try {
                const res = await fetch('/api/rooms', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('prodigy_token')}`
                    },
                    body: JSON.stringify({ name: roomName, is_locked: isLocked })
                });
                
                const textData = await res.text();
                const data = textData ? JSON.parse(textData) : {};
                
                if (!res.ok) {
                    alert(data.error || 'Erreur lors de la création du canal');
                } else {
                    createRoomModal.classList.add('hidden');
                    switchRoom(data.id, data.name);
                }
            } catch (error) {
                console.error('Erreur création canal:', error);
                alert('Erreur de communication avec le serveur');
            }
        });
    }

    // Lock/Unlock Room
    if (toggleLockBtn) {
        toggleLockBtn.addEventListener('click', async () => {
            try {
                const res = await fetch(`/api/rooms/${currentRoomId}/toggle_lock`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${localStorage.getItem('prodigy_token')}`
                    }
                });
                const data = await res.json();
                if (!res.ok) {
                    alert(data.error || "Erreur lors du verrouillage");
                }
            } catch(e) {
                alert("Erreur serveur");
            }
        });
    }

    // Invite Member
    if (inviteMemberBtn) {
        inviteMemberBtn.addEventListener('click', () => {
            inviteModal.classList.remove('hidden');
            inviteUsernameInput.value = '';
            inviteUsernameInput.focus();
        });
    }
    
    if (cancelInviteBtn) {
        cancelInviteBtn.addEventListener('click', () => {
            inviteModal.classList.add('hidden');
        });
    }

    if (confirmInviteBtn) {
        confirmInviteBtn.addEventListener('click', async () => {
            const username = inviteUsernameInput.value.trim();
            if (!username) return;

            try {
                const res = await fetch(`/api/rooms/${currentRoomId}/invite`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('prodigy_token')}`
                    },
                    body: JSON.stringify({ username })
                });
                const data = await res.json();
                if (!res.ok) {
                    alert(data.error || "Erreur lors de l'invitation");
                } else {
                    alert(data.message);
                    inviteModal.classList.add('hidden');
                }
            } catch(e) {
                alert("Erreur serveur");
            }
        });
    }

    // Audio Recording
    if (micBtn) {
        micBtn.addEventListener('mousedown', startRecording);
        micBtn.addEventListener('mouseup', stopRecording);
        micBtn.addEventListener('mouseleave', stopRecording);
        // Mobile support
        micBtn.addEventListener('touchstart', startRecording);
        micBtn.addEventListener('touchend', stopRecording);
    }

    async function startRecording(e) {
        e.preventDefault();
        if (mediaRecorder && mediaRecorder.state === 'recording') return;
        
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];
            
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunks.push(event.data);
                }
            };
            
            mediaRecorder.onstop = () => {
                const mimeType = mediaRecorder.mimeType || 'audio/webm';
                const audioBlob = new Blob(audioChunks, { type: mimeType });
                stream.getTracks().forEach(track => track.stop());
                
                // Don't send empty or broken recordings
                if (audioChunks.length === 0 || audioBlob.size === 0) {
                    return;
                }
                
                // Read as base64 and send
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const durationToSend = recordingSeconds || 1;
                    const content = `[AUDIO]:audio.webm|${mimeType}|${durationToSend}|${ev.target.result}`;
                    socket.emit('send_message', {
                        roomId: currentRoomId,
                        content: content
                    });
                };
                reader.readAsDataURL(audioBlob);
            };
            
            mediaRecorder.start();
            micBtn.style.color = 'var(--error)';
            micBtn.style.transform = 'scale(1.1)';

            // Start UI Timer
            messageInput.classList.add('hidden');
            if (recordingTimer) recordingTimer.classList.remove('hidden');
            recordingSeconds = 0;
            if (recordingTimeDisplay) recordingTimeDisplay.textContent = '00:00';
            recordingInterval = setInterval(() => {
                recordingSeconds++;
                const mins = String(Math.floor(recordingSeconds / 60)).padStart(2, '0');
                const secs = String(recordingSeconds % 60).padStart(2, '0');
                if (recordingTimeDisplay) recordingTimeDisplay.textContent = `${mins}:${secs}`;
            }, 1000);
            
        } catch (err) {
            console.error("Microphone access denied", err);
            alert("Veuillez autoriser l'accès au microphone pour envoyer des vocaux.");
        }
    }

    function stopRecording(e) {
        e.preventDefault();
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
            micBtn.style.color = '';
            micBtn.style.transform = '';
            
            // Stop UI Timer
            clearInterval(recordingInterval);
            messageInput.classList.remove('hidden');
            if (recordingTimer) recordingTimer.classList.add('hidden');
        }
    }

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file || !socket) return;

        // Limiter la taille du fichier à 15 Mo pour la transmission
        if (file.size > 15 * 1024 * 1024) {
            alert('Le fichier est trop volumineux (max 15 Mo).');
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
        handleMentionInput();
    });

    messageInput.addEventListener('keydown', (e) => {
        const dropdown = document.getElementById('mention-dropdown');
        if (dropdown && dropdown.style.display === 'block') {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                activeMentionIndex = (activeMentionIndex + 1) % filteredUsersForMention.length;
                renderMentionDropdown();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                activeMentionIndex = (activeMentionIndex - 1 + filteredUsersForMention.length) % filteredUsersForMention.length;
                renderMentionDropdown();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (filteredUsersForMention[activeMentionIndex]) {
                    selectMentionUser(filteredUsersForMention[activeMentionIndex].username);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                hideMentionDropdown();
            }
        }
    });

    function handleMentionInput() {
        const selectionStart = messageInput.selectionStart;
        const textBeforeCursor = messageInput.value.substring(0, selectionStart);
        const lastAtIndex = textBeforeCursor.lastIndexOf('@');
        
        if (lastAtIndex !== -1) {
            const queryText = textBeforeCursor.substring(lastAtIndex + 1);
            // Mentions should not contain spaces (username only)
            if (!queryText.includes(' ')) {
                mentionAtIndex = lastAtIndex;
                const query = queryText.toLowerCase();
                
                // Filter users (excluding ourselves)
                filteredUsersForMention = appUsers.filter(user => 
                    user.username.toLowerCase().includes(query) && 
                    user.id !== currentUser.id
                );
                
                if (filteredUsersForMention.length > 0) {
                    activeMentionIndex = 0;
                    renderMentionDropdown();
                    return;
                }
            }
        }
        hideMentionDropdown();
    }

    function renderMentionDropdown() {
        const dropdown = document.getElementById('mention-dropdown');
        if (!dropdown) return;
        
        dropdown.innerHTML = '';
        filteredUsersForMention.forEach((user, index) => {
            const item = document.createElement('div');
            item.className = `mention-item ${index === activeMentionIndex ? 'active' : ''}`;
            item.innerHTML = `
                <span class="status-dot ${user.status === 'online' ? 'online' : ''}"></span>
                <span>${escapeHTML(user.username)}</span>
            `;
            item.addEventListener('click', () => {
                selectMentionUser(user.username);
            });
            dropdown.appendChild(item);
        });
        dropdown.style.display = 'block';
    }

    function selectMentionUser(username) {
        if (mentionAtIndex === -1) return;
        
        const value = messageInput.value;
        const before = value.substring(0, mentionAtIndex);
        const after = value.substring(messageInput.selectionStart);
        
        messageInput.value = `${before}@${username} ${after}`;
        messageInput.focus();
        
        // Move selection range/cursor right after the completed mention name
        const newCursorPos = before.length + username.length + 2; // +2 for @ and trailing space
        messageInput.setSelectionRange(newCursorPos, newCursorPos);
        
        hideMentionDropdown();
    }

    function hideMentionDropdown() {
        const dropdown = document.getElementById('mention-dropdown');
        if (dropdown) {
            dropdown.style.display = 'none';
        }
        filteredUsersForMention = [];
        activeMentionIndex = 0;
        mentionAtIndex = -1;
    }

    // Hide dropdown when clicking outside
    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('mention-dropdown');
        if (dropdown && !messageInput.contains(e.target) && !dropdown.contains(e.target)) {
            hideMentionDropdown();
        }
    });

    // Reply System Helpers
    window.replyToMessage = function(msgId, sender, rawContent) {
        replyingToMessageId = msgId;
        
        let textExcerpt = rawContent;
        if (rawContent.startsWith('[FILE]:')) {
            textExcerpt = '📄 Fichier joint';
        } else if (rawContent.startsWith('[AUDIO]:')) {
            textExcerpt = '🎤 Message vocal';
        } else if (rawContent.startsWith('[STICKER]:')) {
            textExcerpt = '🖼️ Sticker';
        }
        
        // Truncate if long
        if (textExcerpt.length > 60) {
            textExcerpt = textExcerpt.substring(0, 60) + '...';
        }
        
        replyPreviewUsername.textContent = sender;
        replyPreviewText.textContent = textExcerpt;
        replyPreviewContainer.classList.remove('hidden');
        
        // Focus the message input automatically
        messageInput.focus();
    };

    window.cancelReply = function() {
        replyingToMessageId = null;
        replyPreviewContainer.classList.add('hidden');
    };

    if (replyPreviewCloseBtn) {
        replyPreviewCloseBtn.addEventListener('click', () => {
            window.cancelReply();
        });
    }

    function appendMessage(msg) {
        const isSelf = msg.sender_id === currentUser.id;
        const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        let displayContent = escapeHTML(msg.content);
        let isAudio = false;
        let isSticker = false;
        
        // Check if message is a file, audio or sticker
        if (msg.content && msg.content.startsWith('[STICKER]:')) {
            isSticker = true;
            const stickerUrl = msg.content.substring(10);
            displayContent = `<img src="${stickerUrl}" class="chat-sticker" alt="Sticker" referrerpolicy="no-referrer">`;
        } else if (msg.content && msg.content.startsWith('[FILE]:')) {
            try {
                const parts = msg.content.substring(7).split('|');
                const fileName = parts[0];
                const fileType = parts[1];
                const fileData = parts[2];
                
                if (fileType.startsWith('image/')) {
                    displayContent = `<img src="${fileData}" alt="${escapeHTML(fileName)}" style="max-width: 100%; border-radius: 8px; margin-top: 5px;">`;
                } else if (fileType.startsWith('video/')) {
                    displayContent = `
                        <video src="${fileData}" controls style="max-width: 100%; max-height: 250px; border-radius: 12px; margin-top: 8px; display: block; border: 1px solid var(--border); box-shadow: 0 4px 15px rgba(0,0,0,0.3);" preload="metadata" playsinline></video>
                    `;
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
        } else if (msg.content && msg.content.startsWith('[AUDIO]:')) {
            isAudio = true;
            try {
                const parts = msg.content.substring(8).split('|');
                let fileData = parts[2];
                let fixedDuration = 0;
                
                // Backwards compatibility check
                if (fileData && !fileData.startsWith('data:')) {
                    fixedDuration = parseInt(parts[2]);
                    fileData = parts[3];
                }

                const audioId = 'audio-' + Math.random().toString(36).substr(2, 9);
                const displayTime = fixedDuration > 0 ? `${Math.floor(fixedDuration / 60)}:${String(fixedDuration % 60).padStart(2, '0')}` : '0:00';
                
                const isBase64 = fileData && fileData.startsWith('data:');
                
                displayContent = `
                    <div class="custom-audio">
                        <button onclick="window.toggleAudio('${audioId}', this)" class="audio-btn">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                        </button>
                        <div class="audio-body">
                            <div class="audio-track">
                                <div id="progress-${audioId}" class="audio-fill"></div>
                            </div>
                            <div class="audio-info">
                                <span class="audio-label">Vocal</span>
                                <span id="time-${audioId}" class="audio-time">${displayTime}</span>
                            </div>
                        </div>
                        <audio id="${audioId}" src="${!isBase64 ? fileData : ''}" data-fixed-duration="${fixedDuration}" ontimeupdate="window.updateAudioProgress('${audioId}')" onended="window.resetAudio('${audioId}')" onplay="window.updateAudioProgress('${audioId}')" onpause="window.updateAudioProgress('${audioId}')" preload="auto"></audio>
                    </div>
                `;

                // Load native blob asynchronously
                if (fileData && fileData.startsWith('data:')) {
                    fetch(fileData)
                        .then(res => res.blob())
                        .then(blob => {
                            const blobUrl = URL.createObjectURL(blob);
                            // We need to wait for the element to be inserted into the DOM
                            setTimeout(() => {
                                const audioEl = document.getElementById(audioId);
                                  if (audioEl) audioEl.src = blobUrl;
                            }, 50);
                        })
                        .catch(err => console.error('Blob fetch failed:', err));
                }
            } catch(e) {
                displayContent = "Audio corrompu";
            }
        } else {
            // Highlight mentions
            const mentionRegex = /@([a-zA-Z0-9_]+)/g;
            displayContent = displayContent.replace(mentionRegex, (match, p1) => {
                if (p1 === currentUser.username) {
                    return `<span style="background: var(--error); color: white; padding: 0 4px; border-radius: 4px; font-weight: bold;">${match}</span>`;
                }
                return `<span style="color: var(--success); font-weight: bold;">${match}</span>`;
            });
        }
        let replyBubbleHtml = '';
        if (msg.reply_to_id) {
            let excerpt = msg.reply_content || '';
            if (excerpt.startsWith('[FILE]:')) excerpt = '📄 Fichier joint';
            else if (excerpt.startsWith('[AUDIO]:')) excerpt = '🎤 Message vocal';
            else if (excerpt.startsWith('[STICKER]:')) excerpt = '🖼️ Sticker';
            
            if (excerpt.length > 50) excerpt = excerpt.substring(0, 50) + '...';
            
            replyBubbleHtml = `<div class="message-reply-bubble" data-reply-target="${msg.reply_to_id}"><span class="message-reply-username">${escapeHTML(msg.reply_username || 'Utilisateur')}</span><p class="message-reply-text">${escapeHTML(excerpt)}</p></div>`;
        }

        const div = document.createElement('div');
        div.id = 'msg-' + msg.id;
        div.className = `message message-row ${isSelf ? 'self' : ''}`;
        
        let deleteBtnHtml = '';
        if (currentUser && currentUser.role === 'admin') {
            deleteBtnHtml = `
                <button class="delete-msg-btn" title="Supprimer le message" style="background: none; border: none; color: var(--error); opacity: 0.6; cursor: pointer; padding: 2px; display: inline-flex; align-items: center; justify-content: center; transition: opacity 0.2s ease;" onclick="window.deleteMessage(${msg.id})">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                </button>
            `;
        }

        div.innerHTML = `
            <div class="swipe-indicator-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
            </div>
            <div class="message-avatar">${msg.username.charAt(0).toUpperCase()}</div>
            <div class="message-content">
                <div class="message-meta" style="display: flex; align-items: center; gap: 0.5rem;">
                    <span class="message-sender">${msg.username}</span>
                    <span class="message-time">${time}</span>
                    ${deleteBtnHtml}
                </div>
                <div class="message-bubble ${isAudio ? 'audio-bubble' : ''} ${isSticker ? 'sticker-bubble' : ''}">${replyBubbleHtml}${displayContent}</div>
            </div>
            <button class="reply-hover-btn" title="Répondre">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
            </button>
        `;
        
        messagesContainer.appendChild(div);

        // Click bubble scroll listener
        const replyBubble = div.querySelector('.message-reply-bubble');
        if (replyBubble) {
            replyBubble.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetId = replyBubble.dataset.replyTarget;
                const targetEl = document.getElementById('msg-' + targetId);
                if (targetEl) {
                    targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    targetEl.classList.add('message-highlight-flash');
                    setTimeout(() => {
                        targetEl.classList.remove('message-highlight-flash');
                    }, 1200);
                }
            });
        }

        // Desktop Reply Hover btn click
        const hoverBtn = div.querySelector('.reply-hover-btn');
        if (hoverBtn) {
            hoverBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.replyToMessage(msg.id, msg.username, msg.content);
            });
        }

        // Mobile Swipe To Reply Touch Gestures
        let touchStartX = 0;
        let touchStartY = 0;
        let isSwiping = false;
        let swipeDiff = 0;

        div.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            isSwiping = false;
            swipeDiff = 0;
            div.style.transition = '';
        }, { passive: true });

        div.addEventListener('touchmove', (e) => {
            const diffX = e.touches[0].clientX - touchStartX;
            const diffY = e.touches[0].clientY - touchStartY;
            
            // Only swipe to the right, and block swipe if vertical scroll is dominant
            if (diffX > 0 && Math.abs(diffY) < 30) {
                isSwiping = true;
                swipeDiff = Math.min(diffX, 70);
                div.style.transform = `translateX(${swipeDiff}px)`;
                
                if (swipeDiff > 45) {
                    div.classList.add('swiping-active');
                } else {
                    div.classList.remove('swiping-active');
                }
                
                if (e.cancelable) e.preventDefault();
            }
        }, { passive: false });

        div.addEventListener('touchend', (e) => {
            div.classList.remove('swiping-active');
            div.style.transition = 'transform 0.25s cubic-bezier(0.1, 0.8, 0.2, 1)';
            div.style.transform = 'translateX(0px)';
            
            if (isSwiping && swipeDiff > 45) {
                window.replyToMessage(msg.id, msg.username, msg.content);
            }
            
            setTimeout(() => {
                div.style.transition = '';
            }, 250);
        });

        // Attacher des écouteurs sur les médias pour forcer le défilement complet dès qu'ils finissent de charger !
        const mediaElements = div.querySelectorAll('img, video');
        mediaElements.forEach(media => {
            media.addEventListener('load', scrollToBottom);
            media.addEventListener('loadeddata', scrollToBottom);
        });
    }

    function scrollToBottom() {
        // Utilisation d'un court délai pour s'assurer du rendu complet de la hauteur du conteneur (très important sur mobile)
        setTimeout(() => {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }, 50);
    }

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // Notifications Helpers
    function updateRoomActions() {
        if (!currentRoomData) return;
        
        if (currentRoomData.creator_id === currentUser.id) {
            toggleLockBtn.classList.remove('hidden');
            if (currentRoomData.is_locked === 1) {
                toggleLockBtn.style.color = 'var(--error)';
                inviteMemberBtn.classList.remove('hidden');
            } else {
                toggleLockBtn.style.color = '';
                inviteMemberBtn.classList.add('hidden');
            }
        } else {
            toggleLockBtn.classList.add('hidden');
            inviteMemberBtn.classList.add('hidden');
        }
    }

    function updateRoomBadge(roomId) {
        const roomLi = roomList.querySelector(`li[data-room="${roomId}"]`);
        if (!roomLi) return;
        
        let badge = roomLi.querySelector('.unread-badge');
        const count = unreadCounts[roomId] || 0;
        
        if (count > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'unread-badge';
                roomLi.appendChild(badge);
            }
            badge.textContent = count;
        } else if (badge) {
            badge.remove();
        }
    }

    function showToastNotification(msg) {
        const toastContainer = document.getElementById('toast-container');
        if (!toastContainer) return;
        
        const roomLi = roomList.querySelector(`li[data-room="${msg.room_id}"]`);
        const roomName = roomLi ? roomLi.textContent.replace(/#\s*/, '').replace(/\s*\d+$/, '') : `Canal ${msg.room_id}`;
        
        let cleanText = msg.content;
        if (cleanText.startsWith('[FILE]:')) {
            cleanText = "📎 Fichier joint";
        }
        
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerHTML = `
            <div class="toast-avatar">${msg.username.charAt(0).toUpperCase()}</div>
            <div class="toast-content">
                <div class="toast-header">
                    <span class="toast-sender">${escapeHTML(msg.username)}</span>
                    <span class="toast-room"># ${escapeHTML(roomName)}</span>
                </div>
                <div class="toast-text">${escapeHTML(cleanText)}</div>
            </div>
        `;
        
        toast.addEventListener('click', () => {
            switchRoom(msg.room_id, roomName);
            toast.remove();
        });
        
        toastContainer.appendChild(toast);
        
        setTimeout(() => {
            if (toast.parentElement) toast.remove();
        }, 5000);
    }

    function showNativeNotification(msg, force = false) {
        if ('Notification' in window && Notification.permission === 'granted') {
            // Only show if page is hidden OR if forced (like an active mention in another channel/tab)
            if (document.hidden || force) {
                const roomLi = roomList.querySelector(`li[data-room="${msg.room_id}"]`);
                const roomName = roomLi ? roomLi.textContent.replace(/#\s*/, '').replace(/\s*\d+$/, '') : `Canal ${msg.room_id}`;
                
                let cleanText = msg.content;
                if (cleanText.startsWith('[FILE]:')) {
                    cleanText = "📎 Fichier joint";
                }
                
                const isMentioned = msg.content && msg.content.includes(`@${currentUser.username}`);
                const title = isMentioned ? `🔔 Mentionné par @${msg.username} dans #${roomName}` : `Nouveau message dans #${roomName}`;
                
                const options = {
                    body: `${msg.username}: ${cleanText}`,
                    tag: `msg-${msg.room_id}`, // Group notifications per room
                    requireInteraction: isMentioned, // Mentions require user click to dismiss
                    icon: '/favicon.ico'
                };

                // Utiliser le Service Worker pour mobile/arrière-plan si disponible
                if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                    navigator.serviceWorker.ready.then(reg => {
                        reg.showNotification(title, options);
                    });
                } else {
                    const notif = new Notification(title, options);
                    notif.onclick = () => {
                        window.focus();
                        switchRoom(msg.room_id, roomName);
                        notif.close();
                    };
                }
            }
        }
    }

    function playNotificationSound(type = 'message') {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            const ctx = new AudioContext();
            
            if (type === 'mention') {
                // Elegant double chime synth sound for mentions (G6 followed by C7)
                const now = ctx.currentTime;
                
                const osc1 = ctx.createOscillator();
                const gain1 = ctx.createGain();
                osc1.type = 'sine';
                osc1.frequency.setValueAtTime(1567.98, now); // G6
                gain1.gain.setValueAtTime(0, now);
                gain1.gain.linearRampToValueAtTime(0.12, now + 0.04);
                gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
                osc1.connect(gain1);
                gain1.connect(ctx.destination);
                osc1.start(now);
                osc1.stop(now + 0.4);
                
                const osc2 = ctx.createOscillator();
                const gain2 = ctx.createGain();
                osc2.type = 'sine';
                osc2.frequency.setValueAtTime(2093.00, now + 0.12); // C7
                gain2.gain.setValueAtTime(0, now + 0.12);
                gain2.gain.linearRampToValueAtTime(0.12, now + 0.16);
                gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.52);
                osc2.connect(gain2);
                gain2.connect(ctx.destination);
                osc2.start(now + 0.12);
                osc2.stop(now + 0.52);
            } else {
                // Soft single chime synth sound for normal messages (E6)
                const now = ctx.currentTime;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(1318.51, now); // E6
                gain.gain.setValueAtTime(0, now);
                gain.gain.linearRampToValueAtTime(0.08, now + 0.05);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(now);
                osc.stop(now + 0.35);
            }
        } catch (e) {
            console.warn('Web Audio playback blocked or unsupported', e);
        }
    }

    // Toggle menu event listeners
    if (menuToggleBtn && sidebar) {
        menuToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebar.classList.toggle('open');
        });
        
        document.addEventListener('click', (e) => {
            if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && e.target !== menuToggleBtn) {
                sidebar.classList.remove('open');
            }
        });
    }

    // ========== CUSTOM AUDIO PLAYER (NATIVE EVENT-DRIVEN) ==========
    // Uses the HTML5 native 'timeupdate' event, 'ended', 'play', and 'pause'
    
    window.toggleAudio = function(audioId, btn) {
        const audio = document.getElementById(audioId);
        if (!audio) return;

        if (audio.paused) {
            // Pause all other playing audios
            document.querySelectorAll('audio').forEach(a => {
                if (a.id !== audioId && !a.paused) {
                    a.pause();
                }
            });
            audio.play().catch(err => console.error('Audio play failed:', err));
        } else {
            audio.pause();
        }
    };

    window.updateAudioProgress = function(audioId) {
        const audio = document.getElementById(audioId);
        if (!audio) return;

        const progress = document.getElementById('progress-' + audioId);
        const timeDisplay = document.getElementById('time-' + audioId);
        const btn = audio.parentElement.querySelector('.audio-btn');

        // Update play/pause button state visually
        if (btn) {
            if (audio.paused) {
                btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
            } else {
                btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';
            }
        }

        // Use custom duration stored during recording or fallback to native duration, or fallback to 10s if Infinity/NaN
        const fixedDuration = parseFloat(audio.getAttribute('data-fixed-duration')) || 0;
        const duration = fixedDuration > 0 ? fixedDuration : (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 10);

        if (duration > 0) {
            // Calculate progress using current time and duration
            const progressPercent = (audio.currentTime / duration) * 100;
            if (progress) {
                progress.style.width = `${Math.min(progressPercent, 100)}%`;
            }
        }

        // Update the elapsed/fixed time display
        if (timeDisplay) {
            const current = Math.floor(audio.currentTime);
            const mins = Math.floor(current / 60);
            const secs = String(current % 60).padStart(2, '0');
            timeDisplay.textContent = `${mins}:${secs}`;
        }
    };

    window.resetAudio = function(audioId) {
        const audio = document.getElementById(audioId);
        if (!audio) return;

        const progress = document.getElementById('progress-' + audioId);
        const timeDisplay = document.getElementById('time-' + audioId);
        const btn = audio.parentElement.querySelector('.audio-btn');

        if (progress) {
            progress.style.width = '0%';
        }

        if (btn) {
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
        }

        if (timeDisplay) {
            const fixedDuration = parseFloat(audio.getAttribute('data-fixed-duration')) || 0;
            const displayTime = fixedDuration > 0 ? `${Math.floor(fixedDuration / 60)}:${String(Math.floor(fixedDuration) % 60).padStart(2, '0')}` : '0:00';
            timeDisplay.textContent = displayTime;
        }
    };

    // ========== PREMIUM STICKER SYSTEM ==========
    const stickerPacks = {
        reactions: [
            { name: 'Heart', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Heart/3D/heart_3d.png' },
            { name: 'Fire', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Fire/3D/fire_3d.png' },
            { name: 'Tears of Joy', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Tears%20of%20joy/3D/tears_of_joy_3d.png' },
            { name: 'Cool', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Smiling%20face%20with%20sunglasses/3D/smiling_face_with_sunglasses_3d.png' },
            { name: 'Rocket', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Rocket/3D/rocket_3d.png' },
            { name: 'Party Popper', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Party%20popper/3D/party_popper_3d.png' },
            { name: 'Sparkles', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Sparkles/3D/sparkles_3d.png' },
            { name: 'Clapping', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Clapping%20hands/3D/clapping_hands_3d.png' }
        ],
        animals: [
            { name: 'Cute Cat', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Cat%20face/3D/cat_face_3d.png' },
            { name: 'Cute Dog', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Dog%20face/3D/dog_face_3d.png' },
            { name: 'Panda', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Panda/3D/panda_3d.png' },
            { name: 'Unicorn', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Unicorn/3D/unicorn_3d.png' },
            { name: 'Monkey', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Hear-no-evil%20monkey/3D/hear-no-evil_monkey_3d.png' },
            { name: 'Lion', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Lion/3D/lion_3d.png' },
            { name: 'Fox', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Fox/3D/fox_3d.png' },
            { name: 'Chicken', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Baby%20chick/3D/baby_chick_3d.png' }
        ],
        geek: [
            { name: 'Robot', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Robot/3D/robot_3d.png' },
            { name: 'Alien', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Alien/3D/alien_3d.png' },
            { name: 'Ghost', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Ghost/3D/ghost_3d.png' },
            { name: 'Thinking', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Thinking%20face/3D/thinking_face_3d.png' },
            { name: 'Money Mouth', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Money-mouth%20face/3D/money-mouth_face_3d.png' },
            { name: 'Exploding Head', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Exploding%20head/3D/exploding_head_3d.png' },
            { name: 'OK Hand', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/OK%20hand/3D/ok_hand_3d.png' },
            { name: '100 Points', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Hundred%20points/3D/hundred_points_3d.png' }
        ]
    };

    let activeStickerTab = 'reactions';

    const stickerBtn = document.getElementById('sticker-btn');
    const stickerPopover = document.getElementById('sticker-popover');

    if (stickerBtn && stickerPopover) {
        stickerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (stickerPopover.style.display === 'flex') {
                stickerPopover.style.display = 'none';
            } else {
                renderStickerPopover();
                stickerPopover.style.display = 'flex';
                // Close other popovers/dropdowns
                hideMentionDropdown();
            }
        });

        // Hide when clicking outside
        document.addEventListener('click', (e) => {
            if (stickerPopover.style.display === 'flex' && !stickerPopover.contains(e.target) && e.target !== stickerBtn) {
                stickerPopover.style.display = 'none';
            }
        });

        // Prevent closing when clicking inside popover
        stickerPopover.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    function renderStickerPopover() {
        if (!stickerPopover) return;
        
        stickerPopover.innerHTML = `
            <div class="sticker-popover-header">
                <span class="sticker-popover-title">Bibliothèque de Stickers</span>
            </div>
            <div class="sticker-tabs">
                <button class="sticker-tab ${activeStickerTab === 'reactions' ? 'active' : ''}" data-tab="reactions">🔥 Réactions</button>
                <button class="sticker-tab ${activeStickerTab === 'animals' ? 'active' : ''}" data-tab="animals">🦄 Animaux</button>
                <button class="sticker-tab ${activeStickerTab === 'geek' ? 'active' : ''}" data-tab="geek">👾 Geek & Fun</button>
                <button class="sticker-tab ${activeStickerTab === 'custom' ? 'active' : ''}" data-tab="custom">✨ Mes Stickers</button>
            </div>
            <div class="sticker-grid" id="sticker-grid"></div>
        `;

        // Add tab listeners
        const tabs = stickerPopover.querySelectorAll('.sticker-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                activeStickerTab = tab.dataset.tab;
                renderStickerPopover();
            });
        });

        // Render grid items
        const grid = stickerPopover.querySelector('#sticker-grid');
        if (grid) {
            if (activeStickerTab === 'custom') {
                // ========== INDEXEDDB STORAGE FOR STICKERS (NO SIZE LIMIT) ==========
                const DB_NAME = 'ProdigyStickerDB';
                const DB_VERSION = 1;
                const STORE_NAME = 'custom_stickers';

                function getDB() {
                    return new Promise((resolve, reject) => {
                        const request = indexedDB.open(DB_NAME, DB_VERSION);
                        request.onupgradeneeded = (e) => {
                            const db = e.target.result;
                            if (!db.objectStoreNames.contains(STORE_NAME)) {
                                db.createObjectStore(STORE_NAME, { autoIncrement: true });
                            }
                        };
                        request.onsuccess = (e) => resolve(e.target.result);
                        request.onerror = (e) => reject(e.target.error);
                    });
                }

                async function getAllCustomStickers() {
                    try {
                        const db = await getDB();
                        return new Promise((resolve, reject) => {
                            const transaction = db.transaction(STORE_NAME, 'readonly');
                            const store = transaction.objectStore(STORE_NAME);
                            const request = store.openCursor();
                            const stickers = [];
                            request.onsuccess = (e) => {
                                const cursor = e.target.result;
                                if (cursor) {
                                    stickers.push({ id: cursor.key, url: cursor.value });
                                    cursor.continue();
                                } else {
                                    resolve(stickers);
                                }
                            };
                            request.onerror = (e) => reject(e.target.error);
                        });
                    } catch (e) {
                        console.error("IndexedDB error:", e);
                        return [];
                    }
                }

                async function addCustomSticker(url) {
                    try {
                        const db = await getDB();
                        return new Promise((resolve, reject) => {
                            const transaction = db.transaction(STORE_NAME, 'readwrite');
                            const store = transaction.objectStore(STORE_NAME);
                            const request = store.add(url);
                            request.onsuccess = () => resolve();
                            request.onerror = (e) => reject(e.target.error);
                        });
                    } catch (e) {
                        console.error("IndexedDB error:", e);
                    }
                }

                async function deleteCustomStickerById(id) {
                    try {
                        const db = await getDB();
                        return new Promise((resolve, reject) => {
                            const transaction = db.transaction(STORE_NAME, 'readwrite');
                            const store = transaction.objectStore(STORE_NAME);
                            const request = store.delete(id);
                            request.onsuccess = () => resolve();
                            request.onerror = (e) => reject(e.target.error);
                        });
                    } catch (e) {
                        console.error("IndexedDB error:", e);
                    }
                }

                function showFeedbackToast(text, isError = false) {
                    const toastContainer = document.getElementById('toast-container');
                    if (!toastContainer) return;
                    const toast = document.createElement('div');
                    toast.className = 'toast';
                    toast.style.background = isError ? 'var(--error)' : 'var(--success)';
                    toast.style.color = 'white';
                    toast.style.padding = '0.75rem 1.25rem';
                    toast.style.borderRadius = '12px';
                    toast.style.boxShadow = '0 10px 20px rgba(0,0,0,0.3)';
                    toast.innerHTML = `<div class="toast-content" style="gap: 0px;"><div class="toast-text">${text}</div></div>`;
                    toast.addEventListener('click', () => toast.remove());
                    toastContainer.appendChild(toast);
                    setTimeout(() => { if (toast.parentElement) toast.remove(); }, 4000);
                }

                // Ensure upload file inputs exist
                let customStickerInput = document.getElementById('custom-sticker-input');
                if (!customStickerInput) {
                    customStickerInput = document.createElement('input');
                    customStickerInput.type = 'file';
                    customStickerInput.id = 'custom-sticker-input';
                    customStickerInput.className = 'hidden';
                    customStickerInput.multiple = true;
                    customStickerInput.accept = 'image/png, image/gif, image/jpeg, image/webp';
                    document.body.appendChild(customStickerInput);
                    customStickerInput.addEventListener('change', (e) => handleCustomStickersUpload(e.target.files));
                }

                let customStickerFolderInput = document.getElementById('custom-sticker-folder-input');
                if (!customStickerFolderInput) {
                    customStickerFolderInput = document.createElement('input');
                    customStickerFolderInput.type = 'file';
                    customStickerFolderInput.id = 'custom-sticker-folder-input';
                    customStickerFolderInput.className = 'hidden';
                    customStickerFolderInput.webkitdirectory = true;
                    customStickerFolderInput.directory = true;
                    document.body.appendChild(customStickerFolderInput);
                    customStickerFolderInput.addEventListener('change', (e) => handleCustomStickersUpload(e.target.files));
                }

                // Render "+ Fichiers" dashed button
                const addFilesBtn = document.createElement('div');
                addFilesBtn.className = 'sticker-item add-custom-sticker';
                addFilesBtn.title = 'Sélectionner plusieurs images (Max 2 Mo par fichier)';
                addFilesBtn.innerHTML = `
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                    <span style="font-size: 0.65rem; margin-top: 4px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Fichiers</span>
                `;
                addFilesBtn.addEventListener('click', () => {
                    customStickerInput.click();
                });
                grid.appendChild(addFilesBtn);

                // Render "📂 Dossier" dashed button
                const addFolderBtn = document.createElement('div');
                addFolderBtn.className = 'sticker-item add-custom-sticker';
                addFolderBtn.title = 'Importer un dossier complet de stickers';
                addFolderBtn.innerHTML = `
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                    <span style="font-size: 0.65rem; margin-top: 4px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Dossier</span>
                `;
                addFolderBtn.addEventListener('click', () => {
                    customStickerFolderInput.click();
                });
                grid.appendChild(addFolderBtn);

                // Render user custom stickers from IndexedDB
                getAllCustomStickers().then(customStickers => {
                    customStickers.forEach((sticker) => {
                        const wrapper = document.createElement('div');
                        wrapper.className = 'sticker-item-wrapper';
                        
                        const item = document.createElement('div');
                        item.className = 'sticker-item';
                        item.innerHTML = `<img src="${sticker.url}" alt="Custom Sticker" loading="lazy" referrerpolicy="no-referrer">`;
                        item.addEventListener('click', () => {
                            sendSticker(sticker.url);
                        });
                        
                        const deleteBtn = document.createElement('button');
                        deleteBtn.className = 'delete-sticker-btn';
                        deleteBtn.innerHTML = '×';
                        deleteBtn.title = 'Supprimer de ma bibliothèque';
                        deleteBtn.addEventListener('click', async (e) => {
                            e.stopPropagation();
                            await deleteCustomStickerById(sticker.id);
                            renderStickerPopover();
                        });
                        
                        wrapper.appendChild(item);
                        wrapper.appendChild(deleteBtn);
                        grid.appendChild(wrapper);
                    });
                });

                // Helper to upload files
                async function handleCustomStickersUpload(files) {
                    if (!files || files.length === 0) return;
                    
                    let loadedCount = 0;
                    let limitExceeded = false;
                    
                    if (files.length > 5) {
                        showFeedbackToast(`Importation de ${files.length} stickers en cours...`);
                    }

                    for (let i = 0; i < files.length; i++) {
                        const file = files[i];
                        if (!file.type.startsWith('image/')) continue;
                        
                        // limit to 2MB (2 * 1024 * 1024 bytes)
                        if (file.size > 2 * 1024 * 1024) {
                            limitExceeded = true;
                            continue;
                        }

                        await new Promise((resolve) => {
                            const reader = new FileReader();
                            reader.onload = async function(evt) {
                                const dataUrl = evt.target.result;
                                await addCustomSticker(dataUrl);
                                loadedCount++;
                                resolve();
                            };
                            reader.onerror = () => resolve();
                            reader.readAsDataURL(file);
                        });
                    }
                    
                    if (limitExceeded) {
                        showFeedbackToast('Certains stickers dépassaient la limite de 2 Mo et ont été ignorés.', true);
                    }
                    if (loadedCount > 0) {
                        showFeedbackToast(`${loadedCount} sticker(s) ajouté(s) à votre bibliothèque !`);
                        renderStickerPopover();
                    }
                    
                    if (customStickerInput) customStickerInput.value = '';
                    if (customStickerFolderInput) customStickerFolderInput.value = '';
                }

                // Migrate old localStorage custom stickers to IndexedDB if they exist
                const oldStickers = localStorage.getItem('prodigy_custom_stickers');
                if (oldStickers) {
                    try {
                        const array = JSON.parse(oldStickers);
                        if (Array.isArray(array) && array.length > 0) {
                            (async () => {
                                for (const url of array) {
                                    await addCustomSticker(url);
                                }
                                localStorage.removeItem('prodigy_custom_stickers');
                                renderStickerPopover();
                            })();
                        } else {
                            localStorage.removeItem('prodigy_custom_stickers');
                        }
                    } catch (err) {
                        console.error("Migration error:", err);
                    }
                }
            } else {
                const currentPack = stickerPacks[activeStickerTab] || [];
                currentPack.forEach(sticker => {
                    const item = document.createElement('div');
                    item.className = 'sticker-item';
                    item.title = sticker.name;
                    item.innerHTML = `<img src="${sticker.url}" alt="${sticker.name}" loading="lazy" referrerpolicy="no-referrer">`;
                    item.addEventListener('click', () => {
                        sendSticker(sticker.url);
                    });
                    grid.appendChild(item);
                });
            }
        }
    }

    function sendSticker(stickerUrl) {
        if (!socket || !currentRoomId) return;
        
        socket.emit('send_message', {
            roomId: currentRoomId,
            content: `[STICKER]:${stickerUrl}`
        });

        if (stickerPopover) {
            stickerPopover.style.display = 'none';
        }
    }

    // ========== PREMIUM THEME SYSTEM ==========
    const themeButtons = document.querySelectorAll('.theme-btn');
    
    function applyTheme(themeName) {
        // Remove existing theme classes from body
        document.body.classList.remove('theme-light-blue', 'theme-green', 'theme-orange');
        
        // Add the new theme class if it's not 'dark'
        if (themeName && themeName !== 'dark') {
            document.body.classList.add(`theme-${themeName}`);
        }
        
        // Save to localStorage
        localStorage.setItem('prodigy_theme', themeName);
        
        // Update active class on buttons
        themeButtons.forEach(btn => {
            if (btn.dataset.theme === themeName) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }
    
    // Initialize theme from localStorage or default to dark
    const savedTheme = localStorage.getItem('prodigy_theme') || 'dark';
    applyTheme(savedTheme);
    
    // Add click listeners to buttons
    themeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const selectedTheme = btn.dataset.theme;
            applyTheme(selectedTheme);
        });
    });

    // ==========================================
    // ============ SUPPORT & ADMIN =============
    // ==========================================

    window.deleteMessage = async function(msgId) {
        if (!confirm("Voulez-vous vraiment supprimer ce message ?")) return;
        try {
            const res = await fetch(`/api/messages/${msgId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('prodigy_token')}`
                }
            });
            const data = await res.json();
            if (!res.ok) {
                alert(data.error || "Erreur de suppression");
            }
        } catch(e) {
            alert("Erreur de communication");
        }
    };

    // Support Modal Elements
    const openSupportBtn = document.getElementById('open-support-btn');
    const closeSupportBtn = document.getElementById('close-support-btn');
    const supportModal = document.getElementById('support-modal');
    
    const supportTabNew = document.getElementById('support-tab-new');
    const supportTabHistory = document.getElementById('support-tab-history');
    const supportFormContainer = document.getElementById('support-form-container');
    const supportHistoryContainer = document.getElementById('support-history-container');
    const supportForm = document.getElementById('support-form');
    
    const supportCategory = document.getElementById('support-category');
    const supportTitle = document.getElementById('support-title');
    const supportDescription = document.getElementById('support-description');
    const myTicketsList = document.getElementById('my-tickets-list');
    const myTicketsCount = document.getElementById('my-tickets-count');

    // Admin Modal Elements
    const openAdminBtn = document.getElementById('open-admin-btn');
    const closeAdminBtn = document.getElementById('close-admin-btn');
    const adminModal = document.getElementById('admin-modal');
    
    const adminTabTickets = document.getElementById('admin-tab-tickets');
    const adminTabUsers = document.getElementById('admin-tab-users');
    const adminTabRooms = document.getElementById('admin-tab-rooms');
    
    const adminTicketsContainer = document.getElementById('admin-tickets-container');
    const adminUsersContainer = document.getElementById('admin-users-container');
    const adminRoomsContainer = document.getElementById('admin-rooms-container');
    
    const adminUsersList = document.getElementById('admin-users-list');
    const adminRoomsList = document.getElementById('admin-rooms-list');
    const adminTicketsCount = document.getElementById('admin-tickets-count');

    // Support Modal Handlers
    if (openSupportBtn) {
        openSupportBtn.addEventListener('click', () => {
            supportModal.classList.remove('hidden');
            switchSupportTab('new');
        });
    }
    
    if (closeSupportBtn) {
        closeSupportBtn.addEventListener('click', () => {
            supportModal.classList.add('hidden');
        });
    }

    if (supportTabNew) {
        supportTabNew.addEventListener('click', () => switchSupportTab('new'));
    }
    if (supportTabHistory) {
        supportTabHistory.addEventListener('click', () => {
            switchSupportTab('history');
            fetchMyTickets();
        });
    }

    function switchSupportTab(tab) {
        if (!supportTabNew || !supportTabHistory) return;
        supportTabNew.style.color = tab === 'new' ? 'var(--text-primary)' : 'var(--text-muted)';
        supportTabNew.style.borderBottom = tab === 'new' ? '2px solid var(--accent)' : 'none';
        supportTabHistory.style.color = tab === 'history' ? 'var(--text-primary)' : 'var(--text-muted)';
        supportTabHistory.style.borderBottom = tab === 'history' ? '2px solid var(--accent)' : 'none';

        if (tab === 'new') {
            supportFormContainer.classList.remove('hidden');
            supportHistoryContainer.classList.add('hidden');
        } else {
            supportFormContainer.classList.add('hidden');
            supportHistoryContainer.classList.remove('hidden');
        }
    }

    if (supportForm) {
        supportForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const category = supportCategory.value;
            const title = supportTitle.value.trim();
            const description = supportDescription.value.trim();
            
            try {
                const res = await fetch('/api/tickets', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('prodigy_token')}`
                    },
                    body: JSON.stringify({ category, title, description })
                });
                
                const data = await res.json();
                if (res.ok) {
                    showToastNotification({
                        username: 'Support System',
                        content: 'Votre plainte a été enregistrée avec succès.',
                        room_name: 'Support'
                    });
                    supportTitle.value = '';
                    supportDescription.value = '';
                    switchSupportTab('history');
                    fetchMyTickets();
                } else {
                    alert(data.error || "Erreur de soumission");
                }
            } catch(e) {
                alert("Erreur de connexion");
            }
        });
    }

    async function fetchMyTickets() {
        if (!myTicketsList || !myTicketsCount) return;
        try {
            const res = await fetch('/api/tickets', {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('prodigy_token')}`
                }
            });
            const tickets = await res.json();
            
            myTicketsCount.textContent = tickets.length;
            myTicketsList.innerHTML = '';
            
            if (tickets.length === 0) {
                myTicketsList.innerHTML = `<p style="text-align: center; color: var(--text-muted); padding: 2rem 0;">Aucune plainte soumise pour le moment.</p>`;
                return;
            }
            
            tickets.forEach(ticket => {
                const card = document.createElement('div');
                card.className = 'ticket-card';
                
                const formattedDate = new Date(ticket.timestamp).toLocaleString();
                const badgeClass = ticket.status === 'resolved' ? 'resolved' : 'pending';
                const statusLabel = ticket.status === 'resolved' ? 'Résolu' : 'En attente';
                
                let adminNoteHtml = '';
                if (ticket.status === 'resolved' && ticket.admin_note) {
                    adminNoteHtml = `
                        <div class="ticket-admin-note">
                            <strong>Réponse du Support:</strong> ${escapeHTML(ticket.admin_note)}
                        </div>
                    `;
                }
                
                card.innerHTML = `
                    <div class="ticket-header">
                        <span class="ticket-category">${escapeHTML(ticket.category)}</span>
                        <span class="ticket-badge ${badgeClass}">${statusLabel}</span>
                    </div>
                    <div style="font-weight: 600; font-size: 1rem; color: var(--text-primary);">${escapeHTML(ticket.title)}</div>
                    <div class="ticket-body">${escapeHTML(ticket.description)}</div>
                    ${adminNoteHtml}
                    <div style="font-size: 0.75rem; color: var(--text-secondary); text-align: right; margin-top: 0.25rem;">Soumis le ${formattedDate}</div>
                `;
                
                myTicketsList.appendChild(card);
            });
        } catch(e) {
            console.error(e);
        }
    }

    // Admin Modal Handlers
    if (openAdminBtn) {
        openAdminBtn.addEventListener('click', () => {
            adminModal.classList.remove('hidden');
            switchAdminTab('tickets');
            fetchAdminTickets();
        });
    }
    
    if (closeAdminBtn) {
        closeAdminBtn.addEventListener('click', () => {
            adminModal.classList.add('hidden');
        });
    }

    if (adminTabTickets) {
        adminTabTickets.addEventListener('click', () => {
            switchAdminTab('tickets');
            fetchAdminTickets();
        });
    }
    if (adminTabUsers) {
        adminTabUsers.addEventListener('click', () => {
            switchAdminTab('users');
            fetchAdminUsers();
        });
    }
    if (adminTabRooms) {
        adminTabRooms.addEventListener('click', () => {
            switchAdminTab('rooms');
            fetchAdminRooms();
        });
    }

    function switchAdminTab(tab) {
        if (!adminTabTickets || !adminTabUsers || !adminTabRooms) return;
        const borderCol = '#f97316';
        adminTabTickets.style.color = tab === 'tickets' ? 'var(--text-primary)' : 'var(--text-muted)';
        adminTabTickets.style.borderBottom = tab === 'tickets' ? `2px solid ${borderCol}` : 'none';
        adminTabUsers.style.color = tab === 'users' ? 'var(--text-primary)' : 'var(--text-muted)';
        adminTabUsers.style.borderBottom = tab === 'users' ? `2px solid ${borderCol}` : 'none';
        adminTabRooms.style.color = tab === 'rooms' ? 'var(--text-primary)' : 'var(--text-muted)';
        adminTabRooms.style.borderBottom = tab === 'rooms' ? `2px solid ${borderCol}` : 'none';

        adminTicketsContainer.classList.add('hidden');
        adminUsersContainer.classList.add('hidden');
        adminRoomsContainer.classList.add('hidden');

        if (tab === 'tickets') adminTicketsContainer.classList.remove('hidden');
        else if (tab === 'users') adminUsersContainer.classList.remove('hidden');
        else if (tab === 'rooms') adminRoomsContainer.classList.remove('hidden');
    }

    async function fetchAdminTickets() {
        if (!adminTicketsContainer || !adminTicketsCount) return;
        try {
            const res = await fetch('/api/tickets', {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('prodigy_token')}`
                }
            });
            const tickets = await res.json();
            adminTicketsCount.textContent = tickets.length;
            adminTicketsContainer.innerHTML = '';
            
            if (tickets.length === 0) {
                adminTicketsContainer.innerHTML = `<p style="text-align: center; color: var(--text-muted); padding: 3rem 0;">Aucune plainte reçue.</p>`;
                return;
            }
            
            tickets.forEach(ticket => {
                const card = document.createElement('div');
                card.className = 'ticket-card';
                
                const formattedDate = new Date(ticket.timestamp).toLocaleString();
                const badgeClass = ticket.status === 'resolved' ? 'resolved' : 'pending';
                const statusLabel = ticket.status === 'resolved' ? 'Résolu' : 'En attente';
                
                let resolveFormHtml = '';
                if (ticket.status !== 'resolved') {
                    resolveFormHtml = `
                        <div style="margin-top: 1rem; border-top: 1px solid var(--border); padding-top: 1rem; display: flex; flex-direction: column; gap: 0.5rem;">
                            <label style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);">Répondre & Résoudre</label>
                            <div style="display: flex; gap: 0.5rem;">
                                <input type="text" id="admin-note-${ticket.id}" placeholder="Note d'assistance ou résolution..." style="flex: 1; padding: 0.5rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-base); color: var(--text-primary); font-size: 0.88rem;">
                                <button onclick="window.resolveTicket(${ticket.id})" class="admin-action-btn-primary" style="padding: 0.5rem 1rem;">Résoudre</button>
                            </div>
                        </div>
                    `;
                } else {
                    resolveFormHtml = `
                        <div class="ticket-admin-note">
                            <strong>Votre réponse:</strong> ${escapeHTML(ticket.admin_note || '')}
                        </div>
                    `;
                }
                
                card.innerHTML = `
                    <div class="ticket-header">
                        <span class="ticket-category">${escapeHTML(ticket.category)} - Par <strong>${escapeHTML(ticket.username || 'Inconnu')}</strong></span>
                        <span class="ticket-badge ${badgeClass}">${statusLabel}</span>
                    </div>
                    <div style="font-weight: 600; font-size: 1rem; color: var(--text-primary);">${escapeHTML(ticket.title)}</div>
                    <div class="ticket-body">${escapeHTML(ticket.description)}</div>
                    ${resolveFormHtml}
                    <div style="font-size: 0.75rem; color: var(--text-secondary); text-align: right; margin-top: 0.25rem;">Soumis le ${formattedDate}</div>
                `;
                
                adminTicketsContainer.appendChild(card);
            });
        } catch(e) {
            console.error(e);
        }
    }

    window.resolveTicket = async function(ticketId) {
        const noteInput = document.getElementById(`admin-note-${ticketId}`);
        const adminNote = noteInput ? noteInput.value.trim() : '';
        if (!adminNote) {
            alert("Veuillez saisir une note de résolution.");
            return;
        }

        try {
            const res = await fetch(`/api/tickets/${ticketId}/resolve`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('prodigy_token')}`
                },
                body: JSON.stringify({ admin_note: adminNote })
            });
            if (res.ok) {
                fetchAdminTickets();
            } else {
                alert("Erreur de mise à jour");
            }
        } catch(e) {
            alert("Erreur serveur");
        }
    };

    async function fetchAdminUsers() {
        if (!adminUsersList) return;
        try {
            const res = await fetch('/api/admin/users', {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('prodigy_token')}`
                }
            });
            const users = await res.json();
            
            adminUsersList.innerHTML = '';
            users.forEach(u => {
                const tr = document.createElement('tr');
                const isMe = u.id === currentUser.id;
                const statusDot = u.status === 'online' ? 'online' : '';
                const roleBadge = u.role === 'admin' ? `<span style="background: rgba(249, 115, 22, 0.15); color: #f97316; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; font-weight: bold;">ADMIN</span>` : `<span style="background: rgba(255,255,255,0.05); color: var(--text-secondary); padding: 2px 6px; border-radius: 4px; font-size: 0.75rem;">MEMBRE</span>`;
                
                let actionsHtml = '-';
                if (!isMe) {
                    const nextRole = u.role === 'admin' ? 'user' : 'admin';
                    const nextRoleLabel = u.role === 'admin' ? 'Rétrograder' : 'Promouvoir Admin';
                    actionsHtml = `
                        <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                            <button onclick="window.changeUserRole(${u.id}, '${nextRole}')" class="admin-action-btn-primary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;">${nextRoleLabel}</button>
                            <button onclick="window.deleteUserAccount(${u.id})" class="admin-action-btn-danger" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;">Bannir</button>
                        </div>
                    `;
                }
                
                tr.innerHTML = `
                    <td style="padding: 0.75rem 1rem; display: flex; align-items: center; gap: 0.5rem;">
                        <span class="status-dot ${statusDot}"></span>
                        <strong>${escapeHTML(u.username)}</strong>
                    </td>
                    <td style="padding: 0.75rem 1rem;">${roleBadge}</td>
                    <td style="padding: 0.75rem 1rem; text-transform: capitalize; font-size: 0.8rem; color: var(--text-secondary);">${u.status}</td>
                    <td style="padding: 0.75rem 1rem; text-align: right;">${actionsHtml}</td>
                `;
                adminUsersList.appendChild(tr);
            });
        } catch(e) {
            console.error(e);
        }
    }

    window.changeUserRole = async function(userId, newRole) {
        if (!confirm(`Voulez-vous vraiment changer le rôle de cet utilisateur en ${newRole} ?`)) return;
        try {
            const res = await fetch(`/api/admin/users/${userId}/role`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('prodigy_token')}`
                },
                body: JSON.stringify({ role: newRole })
            });
            if (res.ok) {
                fetchAdminUsers();
            } else {
                const d = await res.json();
                alert(d.error || "Erreur lors du changement de rôle");
            }
        } catch(e) {
            alert("Erreur serveur");
        }
    };

    window.deleteUserAccount = async function(userId) {
        if (!confirm("ATTENTION ! Cela va définitivement supprimer cet utilisateur, ses messages et tous ses tickets. Continuer ?")) return;
        try {
            const res = await fetch(`/api/admin/users/${userId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('prodigy_token')}`
                }
            });
            if (res.ok) {
                fetchAdminUsers();
            } else {
                const d = await res.json();
                alert(d.error || "Erreur de suppression");
            }
        } catch(e) {
            alert("Erreur serveur");
        }
    };

    async function fetchAdminRooms() {
        if (!adminRoomsList) return;
        try {
            const res = await fetch('/api/rooms', {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('prodigy_token')}`
                }
            });
            const rooms = await res.json();
            
            adminRoomsList.innerHTML = '';
            rooms.forEach(r => {
                const tr = document.createElement('tr');
                const isGeneral = r.id === 1;
                const isLockedLabel = r.is_locked === 1 ? `<span style="color: #ef4444; font-weight: 600;">🔒 Privé</span>` : `<span style="color: #10b981; font-weight: 600;">🌐 Public</span>`;
                
                let actionHtml = '-';
                if (!isGeneral) {
                    actionHtml = `<button onclick="window.deleteRoom(${r.id})" class="admin-action-btn-danger" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;">Supprimer</button>`;
                }
                
                tr.innerHTML = `
                    <td style="padding: 0.75rem 1rem;"><strong># ${escapeHTML(r.name)}</strong></td>
                    <td style="padding: 0.75rem 1rem;">${isLockedLabel}</td>
                    <td style="padding: 0.75rem 1rem; text-align: right;">${actionHtml}</td>
                `;
                adminRoomsList.appendChild(tr);
            });
        } catch(e) {
            console.error(e);
        }
    }

    window.deleteRoom = async function(roomId) {
        if (!confirm("Voulez-vous vraiment supprimer définitivement ce canal ainsi que TOUS ses messages ?")) return;
        try {
            const res = await fetch(`/api/rooms/${roomId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('prodigy_token')}`
                }
            });
            if (res.ok) {
                fetchAdminRooms();
            } else {
                const d = await res.json();
                alert(d.error || "Erreur lors de la suppression");
            }
        } catch(e) {
            alert("Erreur serveur");
        }
    };

    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding)
            .replace(/\-/g, '+')
            .replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    async function initPushNotifications() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.log("Les notifications push ne sont pas supportées par ce navigateur.");
            return;
        }

        try {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') return;

            const registration = await navigator.serviceWorker.ready;
            
            let subscription = await registration.pushManager.getSubscription();
            
            if (!subscription) {
                // Récupérer la clé publique VAPID dynamiquement depuis le serveur pour la sécurité
                const vapidRes = await fetch('/api/push/public-key');
                const { publicKey: publicVapidKey } = await vapidRes.json();
                
                if (publicVapidKey) {
                    subscription = await registration.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
                    });
                } else {
                    console.warn("Clé VAPID publique non configurée sur le serveur.");
                    return;
                }
            }

            const token = localStorage.getItem('prodigy_token');
            if (token && subscription) {
                await fetch('/api/push/subscribe', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ subscription })
                });
            }
        } catch (error) {
            console.warn("Impossible d'enregistrer l'abonnement push:", error);
        }
    }
});
