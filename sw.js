// Service worker: abre la app al instante (aunque no haya señal), se actualiza
// en segundo plano y muestra los avisos que manda el programa en Python.
const CACHE = "agenda-v7";
const ARCHIVOS = ["./", "index.html", "app.js", "config.js", "estilos.css", "manifest.webmanifest",
  "icon-192.png", "icon-512.png"];
const SDK = "https://www.gstatic.com/firebasejs/";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Pide a la red como máximo `ms` milisegundos
function conLimite(req, ms) {
  return new Promise((ok, mal) => {
    const t = setTimeout(() => mal(new Error("tiempo")), ms);
    fetch(req).then((r) => { clearTimeout(t); ok(r); }, (e) => { clearTimeout(t); mal(e); });
  });
}

// Copia guardada primero (abre al instante); en paralelo baja la versión nueva para la próxima vez.
async function guardadaPrimero(e, claveCache) {
  const cache = await caches.open(CACHE);
  const guardada = await cache.match(claveCache || e.request, { ignoreSearch: true });
  const nueva = fetch(e.request).then((r) => {
    if (r && (r.ok || r.type === "opaque")) cache.put(claveCache || e.request, r.clone());
    return r;
  }).catch(() => null);
  if (guardada) { e.waitUntil(nueva); return guardada; }
  try {
    const r = await conLimite(e.request, 8000);
    if (r) return r;
  } catch { /* sin señal */ }
  return (await cache.match("index.html")) || new Response("Sin conexión", { status: 503 });
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (e.request.mode === "navigate" && url.origin === self.location.origin) {
    e.respondWith(guardadaPrimero(e, "index.html"));
  } else if (url.origin === self.location.origin || e.request.url.startsWith(SDK)) {
    e.respondWith(guardadaPrimero(e));
  }
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
