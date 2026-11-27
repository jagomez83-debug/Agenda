// Service worker: abre la app al instante (aunque no haya señal), se actualiza
// en segundo plano y muestra los avisos que manda el programa en Python.
const VERSION = "agenda-v12";
const SDK_CACHE = "firebase-sdk-11.0.2";   // no se borra al actualizar la app
const ARCHIVOS = ["./", "index.html", "app.js", "config.js", "estilos.css", "manifest.webmanifest",
  "icon-192.png", "icon-512.png"];
const SDK = ["sdk/firebase-app.js", "sdk/firebase-auth.js", "sdk/firebase-firestore.js", "sdk/firebase-messaging.js"];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    // cache: "reload" = siempre la versión recién publicada, no una copia vieja del navegador
    await (await caches.open(VERSION)).addAll(ARCHIVOS.map((u) => new Request(u, { cache: "reload" })));
    const sdk = await caches.open(SDK_CACHE);
    for (const f of SDK) {                       // solo se descarga si no está guardado
      if (!(await sdk.match(f))) { try { await sdk.add(f); } catch { /* se guarda al usarse */ } }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== SDK_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      // Avisar a la app abierta que hay versión nueva para que se recargue sola
      .then(() => self.clients.matchAll({ type: "window" }))
      .then((cs) => cs.forEach((c) => c.postMessage({ tipo: "actualizada", version: VERSION })))
  );
});

function conLimite(req, ms) {
  return new Promise((ok, mal) => {
    const t = setTimeout(() => mal(new Error("tiempo")), ms);
    fetch(req).then((r) => { clearTimeout(t); ok(r); }, (e) => { clearTimeout(t); mal(e); });
  });
}

// Copia guardada primero (instantáneo). Si hay copia, se revisa la red en segundo plano.
async function guardadaPrimero(e, nombreCache, clave, actualizar) {
  const cache = await caches.open(nombreCache);
  const req = clave || e.request;
  const guardada = await cache.match(req, { ignoreSearch: true });
  if (guardada) {
    if (actualizar) e.waitUntil(fetch(e.request.url, { cache: "no-cache" }).then((r) => r.ok && cache.put(req, r)).catch(() => {}));
    return guardada;
  }
  try {
    const r = await conLimite(e.request, 15000);
    if (r.ok) cache.put(req, r.clone());
    return r;
  } catch {
    return (await caches.match("index.html")) || new Response("Sin conexión", { status: 503 });
  }
}

self.addEventListener("message", (e) => {
  if (e.data === "version") e.source && e.source.postMessage({ tipo: "version", version: VERSION });
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.mode === "navigate") e.respondWith(guardadaPrimero(e, VERSION, "index.html", true));
  else if (url.pathname.includes("/sdk/")) e.respondWith(guardadaPrimero(e, SDK_CACHE, null, false)); // no cambian
  else e.respondWith(guardadaPrimero(e, VERSION, null, true));
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

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) if ("focus" in c) return c.focus();
      return self.clients.openWindow("./");
    })
  );
});
