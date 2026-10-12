// service-worker.js
// Estrategia "stale-while-revalidate": sirve al instante desde el cache y, en
// paralelo, baja la version nueva del servidor para la proxima apertura.
//
// RECORDATORIO DE RELEASE: bumpear CACHE (v3 -> v4 ...) en cada deploy que toque
// esquema, el worker de la DB o algo breaking. skipWaiting + clients.claim hacen
// que la version nueva tome control en el primer open (no una sesion tarde).

const CACHE = 'rienda-sheets-v1';

self.addEventListener('install', () => {
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
			await self.clients.claim();
		})()
	);
});

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== self.location.origin) return;

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);
			const cached = await cache.match(req);
			const red = fetch(req)
				.then((fresh) => {
					if (fresh && fresh.status === 200) cache.put(req, fresh.clone());
					return fresh;
				})
				.catch(() => null);
			if (cached) return cached;
			const fresh = await red;
			if (fresh) return fresh;
			return new Response('Sin conexion y sin cache para: ' + req.url, { status: 504 });
		})()
	);
});
