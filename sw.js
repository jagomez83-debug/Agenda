// Service worker: permite instalar la app, abrirla sin internet y mostrar avisos.
const CACHE = "agenda-v4";
const ARCHIVOS = ["./", "index.html", "app.js", "config.js", "estilos.css", "manifest.webmanifest",
  "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Red primero (para recibir actualizaciones); si no hay internet, usa la copia guardada.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copia = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});

// Avisos que manda el programa en Python (Firebase Cloud Messaging)
self.addEventListener("push", (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { data: { body: e.data ? e.data.text() : "" } }; }
  const d = { ...(p.notification || {}), ...(p.data || {}) };
  e.waitUntil(self.registration.showNotification(d.title || "Agenda familiar", {
    body: d.body || "", tag: d.tag || undefined, icon: "icon-192.png", badge: "icon-192.png",
    vibrate: [200, 100, 200], renotify: !!d.tag
  }));
});

// Al tocar un aviso, abre (o enfoca) la app.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) if ("focus" in c) return c.focus();
      return self.clients.openWindow("./");
    })
  );
});
