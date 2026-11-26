// ============================================================
//  Agenda familiar — app compartida para dos personas
//  Firebase (Google Login + Firestore en tiempo real)
// ============================================================
import { initializeApp } from "./sdk/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut
} from "./sdk/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, addDoc, setDoc, updateDoc, deleteDoc, writeBatch,
  serverTimestamp, arrayUnion, arrayRemove, FieldPath
} from "./sdk/firebase-firestore.js";
// Firebase Messaging se carga solo cuando hace falta (no retrasa la apertura)
const cargarMessaging = () => import("./sdk/firebase-messaging.js");
import * as CFG from "./config.js";
const { firebaseConfig, CORREOS_PERMITIDOS, NOMBRE_APP } = CFG;
const VAPID_KEY = CFG.VAPID_KEY || "";
const pushConfigurado = VAPID_KEY && !VAPID_KEY.startsWith("PEGA");

// ---------- Tiempos de apertura (se ven en Ajustes) ----------
const T0 = performance.timeOrigin ? 0 : Date.now();
const tiempos = {};
const marcar = (k) => { if (!(k in tiempos)) tiempos[k] = Math.round(performance.now() - T0); };
marcar("código");

// ---------- Utilidades ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const fstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fparse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDias = (s, n) => { const d = fparse(s); d.setDate(d.getDate() + n); return fstr(d); };
const hoy = () => fstr(new Date());
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const correos = CORREOS_PERMITIDOS.map((c) => c.trim().toLowerCase());

function fechaBonita(s) {
  const h = hoy();
  if (s === h) return "Hoy";
  if (s === addDias(h, 1)) return "Mañana";
  if (s === addDias(h, -1)) return "Ayer";
  const d = fparse(s);
  return `${DIAS[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()].slice(0, 3)}`;
}
function fechaLarga(s) {
  const d = fparse(s);
  return `${["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"][d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`;
}
function hora12(h) {
  if (!h) return "Todo el día";
  const [H, M] = h.split(":").map(Number);
  return `${((H + 11) % 12) + 1}:${pad(M)} ${H < 12 ? "a.m." : "p.m."}`;
}

const RECORDATORIOS = [
  [0, "A la hora"], [10, "10 min antes"], [30, "30 min antes"], [60, "1 hora antes"], [120, "2 horas antes"],
  [1440, "1 día antes"], [2880, "2 días antes"], [10080, "1 semana antes"]
];
const textoRec = (m) => (RECORDATORIOS.find((r) => r[0] === m) || [m, `${m} min antes`])[1];
const REPETIR = { no: "No se repite", diario: "Cada día", semanal: "Cada semana", quincenal: "Cada 2 semanas", mensual: "Cada mes" };

const CATS_DEFAULT = [
  ["medico", "Citas médicas", "#E24B4A"],
  ["escuela", "Escuela", "#378ADD"],
  ["fiestas", "Fiestas infantiles", "#D4537E"],
  ["basquet", "Básquet", "#BA7517"],
  ["entrenamientos", "Entrenamientos", "#1D9E75"],
  ["pendientes", "Pendientes", "#888780"],
  ["otro", "Otro", "#7F77DD"]
];
const FAMILIA_DEFAULT = [
  ["hijo1", "José Angel", "#378ADD"],
  ["hijo2", "Sebastián", "#1D9E75"],
  ["hijo3", "Lynette", "#D4537E"]
];
const LISTAS_DEFAULT = [
  ["super", "Súper", "🛒", 1],
  ["pendientes", "Pendientes por hacer", "✅", 2],
  ["farmacia", "Farmacia", "💊", 3],
  ["regalos", "Regalos / fiestas", "🎁", 4]
];

// ---------- Estado ----------
let yo = null;
let miembros = {};       // uid -> {nombre, email, creado}
let categorias = [];
let familia = [];        // hijos y familiares: {nombre, color}
let eventos = [];
let listas = [];
let items = [];
let vista = "hoy";
let filtroQuien = "todos";
let filtroCat = "todas";
let filtroPara = "todos";
let sembradoFam = false;
let mesVista = new Date(); mesVista.setDate(1);
let diaSel = hoy();
let listaSel = "super";
let desuscribir = [];
let sembrado = false;
let promptInstalar = null;
let servidorUltimo = 0;   // última vez que corrió el programa en Python (ms)
let gcalFamilia = false;  // el programa copia los eventos al Google Calendar "Agenda familiar"

// ---------- Firebase ----------
const configLista = !String(firebaseConfig.apiKey).startsWith("PEGA");
let auth, db, appFb;
if (configLista) {
  const app = (appFb = initializeApp(firebaseConfig));
  auth = getAuth(app);
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.remove("oculto");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("oculto"), 2600);
}
const fallo = (e) => { console.error(e); toast("No se pudo guardar. Revisa tu conexión."); };

// ---------- Entrada ----------
const quitarCargando = () => document.getElementById("cargando")?.classList.add("oculto");

function mostrarLogin(msg) {
  quitarCargando();
  $("#pantalla-app").classList.add("oculto");
  $("#pantalla-login").classList.remove("oculto");
  $("#login-titulo").textContent = NOMBRE_APP;
  if (msg) $("#login-msg").innerHTML = msg;
}

// (La pantalla guardada de la última vez ya la muestra index.html al instante, antes de cargar esto)

if (!configLista) {
  mostrarLogin("Falta configurar Firebase. Abre <b>config.js</b> y pega los datos de tu proyecto (ver GUIA.md).");
  $("#btn-login").classList.add("oculto");
} else {
  $("#btn-login").addEventListener("click", async () => {
    const prov = new GoogleAuthProvider();
    prov.setCustomParameters({ prompt: "select_account" });
    try { await signInWithPopup(auth, prov); }
    catch (e) {
      if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(e.code)) {
        sessionStorage.setItem("redirigiendo", "1");
        signInWithRedirect(auth, prov);
      } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
        toast("No se pudo entrar: " + e.code);
      }
    }
  });
  // Solo se revisa el regreso de Google si de verdad se usó ese método (revisarlo siempre hace lenta la apertura)
  if (sessionStorage.getItem("redirigiendo")) {
    sessionStorage.removeItem("redirigiendo");
    getRedirectResult(auth).catch(() => {});
  }

  onAuthStateChanged(auth, async (u) => {
    desuscribir.forEach((f) => f()); desuscribir = [];
    marcar("sesión");
    if (!u) { yo = null; localStorage.removeItem("ultimoUsuario"); mostrarLogin("Solo para nosotros dos. Entra con tu cuenta de Google."); return; }
    const email = (u.email || "").toLowerCase();
    if (!correos.includes(email)) {
      await signOut(auth);
      mostrarLogin(`La cuenta <b>${esc(email)}</b> no tiene acceso a esta agenda.`);
      return;
    }
    yo = u;
    localStorage.setItem("ultimoUsuario", "1");
    quitarCargando();
    $("#pantalla-login").classList.add("oculto");
    $("#pantalla-app").classList.remove("oculto");
    // Registrar/actualizar mi perfil (sin pisar el apodo si ya existe)
    setDoc(doc(db, "miembros", u.uid), { email, foto: u.photoURL || "", visto: serverTimestamp() }, { merge: true }).catch(fallo);
    suscribir();
    render();
    if (pushConfigurado && "Notification" in window && Notification.permission === "granted") activarPush(true);
  });
}

