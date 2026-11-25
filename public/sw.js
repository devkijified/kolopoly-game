'use strict';
// Kolopoly service worker. It exists so the table can be installed
// and so whispers can be shown. It does not cache the game: a fresh
// deploy must land on the phone, including low-end ones.
// The server appends a kolopoly-build line when it serves this file,
// so a deploy changes these bytes even when the handlers stay quiet.
// Week stickers (event-owambe, event-nepa, event-toll, event-marina)
// and the eight player tokens ride that same build stamp.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', () => {
  // A fetch handler is required for Add to Home Screen.
  // Leaving the request alone keeps every file on the network.
});

self.addEventListener('push', (event) => {
  let data = {
    title: 'Kolopoly',
    body: 'The table has a whisper. Open your shelf.',
    tag: 'kolopoly',
    url: '/'
  };
  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') data = Object.assign(data, parsed);
    }
  } catch (e) { /* keep the fallback whisper */ }
  event.waitUntil(self.registration.showNotification(data.title || 'Kolopoly', {
    body: data.body || 'The table has a whisper. Open your shelf.',
    tag: data.tag || 'kolopoly',
    icon: '/icons/icon-192.png?v=__KOLOPOLY_BUILD__',
    badge: '/icons/icon-192.png?v=__KOLOPOLY_BUILD__',
    data: { url: data.url || '/' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      if ('focus' in client) { await client.focus(); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
