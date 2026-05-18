// Service Worker pour la gestion des notifications en arrière-plan sur Mobile & Bureau
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// Écouter les messages du client pour afficher une notification en arrière-plan
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