function suscribir() {
  const escuchar = (col, fn) => desuscribir.push(onSnapshot(collection(db, col), (snap) => {
    fn(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    if (col === "eventos") marcar(snap.metadata.fromCache ? "datos (guardados)" : "datos (internet)");
    renderPronto();
  }, (e) => { console.error(e); toast("Sin permiso para leer datos. Revisa las reglas de Firestore."); }));

  escuchar("miembros", (arr) => {
    miembros = {};
    arr.forEach((m) => (miembros[m.id] = m));
    if (yo && miembros[yo.uid] && !miembros[yo.uid].nombre) {
      const predef = (CFG.NOMBRES || {})[(yo.email || "").toLowerCase()];
      updateDoc(doc(db, "miembros", yo.uid), { nombre: predef || (yo.displayName || yo.email).split(" ")[0] }).catch(() => {});
    }
  });
  escuchar("categorias", (arr) => {
    categorias = arr.sort((a, b) => (a.orden ?? 99) - (b.orden ?? 99));
    if (!arr.length && !sembrado) sembrar();
  });
  escuchar("familia", (arr) => {
    familia = arr.sort((a, b) => (a.orden ?? 99) - (b.orden ?? 99));
    if (!arr.length && !sembradoFam) {
      sembradoFam = true;
      const b = writeBatch(db);
      FAMILIA_DEFAULT.forEach(([id, nombre, color], i) => b.set(doc(db, "familia", id), { nombre, color, orden: i }, { merge: true }));
      b.commit().catch(fallo);
    }
  });
  escuchar("eventos", (arr) => (eventos = arr));
  desuscribir.push(onSnapshot(doc(db, "estado", "servidor"), (d) => {
    const u = d.exists() ? d.data().ultimo : null;
    servidorUltimo = u && u.toMillis ? u.toMillis() : (typeof u === "number" ? u : 0);
    gcalFamilia = d.exists() && !!d.data().gcalFamilia;
  }, () => {}));
  escuchar("listas", (arr) => (listas = arr.sort((a, b) => (a.orden ?? 99) - (b.orden ?? 99))));
  escuchar("items", (arr) => (items = arr));
}

// Crea categorías y listas iniciales la primera vez (ids fijos: no se duplican)
function sembrar() {
  sembrado = true;
  const b = writeBatch(db);
  CATS_DEFAULT.forEach(([id, nombre, color], i) => b.set(doc(db, "categorias", id), { nombre, color, orden: i }, { merge: true }));
  LISTAS_DEFAULT.forEach(([id, nombre, icono, orden]) => b.set(doc(db, "listas", id), { nombre, icono, orden }, { merge: true }));
  b.commit().catch(fallo);
}

// ---------- Miembros / avatares ----------
function miembrosOrden() {
  return Object.values(miembros).sort((a, b) => (a.email || "").localeCompare(b.email || ""));
}
function nombreDe(uid) {
  if (uid === "ambos" || !uid) return "Ambos";
  const m = miembros[uid];
  return (m && (m.nombre || m.email)) || "—";
}
function avatar(uid) {
  if (!uid || uid === "ambos") return `<span class="av ambos">Ambos</span>`;
  const i = miembrosOrden().findIndex((m) => m.id === uid);
  const n = nombreDe(uid);
  const ini = n.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  return `<span class="av p${i === 1 ? 1 : 0}" title="${esc(n)}">${esc(ini)}</span>`;
}

const fam = (id) => familia.find((f) => f.id === id);
const nombresPara = (ev) => (ev.para || []).map(fam).filter(Boolean).map((f) => f.nombre);
function etiquetasPara(ev) {
  return (ev.para || []).map(fam).filter(Boolean)
    .map((f) => `<span class="tag" style="color:${esc(f.color)};border-color:${esc(f.color)}">${esc(f.nombre)}</span>`).join("");
}
const cat = (id) => categorias.find((c) => c.id === id) || { nombre: "Sin categoría", color: "#888780" };

// ---------- Repeticiones ----------
function ocurrencias(ev, desde, hasta) {
  const out = [];
  if (!ev.fecha) return out;
  const fin = ev.repetirHasta && ev.repetirHasta < hasta ? ev.repetirHasta : hasta;
  const r = ev.repetir || "no";
  if (r === "no") { if (ev.fecha >= desde && ev.fecha <= hasta) out.push(ev.fecha); return out; }
  if (r === "mensual") {
    const base = fparse(ev.fecha), dia = base.getDate();
    for (let i = 0; i < 600; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
      const ult = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(dia, ult));
      const s = fstr(d);
      if (s > fin) break;
      if (s >= desde) out.push(s);
    }
    return out;
  }
  const paso = { diario: 1, semanal: 7, quincenal: 14 }[r] || 7;
  let s = ev.fecha;
  if (s < desde) {
    const diff = Math.round((fparse(desde) - fparse(s)) / 86400000);
    s = addDias(s, Math.floor(diff / paso) * paso);
  }
  for (let i = 0; i < 1500 && s <= fin; i++) { if (s >= desde) out.push(s); s = addDias(s, paso); }
  return out;
}
function rango(desde, hasta) {
  const out = [];
  for (const ev of eventos) {
    if (ev.oculto) continue; // evento de Google Calendar que ocultaron en la app
    for (const f of ocurrencias(ev, desde, hasta)) {
      if ((ev.omitidas || []).includes(f)) continue;
      out.push({ ev, fecha: f });
    }
  }
  return out.sort((a, b) => (a.fecha + (a.ev.hora || "00:00")).localeCompare(b.fecha + (b.ev.hora || "00:00")));
}
const esHecho = (o) => (o.ev.hechos || []).includes(o.fecha);
function filtrar(arr) {
  return arr.filter((o) =>
    (filtroQuien === "todos" || o.ev.quien === "ambos" || o.ev.quien === filtroQuien) &&
    (filtroCat === "todas" || o.ev.categoriaId === filtroCat) &&
    (filtroPara === "todos" || (o.ev.para || []).includes(filtroPara)));
}
function momento(o) {
  const [H, M] = (o.ev.hora || "09:00").split(":").map(Number);
  const d = fparse(o.fecha); d.setHours(H, M, 0, 0); return d;
}

// ---------- Render ----------
let renderPendiente = false;
function renderPronto() {
  if (renderPendiente) return;
  renderPendiente = true;
  requestAnimationFrame(() => { renderPendiente = false; render(); marcar("pantalla"); });
}

// Redibuja la vista sin perder lo que estás escribiendo (llegan cambios de la otra persona en tiempo real)
function render() {
  if (!yo) return;
  document.body.classList.remove("foto");
  const v = $("#vista");
  const a = document.activeElement;
  let clave = null, valor = "";
  if (a && v.contains(a) && a.matches("input:not([type=checkbox]), textarea, select")) {
    clave = a.name ? `[name="${a.name}"]` : a.id ? `#${a.id}`
      : [...a.attributes].filter((x) => x.name.startsWith("data-")).map((x) => `[${x.name}="${x.value}"]`).join("");
    valor = a.value;
  }
  const extra = { f: $("#item-fecha")?.value, q: $("#item-quien")?.value, abierto: v.querySelector("details")?.open };
  pintar(v);
  if (extra.f !== undefined && $("#item-fecha")) $("#item-fecha").value = extra.f;
  if (extra.q !== undefined && $("#item-quien")) $("#item-quien").value = extra.q;
  if (extra.abierto && v.querySelector("details")) v.querySelector("details").open = true;
  if (clave) { const n = v.querySelector(clave); if (n) { n.value = valor; n.focus(); } }
}

function pintar(v) {
  { const f = fechaLarga(hoy()); $("#cab-fecha").textContent = f[0].toUpperCase() + f.slice(1); }
  $("#cab-avatares").innerHTML = miembrosOrden().map((m) => avatar(m.id)).join("");
  document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("activo", b.dataset.nav === vista));
  const titulos = { hoy: "Hoy y próximos días", calendario: "Calendario", listas: "Listas", ajustes: "Ajustes" };
  $("#cab-titulo").textContent = titulos[vista] || "";
  if (vista === "hoy") {
    v.innerHTML = vistaHoy();
    try { localStorage.setItem("fotoHoy", JSON.stringify({ dia: hoy(), html: v.innerHTML, av: $("#cab-avatares").innerHTML })); } catch { /* sin espacio */ }
  }
  else if (vista === "calendario") v.innerHTML = vistaCalendario();
  else if (vista === "listas") v.innerHTML = vistaListas();
  else if (vista === "ajustes") v.innerHTML = vistaAjustes();
}

