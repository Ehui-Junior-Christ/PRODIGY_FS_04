// Service Worker pour la gestion des notifications en arrière-plan et la mise en cache hors ligne PWA
const CACHE_NAME = 'prodigy-chat-cache-v1';
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/icon.svg',
    '/manifest.json'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('Mise en cache des ressources statiques...');
            return cache.addAll(ASSETS_TO_CACHE);
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Suppression de l\'ancien cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Écouter l'événement Fetch pour le support hors ligne et la conformité PWA Chrome
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Ne pas intercepter les requêtes WebSocket (Socket.io) ou API
    if (url.pathname.startsWith('/socket.io') || url.pathname.startsWith('/api')) {
        return;
    }

    // Uniquement pour les requêtes GET basiques (évite les erreurs sur POST/PUT/DELETE)
    if (event.request.method !== 'GET') {
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                // Stratégie Stale-While-Revalidate : renvoyer immédiatement la version en cache,
                // puis mettre à jour le cache en arrière-plan si le réseau est dispo.
                fetch(event.request)
                    .then((networkResponse) => {
                        if (networkResponse.status === 200) {
                            caches.open(CACHE_NAME).then((cache) => {
                                cache.put(event.request, networkResponse);
                            });
                        }
                    })
                    .catch(() => {/* Ignorer l'erreur réseau en arrière-plan */});
                return cachedResponse;
            }

            return fetch(event.request).then((networkResponse) => {
                if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                    return networkResponse;
                }

                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, responseToCache);
                });

                return networkResponse;
            });
        })
    );
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
                    icon: '/icon.svg',
                    badge: '/icon.svg'
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
