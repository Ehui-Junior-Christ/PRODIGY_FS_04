// Service Worker pour la gestion des notifications en arrière-plan sur Mobile & Bureau
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// Écouter l'événement Push du serveur (quand l'application est FERMÉE et que l'utilisateur reçoit un message)
self.addEventListener('push', (event) => {
    if (event.data) {
        try {
            const data = event.data.json();
            const { title, options } = data;
            event.waitUntil(
                self.registration.showNotification(title, options)
            );
        } catch (e) {
            // Fallback en texte brut si les données ne sont pas au format JSON
            event.waitUntil(
                self.registration.showNotification("Prodigy Chat", {
                    body: event.data.text(),
                    icon: '/favicon.ico',
                    badge: '/favicon.ico'
                })
            );
        }
    }
});

// Écouter les messages du client pour afficher une notification locale
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
        const { title, options } = event.data;
        event.waitUntil(
            self.registration.showNotification(title, options)
        );
    }
});

// Gérer le clic sur la notification : ramener l'application au premier plan
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    
    // Essayer de trouver un onglet existant de l'application et le focusser, ou en ouvrir un nouveau
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            if (clientList.length > 0) {
                let client = clientList[0];
                for (let c of clientList) {
                    if (c.focused) {
                        client = c;
                        break;
                    }
                }
                return client.focus();
            }
            return clients.openWindow('/');
        })
    );
});