function chipsFiltro() {
  const ms = miembrosOrden();
  let html = `<div class="chips">`;
  html += `<button class="chip ${filtroQuien === "todos" ? "activo" : ""}" data-filtro-quien="todos">Todos</button>`;
  ms.forEach((m) => {
    html += `<button class="chip ${filtroQuien === m.id ? "activo" : ""}" data-filtro-quien="${m.id}">${m.id === yo.uid ? "Míos" : "De " + esc(m.nombre || m.email)}</button>`;
  });
  if (familia.length) {
    html += `</div><div class="chips"><button class="chip ${filtroPara === "todos" ? "activo" : ""}" data-filtro-para="todos">Toda la familia</button>`;
    familia.forEach((f) => {
      html += `<button class="chip ${filtroPara === f.id ? "activo" : ""}" data-filtro-para="${f.id}"><span class="punto" style="background:${esc(f.color)}"></span>${esc(f.nombre)}</button>`;
    });
  }
  html += `</div><div class="chips"><button class="chip ${filtroCat === "todas" ? "activo" : ""}" data-filtro-cat="todas">Todas</button>`;
  categorias.forEach((c) => {
    html += `<button class="chip ${filtroCat === c.id ? "activo" : ""}" data-filtro-cat="${c.id}"><span class="punto" style="background:${esc(c.color)}"></span>${esc(c.nombre)}</button>`;
  });
  return html + `</div>`;
}

function tarjeta(o, conFecha) {
  const ev = o.ev, c = cat(ev.categoriaId);
  const llevar = ev.llevar || [];
  const ok = ((ev.checks || {})[o.fecha] || []).length;
  const partes = [];
  if (conFecha) partes.push(fechaBonita(o.fecha));
  partes.push(hora12(ev.hora));
  if (ev.lugar) partes.push(esc(ev.lugar));
  if (llevar.length) partes.push(`Llevar ${ok}/${llevar.length}`);
  let iconos = "";
  if ((ev.recordatorios || []).length) iconos += " 🔔";
  if (ev.repetir && ev.repetir !== "no") iconos += " ↻";
  if ((ev.origen || "").startsWith("gcal")) iconos += " 📆";
  return `<button class="card ${esHecho(o) ? "hecho" : ""}" data-ev="${ev.id}" data-f="${o.fecha}">
    <span class="barra" style="background:${esc(c.color)}"></span>
    <span class="cuerpo">${(ev.para || []).length ? `<span class="tags">${etiquetasPara(ev)}</span>` : ""}<span class="t">${esc(ev.titulo)}</span><span class="s">${partes.join(" · ")}${iconos}</span></span>
    ${avatar(ev.quien)}</button>`;
}

function proximosAvisos() {
  const ahora = Date.now(), lim = ahora + 24 * 3600e3, out = [];
  for (const o of rango(hoy(), addDias(hoy(), 8))) {
    if (esHecho(o)) continue;
    for (const m of o.ev.recordatorios || []) {
      const t = momento(o).getTime() - m * 60000;
      if (t >= ahora - 3600e3 && t <= lim) out.push({ o, t, m });
    }
  }
  return out.sort((a, b) => a.t - b.t).slice(0, 4);
}

function vistaHoy() {
  const h = hoy();
  const todos = filtrar(rango(addDias(h, -14), addDias(h, 14)));
  const atrasados = todos.filter((o) => o.fecha < h && !esHecho(o) && (o.ev.repetir || "no") === "no");
  const deHoy = todos.filter((o) => o.fecha === h);
  const manana = todos.filter((o) => o.fecha === addDias(h, 1));
  const prox = todos.filter((o) => o.fecha > addDias(h, 1));
  let html = chipsFiltro();

  const av = proximosAvisos();
  if (av.length) {
    html += av.map(({ o, t, m }) => {
      const d = new Date(t);
      return `<div class="aviso">🔔 <b>${esc(o.ev.titulo)}</b> — ${fechaBonita(o.fecha)} ${hora12(o.ev.hora)}<br><small>Aviso ${textoRec(m).toLowerCase()} (${pad(d.getHours())}:${pad(d.getMinutes())})</small></div>`;
    }).join("");
  }
  if (atrasados.length) html += `<p class="seccion">Pendientes atrasados</p>` + atrasados.map((o) => tarjeta(o, true)).join("");
  html += `<p class="seccion">Hoy</p>` + (deHoy.length ? deHoy.map((o) => tarjeta(o)).join("") : `<p class="vacio">Nada para hoy.</p>`);
  html += `<p class="seccion">Mañana</p>` + (manana.length ? manana.map((o) => tarjeta(o)).join("") : `<p class="vacio">Nada para mañana.</p>`);
  if (prox.length) html += `<p class="seccion">Próximas 2 semanas</p>` + prox.map((o) => tarjeta(o, true)).join("");

  // Pendientes de las listas con fecha cercana
  const pend = items.filter((i) => !i.hecho && i.fecha && i.fecha <= addDias(h, 7))
    .filter((i) => filtroQuien === "todos" || !i.quien || i.quien === "ambos" || i.quien === filtroQuien)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  if (pend.length) {
    html += `<p class="seccion">Pendientes con fecha</p><div class="caja">` + pend.map(itemHtml).join("") + `</div>`;
  }
  const sup = items.filter((i) => i.listaId === "super" && !i.hecho).length;
  if (sup) html += `<button class="caja" style="width:100%;text-align:left" data-ir-lista="super">🛒 <b>Súper:</b> ${sup} cosa${sup === 1 ? "" : "s"} por comprar ›</button>`;
  return html;
}

function vistaCalendario() {
  const y = mesVista.getFullYear(), m = mesVista.getMonth();
  const primero = new Date(y, m, 1);
  const offset = (primero.getDay() + 6) % 7; // lunes primero
  const inicio = new Date(y, m, 1 - offset);
  const desde = fstr(inicio), hasta = addDias(desde, 41);
  const occ = filtrar(rango(desde, hasta));
  const porDia = {};
  occ.forEach((o) => (porDia[o.fecha] = porDia[o.fecha] || []).push(o));
  let html = chipsFiltro();
  html += `<div class="mes-cab"><button class="btn chico" data-mes="-1">‹</button><h2>${MESES[m]} ${y}</h2><button class="btn chico" data-mes="1">›</button></div>`;
  html += `<div class="mes">` + ["L", "M", "M", "J", "V", "S", "D"].map((d) => `<div class="dn">${d}</div>`).join("");
  for (let i = 0; i < 42; i++) {
    const f = addDias(desde, i), d = fparse(f);
    const lista = porDia[f] || [];
    const puntos = lista.slice(0, 4).map((o) => `<i style="background:${esc(cat(o.ev.categoriaId).color)}"></i>`).join("");
    html += `<button class="dia ${d.getMonth() !== m ? "fuera" : ""} ${f === hoy() ? "hoy" : ""} ${f === diaSel ? "sel" : ""}" data-dia="${f}">${d.getDate()}<span class="puntos">${puntos}</span></button>`;
  }
  html += `</div>`;
  const sel = porDia[diaSel] || filtrar(rango(diaSel, diaSel));
  html += `<p class="seccion">${fechaLarga(diaSel)}</p>`;
  html += sel.length ? sel.map((o) => tarjeta(o)).join("") : `<p class="vacio">Sin eventos.</p>`;
  html += `<button class="btn grande" data-nuevo-en="${diaSel}">＋ Agregar en este día</button>`;
  return html;
}

function itemHtml(i) {
  const sub = [];
  if (i.cantidad) sub.push(esc(i.cantidad));
  if (i.fecha) sub.push(fechaBonita(i.fecha));
  if (i.quien) sub.push(i.quien === "ambos" ? "Ambos" : esc(nombreDe(i.quien)));
  return `<div class="item ${i.hecho ? "hecho" : ""}">
    <input type="checkbox" data-item-check="${i.id}" ${i.hecho ? "checked" : ""} aria-label="Marcar">
    <div class="txt"><span>${esc(i.texto)}</span>${sub.length ? `<small>${sub.join(" · ")}</small>` : ""}</div>
    <button class="x" data-item-borrar="${i.id}" aria-label="Borrar">×</button></div>`;
}

function opcionesQuien(sel) {
  return `<option value="">— Nadie en particular —</option>` +
    miembrosOrden().map((m) => `<option value="${m.id}" ${sel === m.id ? "selected" : ""}>${esc(m.nombre || m.email)}</option>`).join("") +
    `<option value="ambos" ${sel === "ambos" ? "selected" : ""}>Ambos</option>`;
}

function vistaListas() {
  if (!listas.find((l) => l.id === listaSel) && listas.length) listaSel = listas[0].id;
  let html = `<div class="chips">` + listas.map((l) => {
    const n = items.filter((i) => i.listaId === l.id && !i.hecho).length;
    return `<button class="chip ${l.id === listaSel ? "activo" : ""}" data-lista="${l.id}">${esc(l.icono || "")} ${esc(l.nombre)}${n ? ` (${n})` : ""}</button>`;
  }).join("") + `<button class="chip" data-accion="nueva-lista">＋ Lista</button></div>`;
  const l = listas.find((x) => x.id === listaSel);
  if (!l) return html + `<p class="vacio">Crea tu primera lista.</p>`;
  const conDetalles = l.id !== "super" && l.id !== "farmacia";
  html += `<form class="agregar-fila" data-form="item"><input name="texto" placeholder="${l.id === "super" ? "Ej. Leche, huevos…" : "Ej. Llevar ropa a planchar"}" autocomplete="off" required><button class="btn primario">Agregar</button></form>`;
  if (conDetalles) {
    html += `<details class="caja" style="padding:8px 12px"><summary style="font-size:14px;color:var(--texto2)">Opciones: fecha límite y quién</summary>
      <div class="dos" style="margin-top:8px"><div><span class="etq">Fecha</span><input type="date" id="item-fecha"></div>
      <div><span class="etq">Quién</span><select id="item-quien">${opcionesQuien("")}</select></div></div></details>`;
  } else {
    html += `<p class="vacio" style="margin-top:-4px">Tip: escribe "2 kg tortillas" — o separa varias con comas.</p>`;
  }
  const its = items.filter((i) => i.listaId === l.id)
    .sort((a, b) => (a.hecho - b.hecho) || (a.fecha || "9999").localeCompare(b.fecha || "9999") || (a.creadoMs || 0) - (b.creadoMs || 0));
  html += `<div class="caja">` + (its.length ? its.map(itemHtml).join("") : `<p class="vacio">Lista vacía.</p>`) + `</div>`;
  if (its.some((i) => i.hecho)) html += `<div class="fila-btns"><button class="btn" data-accion="limpiar-hechos">Quitar marcados</button>`;
  else html += `<div class="fila-btns">`;
  html += `<button class="btn" data-accion="compartir-lista">Copiar lista</button>`;
  if (!LISTAS_DEFAULT.some(([id]) => id === l.id)) html += `<button class="btn peligro" data-accion="borrar-lista">Borrar lista</button>`;
  html += `</div>`;
  return html;
}

function vistaAjustes() {
  const yoM = miembros[yo.uid] || {};
  const perm = "Notification" in window ? Notification.permission : "no";
  const pref = localStorage.getItem("avisosDe") || "todo";
  let html = `<p class="seccion">Mi perfil</p><div class="caja">
    <span class="etq">Mi nombre en la app</span>
    <form class="agregar-fila" data-form="apodo"><input name="nombre" value="${esc(yoM.nombre || "")}" placeholder="Ej. Mamá"><button class="btn">Guardar</button></form>
    <p class="vacio" style="margin:0">${esc(yo.email)}</p></div>`;

  html += `<p class="seccion">Quiénes tienen acceso</p><div class="caja">` +
    correos.map((c) => {
      const m = Object.values(miembros).find((x) => x.email === c);
      return `<div class="item">${m ? avatar(m.id) : `<span class="av ambos">—</span>`}<div class="txt"><span>${m ? esc(m.nombre || c) : "Aún no entra"}</span><small>${esc(c)}</small></div></div>`;
    }).join("") + `<p class="vacio" style="margin:6px 0 0">Nadie más puede abrir la agenda aunque tenga el enlace.</p></div>`;

  html += `<p class="seccion">Recordatorios</p><div class="caja">`;
  if (perm === "granted") html += localStorage.getItem("pushToken")
    ? `<p style="margin:0 0 8px">✅ Avisos activados en este teléfono, también con la pantalla bloqueada.</p>`
    : `<p style="margin:0 0 8px">✅ Avisos activados mientras la app está abierta.${pushConfigurado ? ` <button class="btn chico" data-accion="reintentar-push">Activar con pantalla bloqueada</button>` : ""}</p>`;
  else if (perm === "denied") html += `<p style="margin:0 0 8px">Los avisos están bloqueados. Actívalos en Ajustes de Android → Apps → Chrome/Agenda → Notificaciones.</p>`;
  else if (perm === "no") html += `<p style="margin:0 0 8px">Este navegador no permite avisos.</p>`;
  else html += `<button class="btn primario grande" data-accion="activar-avisos">Activar avisos en este teléfono</button>`;
  html += `<div class="campo" style="margin-top:10px"><span class="etq">Avisarme de</span>
    <select data-pref-avisos><option value="todo" ${pref === "todo" ? "selected" : ""}>Todos los eventos</option>
    <option value="mio" ${pref === "mio" ? "selected" : ""}>Solo los míos y los de ambos</option></select></div>
    <p class="vacio" style="margin:0">${pushConfigurado
      ? (Date.now() - servidorUltimo < 40 * 60000
        ? "🟢 El programa de avisos está activo: revisa cada 10 minutos y te avisa aunque la app esté cerrada. Los domingos a las 7 p.m. llega el resumen de la semana." +
          (gcalFamilia ? " Todo lo que agreguen aquí se copia solo al Google Calendar “Agenda familiar”." : "")
        : "⚪ El programa de avisos aún no está activo. Mientras tanto, los avisos salen cuando la app está abierta.")
      : "Los avisos salen cuando la app está abierta. Para una alarma garantizada usa <b>“Añadir a Google Calendar”</b> en cada evento."}</p></div>`;

  html += `<p class="seccion">Familia (para quién es cada actividad)</p><div class="caja">` + familia.map((f) => `
    <div class="item"><input type="color" value="${esc(f.color)}" data-fam-color="${f.id}" aria-label="Color">
    <input value="${esc(f.nombre)}" data-fam-nombre="${f.id}" aria-label="Nombre">
    <button class="x" data-fam-borrar="${f.id}" aria-label="Quitar">×</button></div>`).join("") +
    `<form class="agregar-fila" data-form="familia" style="margin:10px 0 0"><input name="nombreFam" placeholder="Agregar (ej. Abuela Rosa)" required><button class="btn">Agregar</button></form>
    <p class="vacio" style="margin:6px 0 0">Puedes cambiar nombres y colores, o agregar familiares (abuelos, tíos…).</p></div>`;

  html += `<p class="seccion">Categorías</p><div class="caja">` + categorias.map((c) => `
    <div class="item"><input type="color" value="${esc(c.color)}" data-cat-color="${c.id}" aria-label="Color">
    <input value="${esc(c.nombre)}" data-cat-nombre="${c.id}" aria-label="Nombre">
    <button class="x" data-cat-borrar="${c.id}" aria-label="Borrar">×</button></div>`).join("") +
    `<form class="agregar-fila" data-form="categoria" style="margin:10px 0 0"><input name="nombreCat" placeholder="Nueva categoría (ej. Natación)" required><button class="btn">Agregar</button></form></div>`;

  const tt = Object.entries(tiempos).map(([k, v]) => `${k}: ${(v / 1000).toFixed(1)} s`).join(" · ");
  if (tt) html += `<p class="vacio" style="font-size:12px">Apertura de hoy — ${tt}</p>`;
  html += `<div class="fila-btns">`;
  if (promptInstalar) html += `<button class="btn primario" data-accion="instalar">Instalar app</button>`;
  html += `<button class="btn" data-accion="salir">Cerrar sesión</button></div>`;
  return html;
}

// ---------- Hoja inferior ----------
function abrirHoja(html) {
  $("#hoja").innerHTML = `<div class="agarre"></div><button class="x" data-accion="cerrar" aria-label="Cerrar" style="position:absolute;right:8px;top:8px;font-size:24px">×</button>` + html;
  $("#hoja").classList.remove("oculto"); $("#velo").classList.remove("oculto");
  $("#hoja").scrollTop = 0;
}
function cerrarHoja() { $("#hoja").classList.add("oculto"); $("#velo").classList.add("oculto"); $("#hoja").innerHTML = ""; }
$("#velo").addEventListener("click", cerrarHoja);

// Opciones rápidas por categoría (se suman los títulos que más usan)
const RAPIDOS = {
  medico: ["Pediatra", "Dentista", "Vacuna", "Análisis de laboratorio", "Oftalmólogo"],
  escuela: ["Junta de padres", "Entrega de boletas", "Festival", "Tarea / proyecto", "Excursión"],
  fiestas: ["Fiesta de cumpleaños", "Comprar regalo", "Posada"],
  basquet: ["Partido de básquet", "Entrenamiento de básquet", "Torneo"],
  entrenamientos: ["Entrenamiento", "Natación", "Fútbol", "Clase de baile"],
  pendientes: ["Llevar ropa a planchar", "Recoger ropa", "Pagar colegiatura", "Pagar servicios"],
  otro: []
};
const LLEVAR_RAPIDO = {
  medico: ["Cartilla de vacunación", "Credencial / seguro", "Estudios anteriores"],
  escuela: ["Boleta", "Credencial", "Material", "Disfraz"],
  fiestas: ["Regalo", "Tarjeta", "Ropa de cambio"],
  basquet: ["Uniforme", "Tenis", "Agua", "Balón", "Toalla"],
  entrenamientos: ["Ropa deportiva", "Agua", "Toalla", "Snack"],
  pendientes: ["Ropa", "Comprobante", "Dinero"],
  otro: []
};
const HORAS_RAPIDAS = ["08:00", "09:00", "10:00", "12:00", "16:00", "17:00", "18:00", "19:00"];

function titulosRapidos(catId) {
  const base = RAPIDOS[catId] || [];
  const conteo = {};
  eventos.filter((e) => e.categoriaId === catId && e.titulo).forEach((e) => (conteo[e.titulo] = (conteo[e.titulo] || 0) + 1));
  const usados = Object.keys(conteo).filter((t) => !base.includes(t)).sort((a, b) => conteo[b] - conteo[a]).slice(0, 4);
  return [...usados, ...base];
}
const chipBtn = (attr, val, texto, activo, color) =>
  `<button type="button" class="chip ${activo ? "activo" : ""}" ${attr}="${esc(val)}">${color ? `<span class="punto" style="background:${esc(color)}"></span>` : ""}${esc(texto)}</button>`;

function pintarRapidos() {
  const f = $("#hoja form[data-form=evento]"); if (!f) return;
  const catId = f.categoriaId.value, titulo = f.titulo.value;
  $("#rapidos").innerHTML = titulosRapidos(catId).map((t) => chipBtn("data-pick-titulo", t, t, t === titulo)).join("") +
    `<button type="button" class="chip" data-pick-titulo="__otro">✏️ Otro</button>`;
  const llevar = f.llevar.value.split("\n").map((x) => x.trim());
  $("#llevar-rapido").innerHTML = (LLEVAR_RAPIDO[catId] || []).map((t) => chipBtn("data-pick-llevar", t, "＋ " + t, llevar.includes(t))).join("");
}

function formEvento(ev = {}, fechaDefault) {
  const recs = ev.recordatorios || (ev.id ? [] : [60, 1440]);
  const cats = categorias.length ? categorias : CATS_DEFAULT.map(([id, nombre, color]) => ({ id, nombre, color }));
  const catSel = ev.categoriaId || cats[0].id;
  const fecha = ev.fecha || fechaDefault || hoy();
  const hora = ev.hora || "";
  const quien = ev.quien ?? "ambos";
  const rep = ev.repetir || "no";
  const quienes = [...miembrosOrden().map((m) => [m.id, m.nombre || m.email]), ["ambos", "Ambos"], ["", "Nadie en particular"]];
  abrirHoja(`<h2>${ev.id ? "Editar" : "Nuevo evento"}</h2>
  ${(ev.origen || "").startsWith("gcal") ? `<p class="aviso">📆 Viene de Google Calendar: si cambias título, fecha u hora aquí, se volverán a poner como estén en Google. Cámbialos allá.</p>` : ""}
  <form data-form="evento" data-id="${ev.id || ""}" novalidate>
    <div class="campo"><span class="etq">Categoría</span><input type="hidden" name="categoriaId" value="${esc(catSel)}">
      <div class="chips envolver" data-grupo="categoriaId">${cats.map((c) => chipBtn("data-pick", c.id, c.nombre, c.id === catSel, c.color)).join("")}</div></div>

    <div class="campo"><span class="etq">¿Qué es?</span>
      <div class="chips envolver" id="rapidos"></div>
      <div id="box-titulo" class="${ev.titulo ? "" : "oculto"}"><input name="titulo" value="${esc(ev.titulo || "")}" placeholder="Escribe qué es (ej. Pediatra — vacuna)" autocomplete="off"></div></div>

    ${familia.length ? `<div class="campo"><span class="etq">¿Para quién es?</span><div class="chips envolver">
      ${familia.map((f) => `<label class="chip" style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="para" value="${f.id}" ${(ev.para || []).includes(f.id) ? "checked" : ""} style="width:16px;height:16px;accent-color:${esc(f.color)}"><span class="punto" style="background:${esc(f.color)}"></span>${esc(f.nombre)}</label>`).join("")}
    </div><p class="vacio" style="margin:0;padding:0">Puedes marcar varios. Sin marcar = de los papás / general.</p></div>` : ""}

    <div class="campo"><span class="etq">Fecha</span>
      <div class="chips envolver" data-grupo="fecha">${[[hoy(), "Hoy"], [addDias(hoy(), 1), "Mañana"], [addDias(hoy(), 2), fechaBonita(addDias(hoy(), 2))]]
        .map(([v, t]) => chipBtn("data-pick", v, t, v === fecha)).join("")}</div>
      <input type="date" name="fecha" value="${esc(fecha)}"></div>

    <div class="campo"><span class="etq">Hora</span><input type="hidden" name="hora" value="${esc(hora)}">
      <div class="chips envolver" data-grupo="hora">${chipBtn("data-pick", "", "Todo el día", !hora)}${HORAS_RAPIDAS.map((h) => chipBtn("data-pick", h, hora12(h).replace(":00", ""), h === hora)).join("")}
      ${chipBtn("data-pick", "__otra", hora && !HORAS_RAPIDAS.includes(hora) ? "🕐 " + hora12(hora) : "🕐 Otra hora", hora && !HORAS_RAPIDAS.includes(hora))}</div>
      <input type="time" id="hora-otra" class="${hora && !HORAS_RAPIDAS.includes(hora) ? "" : "oculto"}" value="${esc(hora)}"></div>

    <div class="campo"><span class="etq">¿Quién se encarga?</span><input type="hidden" name="quien" value="${esc(quien)}">
      <div class="chips envolver" data-grupo="quien">${quienes.map(([v, t]) => chipBtn("data-pick", v, t, v === quien)).join("")}</div></div>

    <div class="campo"><label>Lugar</label><input name="lugar" value="${esc(ev.lugar || "")}" placeholder="Ej. Clínica del Valle, cancha 2"></div>

    <div class="campo"><span class="etq">Qué llevar</span>
      <div class="chips envolver" id="llevar-rapido"></div>
      <textarea name="llevar" placeholder="Uno por renglón">${esc((ev.llevar || []).join("\n"))}</textarea></div>

    <div class="campo"><span class="etq">Se repite</span><input type="hidden" name="repetir" value="${esc(rep)}">
      <div class="chips envolver" data-grupo="repetir">${Object.entries(REPETIR).map(([k, v]) => chipBtn("data-pick", k, v, k === rep)).join("")}</div>
      <div id="box-hasta" class="${rep === "no" ? "oculto" : ""}"><span class="etq">Hasta (opcional)</span><input type="date" name="repetirHasta" value="${esc(ev.repetirHasta || "")}"></div></div>

    <div class="campo"><span class="etq">Recordatorios</span><div class="chips envolver">
      ${RECORDATORIOS.map(([m, t]) => `<label class="chip" style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="rec" value="${m}" ${recs.includes(m) ? "checked" : ""} style="width:16px;height:16px">${t}</label>`).join("")}
    </div></div>
    <div class="campo"><label>Notas</label><textarea name="notas" placeholder="Ej. Ir en ayunas, pagar $350">${esc(ev.notas || "")}</textarea></div>
    <div class="fila-btns"><button type="button" class="btn" data-accion="cerrar">Cancelar</button><button class="btn primario">Guardar</button></div>
  </form>`);
  pintarRapidos();
}

// Botones rápidos del formulario
function elegirRapido(t) {
  const f = $("#hoja form[data-form=evento]"); if (!f) return false;
  const d = t.dataset;
  if (d.pickTitulo !== undefined) {
    const box = $("#box-titulo");
    box.classList.remove("oculto");
    if (d.pickTitulo === "__otro") { f.titulo.value = ""; f.titulo.focus(); }
    else f.titulo.value = d.pickTitulo;
    pintarRapidos(); return true;
  }
  if (d.pickLlevar !== undefined) {
    const lineas = f.llevar.value.split("\n").map((x) => x.trim()).filter(Boolean);
    const i = lineas.indexOf(d.pickLlevar);
    if (i >= 0) lineas.splice(i, 1); else lineas.push(d.pickLlevar);
    f.llevar.value = lineas.join("\n"); pintarRapidos(); return true;
  }
  if (d.pick !== undefined) {
    const grupo = t.closest("[data-grupo]").dataset.grupo;
    if (grupo === "hora" && d.pick === "__otra") {
      const h = $("#hora-otra"); h.classList.remove("oculto"); h.focus(); try { h.showPicker(); } catch { /* sin selector */ }
    } else {
      f[grupo].value = d.pick;
      if (grupo === "hora") $("#hora-otra").classList.add("oculto");
    }
    t.closest("[data-grupo]").querySelectorAll(".chip").forEach((c) => c.classList.toggle("activo", c === t));
    if (grupo === "categoriaId") pintarRapidos();
    if (grupo === "repetir") $("#box-hasta").classList.toggle("oculto", d.pick === "no");
    return true;
  }
  return false;
}

function detalleEvento(id, fecha) {
  const ev = eventos.find((e) => e.id === id); if (!ev) return;
  const c = cat(ev.categoriaId), o = { ev, fecha };
  const checks = (ev.checks || {})[fecha] || [];
  const llevar = ev.llevar || [];
  abrirHoja(`<p style="margin:0;font-size:13px;color:${esc(c.color)};font-weight:600">${esc(c.nombre)}</p>
    <h2>${esc(ev.titulo)}</h2>
    ${(ev.para || []).length ? `<p class="det-linea">🧒 Para: ${etiquetasPara(ev)}</p>` : ""}
    <p class="det-linea">📅 ${fechaLarga(fecha)} · ${hora12(ev.hora)}</p>
    ${ev.lugar ? `<p class="det-linea">📍 ${esc(ev.lugar)}</p>` : ""}
    <p class="det-linea">👤 ${esc(nombreDe(ev.quien || "ambos"))}</p>
    ${ev.repetir && ev.repetir !== "no" ? `<p class="det-linea">↻ ${REPETIR[ev.repetir]}${ev.repetirHasta ? " hasta " + fechaBonita(ev.repetirHasta) : ""}</p>` : ""}
    ${(ev.recordatorios || []).length ? `<p class="det-linea">🔔 ${(ev.recordatorios || []).slice().sort((a, b) => b - a).map(textoRec).join(", ")}</p>` : ""}
    ${ev.notas ? `<p class="det-linea" style="white-space:pre-wrap">📝 ${esc(ev.notas)}</p>` : ""}
    ${llevar.length ? `<p class="seccion">Qué llevar</p><div class="caja">${llevar.map((t, i) => `<label class="item"><input type="checkbox" data-llevar="${i}" data-ev="${ev.id}" data-f="${fecha}" ${checks.includes(i) ? "checked" : ""}><div class="txt"><span>${esc(t)}</span></div></label>`).join("")}</div>` : ""}
    <div class="fila-btns">
      <button class="btn ${esHecho(o) ? "" : "primario"}" data-accion="hecho" data-ev="${ev.id}" data-f="${fecha}">${esHecho(o) ? "Desmarcar" : "✓ Marcar como hecho"}</button>
    </div>
    ${(ev.origen || "").startsWith("gcal")
      ? `<p class="aviso" style="margin-top:12px">📆 Viene del Google Calendar de ${ev.origen === "gcal-mama" ? "Mamá" : "Papá"}. El título, la fecha y la hora se cambian allá. Aquí puedes marcar para quién es, qué llevar y los avisos.</p>`
      : gcalFamilia
        ? `<p class="vacio" style="margin-top:12px">📆 Se copia solo al calendario “Agenda familiar” de Google (en máximo 10 minutos).</p>`
        : `<div class="fila-btns">
      <a class="btn" style="text-align:center;text-decoration:none" href="${urlGoogleCal(ev, fecha)}" target="_blank" rel="noopener">Añadir a Google Calendar</a>
    </div>`}
    <div class="fila-btns">
      <button class="btn" data-accion="editar" data-ev="${ev.id}">Editar</button>
      <button class="btn" data-accion="duplicar" data-ev="${ev.id}">Duplicar</button>
      <button class="btn peligro" data-accion="borrar-ev" data-ev="${ev.id}" data-f="${fecha}">Borrar</button>
    </div>
    <p class="vacio" style="margin-top:10px">${ev.actualizadoPor ? "Última edición: " + esc(nombreDe(ev.actualizadoPor)) : ""}</p>`);
}

function urlGoogleCal(ev, fecha) {
  const pref = nombresPara(ev).join(", ");
  const p = new URLSearchParams({ action: "TEMPLATE", text: (pref ? `[${pref}] ` : "") + (ev.titulo || "") });
  const compacta = (s) => s.replace(/-/g, "");
  if (ev.hora) {
    const ini = momento({ ev, fecha }), fin = new Date(ini.getTime() + 60 * 60000);
    const f = (d) => `${compacta(fstr(d))}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
    p.set("dates", `${f(ini)}/${f(fin)}`);
    p.set("ctz", Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Mexico_City");
  } else {
    p.set("dates", `${compacta(fecha)}/${compacta(addDias(fecha, 1))}`);
  }
  const det = [];
  if ((ev.llevar || []).length) det.push("Llevar: " + ev.llevar.join(", "));
  if (ev.notas) det.push(ev.notas);
  if (det.length) p.set("details", det.join("\n\n"));
  if (ev.lugar) p.set("location", ev.lugar);
  const rr = { diario: "FREQ=DAILY", semanal: "FREQ=WEEKLY", quincenal: "FREQ=WEEKLY;INTERVAL=2", mensual: "FREQ=MONTHLY" }[ev.repetir];
  if (rr) p.set("recur", "RRULE:" + rr + (ev.repetirHasta ? `;UNTIL=${compacta(ev.repetirHasta)}T235959Z` : ""));
  return "https://calendar.google.com/calendar/render?" + p.toString();
}

// ---------- Acciones ----------
function irA(v) { vista = v; cerrarHoja(); render(); window.scrollTo(0, 0); }

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, [data-dia], [data-ev]");
  if (!t) return;
  const d = t.dataset;

  if (elegirRapido(t)) return;
  if (d.nav) { if (d.nav === "nuevo") formEvento({}, vista === "calendario" ? diaSel : hoy()); else irA(d.nav); return; }
  if (d.filtroQuien) { filtroQuien = d.filtroQuien; render(); return; }
  if (d.filtroCat) { filtroCat = d.filtroCat; render(); return; }
  if (d.filtroPara) { filtroPara = d.filtroPara; render(); return; }
  if (d.famBorrar) {
    if (eventos.some((ev) => (ev.para || []).includes(d.famBorrar))) return toast("Hay actividades de esa persona. Cámbialas primero.");
    if (confirm("¿Quitar a esta persona de la familia?")) deleteDoc(doc(db, "familia", d.famBorrar)).catch(fallo);
    return;
  }
  if (d.mes) { mesVista.setMonth(mesVista.getMonth() + Number(d.mes)); render(); return; }
  if (d.dia) { diaSel = d.dia; render(); return; }
  if (d.nuevoEn) { formEvento({}, d.nuevoEn); return; }
  if (d.lista) { listaSel = d.lista; render(); return; }
  if (d.irLista) { listaSel = d.irLista; irA("listas"); return; }
  if (d.itemBorrar) { deleteDoc(doc(db, "items", d.itemBorrar)).catch(fallo); return; }
  if (d.catBorrar) {
    if (eventos.some((ev) => ev.categoriaId === d.catBorrar)) return toast("Hay eventos con esa categoría. Cámbialos primero.");
    if (confirm("¿Borrar esta categoría?")) deleteDoc(doc(db, "categorias", d.catBorrar)).catch(fallo);
    return;
  }

  switch (d.accion) {
    case "cerrar": cerrarHoja(); return;
    case "hecho": {
      const ev = eventos.find((x) => x.id === d.ev);
      const ya = (ev.hechos || []).includes(d.f);
      updateDoc(doc(db, "eventos", d.ev), { hechos: ya ? arrayRemove(d.f) : arrayUnion(d.f) }).catch(fallo);
      cerrarHoja(); toast(ya ? "Desmarcado" : "¡Listo! Marcado como hecho");
      return;
    }
    case "editar": formEvento(eventos.find((x) => x.id === d.ev)); return;
    case "duplicar": {
      const { id, hechos, checks, omitidas, creado, ...resto } = eventos.find((x) => x.id === d.ev);
      void id; void hechos; void checks; void omitidas; void creado;
      formEvento({ ...resto, titulo: resto.titulo });
      return;
    }
    case "borrar-ev": {
      const ev = eventos.find((x) => x.id === d.ev);
      if ((ev.origen || "").startsWith("gcal")) {
        if (confirm("Este evento viene de Google Calendar. ¿Ocultarlo en la app? (En Google Calendar sigue igual)")) {
          updateDoc(doc(db, "eventos", d.ev), { oculto: true }).catch(fallo); cerrarHoja(); toast("Oculto en la app");
        }
        return;
      }
      if (ev.repetir && ev.repetir !== "no") {
        abrirHoja(`<h2>Borrar “${esc(ev.titulo)}”</h2><p>Este evento se repite.</p>
          <div class="fila-btns"><button class="btn" data-accion="borrar-uno" data-ev="${ev.id}" data-f="${d.f}">Solo el ${fechaBonita(d.f).toLowerCase()}</button></div>
          <div class="fila-btns"><button class="btn peligro" data-accion="borrar-serie" data-ev="${ev.id}">Todas las repeticiones</button></div>
          <div class="fila-btns"><button class="btn" data-accion="cerrar">Cancelar</button></div>`);
      } else if (confirm("¿Borrar este evento?")) { deleteDoc(doc(db, "eventos", d.ev)).catch(fallo); cerrarHoja(); toast("Borrado"); }
      return;
    }
    case "borrar-uno": updateDoc(doc(db, "eventos", d.ev), { omitidas: arrayUnion(d.f) }).catch(fallo); cerrarHoja(); toast("Se quitó ese día"); return;
    case "borrar-serie": deleteDoc(doc(db, "eventos", d.ev)).catch(fallo); cerrarHoja(); toast("Borrado"); return;
    case "nueva-lista": {
      const n = prompt("Nombre de la nueva lista (ej. Ropa para planchar):");
      if (n && n.trim()) {
        const ref = await addDoc(collection(db, "listas"), { nombre: n.trim(), icono: "📝", orden: 50 + listas.length }).catch(fallo);
        if (ref) { listaSel = ref.id; render(); }
      }
      return;
    }
    case "borrar-lista": {
      if (!confirm("¿Borrar la lista y todo lo que tiene?")) return;
      const b = writeBatch(db);
      items.filter((i) => i.listaId === listaSel).forEach((i) => b.delete(doc(db, "items", i.id)));
      b.delete(doc(db, "listas", listaSel));
      b.commit().catch(fallo); listaSel = "super"; return;
    }
    case "limpiar-hechos": {
      const b = writeBatch(db);
      items.filter((i) => i.listaId === listaSel && i.hecho).forEach((i) => b.delete(doc(db, "items", i.id)));
      b.commit().catch(fallo); return;
    }
    case "compartir-lista": {
      const l = listas.find((x) => x.id === listaSel);
      const txt = `${l.nombre}:\n` + items.filter((i) => i.listaId === listaSel && !i.hecho).map((i) => `• ${i.texto}${i.cantidad ? " (" + i.cantidad + ")" : ""}`).join("\n");
      try { if (navigator.share) await navigator.share({ text: txt }); else { await navigator.clipboard.writeText(txt); toast("Lista copiada"); } } catch { /* cancelado */ }
      return;
    }
    case "activar-avisos": {
      const p = await Notification.requestPermission();
      if (p === "granted") {
        const ok = pushConfigurado && (await activarPush(false));
        toast(ok ? "Avisos activados (también con pantalla bloqueada)" : "Avisos activados");
        revisarAvisos();
      }
      render(); return;
    }
    case "reintentar-push": toast((await activarPush(false)) ? "Listo: avisos con pantalla bloqueada" : "No se pudo activar"); render(); return;
    case "instalar": if (promptInstalar) { promptInstalar.prompt(); promptInstalar = null; render(); } return;
    case "salir": if (confirm("¿Cerrar sesión en este teléfono?")) signOut(auth); return;
  }

  if (d.ev && t.classList.contains("card")) detalleEvento(d.ev, d.f);
});

document.addEventListener("change", (e) => {
  const t = e.target, d = t.dataset;
  if (d.itemCheck) updateDoc(doc(db, "items", d.itemCheck), { hecho: t.checked, hechoPor: yo.uid }).catch(fallo);
  if (d.llevar !== undefined && d.ev) {
    const campo = new FieldPath("checks", d.f), i = Number(d.llevar);
    updateDoc(doc(db, "eventos", d.ev), campo, t.checked ? arrayUnion(i) : arrayRemove(i)).catch(fallo);
  }
  if (d.famColor) updateDoc(doc(db, "familia", d.famColor), { color: t.value }).catch(fallo);
  if (d.famNombre && t.value.trim()) updateDoc(doc(db, "familia", d.famNombre), { nombre: t.value.trim() }).catch(fallo);
  if (t.id === "hora-otra") {
    const f = t.form || $("#hoja form[data-form=evento]");
    f.hora.value = t.value;
    const otra = $("#hoja [data-grupo=hora] [data-pick='__otra']");
    $("#hoja [data-grupo=hora]").querySelectorAll(".chip").forEach((c) => c.classList.toggle("activo", c === otra));
    if (otra) otra.textContent = t.value ? "🕐 " + hora12(t.value) : "🕐 Otra hora";
  }
  if (t.name === "fecha" && t.closest("form[data-form=evento]")) {
    $("#hoja [data-grupo=fecha]").querySelectorAll(".chip").forEach((c) => c.classList.toggle("activo", c.dataset.pick === t.value));
  }
  if (d.catColor) updateDoc(doc(db, "categorias", d.catColor), { color: t.value }).catch(fallo);
  if (d.catNombre && t.value.trim()) updateDoc(doc(db, "categorias", d.catNombre), { nombre: t.value.trim() }).catch(fallo);
  if (t.matches("[data-pref-avisos]")) {
    localStorage.setItem("avisosDe", t.value);
    updateDoc(doc(db, "miembros", yo.uid), { avisosDe: t.value }).catch(fallo); // lo usa el programa en Python
    toast("Guardado");
  }
});

document.addEventListener("submit", (e) => {
  const f = e.target; if (!f.dataset.form) return;
  e.preventDefault();
  const fd = new FormData(f);
  switch (f.dataset.form) {
    case "evento": {
      if (!fd.get("titulo").trim()) {
        $("#box-titulo").classList.remove("oculto"); f.titulo.focus();
        toast("Elige una opción o escribe qué es"); return;
      }
      if (!fd.get("fecha")) { toast("Elige la fecha"); return; }
      const datos = {
        titulo: fd.get("titulo").trim(),
        categoriaId: fd.get("categoriaId"),
        para: fd.getAll("para"),
        fecha: fd.get("fecha"),
        hora: fd.get("hora") || "",
        lugar: fd.get("lugar").trim(),
        quien: fd.get("quien") || "ambos",
        llevar: fd.get("llevar").split("\n").map((s) => s.trim()).filter(Boolean),
        repetir: fd.get("repetir"),
        repetirHasta: fd.get("repetirHasta") || "",
        recordatorios: fd.getAll("rec").map(Number),
        notas: fd.get("notas").trim(),
        actualizado: serverTimestamp(),
        actualizadoPor: yo.uid
      };
      const id = f.dataset.id;
      if (id) updateDoc(doc(db, "eventos", id), datos).catch(fallo);
      else addDoc(collection(db, "eventos"), { ...datos, hechos: [], checks: {}, omitidas: [], creado: serverTimestamp(), creadoPor: yo.uid }).catch(fallo);
      cerrarHoja(); toast("Guardado"); diaSel = datos.fecha;
      return;
    }
    case "item": {
      const texto = fd.get("texto").trim(); if (!texto) return;
      const fecha = $("#item-fecha")?.value || "";
      const quien = $("#item-quien")?.value || "";
      const partes = listaSel === "super" || listaSel === "farmacia" ? texto.split(/\s*,\s*(?!\d)/).map((s) => s.trim()).filter(Boolean) : [texto];
      const b = writeBatch(db);
      partes.forEach((p, k) => {
        const m = p.match(/^(\d+[\.,]?\d*\s*(kg|g|gr|l|lt|litros?|pzas?|piezas?|paquetes?|latas?|bolsas?|cajas?|docenas?)?)\s+(.+)$/i);
        b.set(doc(collection(db, "items")), {
          listaId: listaSel, texto: m ? m[3] : p, cantidad: m ? m[1] : "", hecho: false,
          fecha, quien, creadoPor: yo.uid, creadoMs: Date.now() + k
        });
      });
      b.commit().catch(fallo);
      f.reset(); f.querySelector("input").focus();
      return;
    }
    case "apodo": {
      const n = fd.get("nombre").trim();
      if (n) updateDoc(doc(db, "miembros", yo.uid), { nombre: n }).then(() => toast("Guardado")).catch(fallo);
      return;
    }
    case "familia": {
      const n = fd.get("nombreFam").trim(); if (!n) return;
      const colores = ["#BA7517", "#7F77DD", "#D85A30", "#639922", "#993556", "#0F6E56"];
      addDoc(collection(db, "familia"), { nombre: n, color: colores[familia.length % colores.length], orden: 50 + familia.length }).catch(fallo);
      f.reset(); return;
    }
    case "categoria": {
      const n = fd.get("nombreCat").trim(); if (!n) return;
      const colores = ["#7F77DD", "#1D9E75", "#D85A30", "#D4537E", "#378ADD", "#639922", "#BA7517"];
      addDoc(collection(db, "categorias"), { nombre: n, color: colores[categorias.length % colores.length], orden: 50 + categorias.length }).catch(fallo);
      f.reset(); return;
    }
  }
});

// ---------- Avisos push (los envía el programa en Python) ----------
async function activarPush(silencioso) {
  try {
    if (!pushConfigurado) return false;
    const { getMessaging, getToken, isSupported } = await cargarMessaging();
    if (!(await isSupported())) return false;
    const reg = await navigator.serviceWorker.ready;
    const token = await getToken(getMessaging(appFb), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (!token) return false;
    const anterior = localStorage.getItem("pushToken");
    if (anterior && anterior !== token) deleteDoc(doc(db, "tokens", anterior.slice(-60))).catch(() => {});
    await setDoc(doc(db, "tokens", token.slice(-60)), {
      token, uid: yo.uid, equipo: navigator.userAgent.slice(0, 120), actualizado: serverTimestamp()
    });
    localStorage.setItem("pushToken", token);
    updateDoc(doc(db, "miembros", yo.uid), { avisosDe: localStorage.getItem("avisosDe") || "todo" }).catch(() => {});
    return true;
  } catch (e) {
    console.error("push", e);
    if (!silencioso) toast("No se pudieron activar los avisos con pantalla bloqueada");
    return false;
  }
}

// ---------- Avisos locales (si el programa en Python no está activo) ----------
function revisarAvisos() {
  if (!yo || !("Notification" in window) || Notification.permission !== "granted") return;
  // Si el programa en Python está activo y este teléfono recibe sus avisos, no duplicar
  if (localStorage.getItem("pushToken") && Date.now() - servidorUltimo < 40 * 60000) return;
  const ahora = Date.now();
  const pref = localStorage.getItem("avisosDe") || "todo";
  let enviados = {};
  try { enviados = JSON.parse(localStorage.getItem("avisosEnviados") || "{}"); } catch { /* vacío */ }
  for (const o of rango(addDias(hoy(), -1), addDias(hoy(), 8))) {
    const ev = o.ev;
    if (esHecho(o)) continue;
    if (pref === "mio" && ev.quien && ev.quien !== "ambos" && ev.quien !== yo.uid) continue;
    for (const m of ev.recordatorios || []) {
      const t = momento(o).getTime() - m * 60000;
      const clave = `${ev.id}|${o.fecha}|${m}`;
      if (ahora >= t && ahora - t < 6 * 3600e3 && !enviados[clave]) {
        enviados[clave] = ahora;
        const cuerpo = [`${fechaBonita(o.fecha)} · ${hora12(ev.hora)}`, ev.lugar, (ev.llevar || []).length ? "Llevar: " + ev.llevar.join(", ") : ""].filter(Boolean).join("\n");
        navigator.serviceWorker?.ready.then((reg) => reg.showNotification((nombresPara(ev).length ? `[${nombresPara(ev).join(", ")}] ` : "") + ev.titulo, {
          body: cuerpo, tag: clave, icon: "icon-192.png", badge: "icon-192.png", vibrate: [200, 100, 200]
        })).catch(() => new Notification(ev.titulo, { body: cuerpo }));
      }
    }
  }
  for (const k in enviados) if (ahora - enviados[k] > 10 * 86400e3) delete enviados[k];
  localStorage.setItem("avisosEnviados", JSON.stringify(enviados));
}
setInterval(revisarAvisos, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { revisarAvisos(); render(); } });
setInterval(() => { if (vista === "hoy" && !document.hidden && $("#hoja").classList.contains("oculto")) render(); }, 5 * 60000);

// ---------- Instalación ----------
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); promptInstalar = e; if (vista === "ajustes") render(); });
