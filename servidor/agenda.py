"""
Lógica compartida de la Agenda familiar (sin dependencias de Firebase).

Replica en Python lo que hace la app (app.js): calcula las repeticiones de cada
evento, cuándo toca cada recordatorio y a quién avisar.
"""
from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

ZONA = ZoneInfo("America/Mexico_City")
HORA_TODO_EL_DIA = "09:00"  # los eventos sin hora se avisan desde las 9:00 a.m.
PASOS = {"diario": 1, "semanal": 7, "quincenal": 14}

TEXTO_REC = {
    0: "A la hora", 10: "En 10 minutos", 30: "En 30 minutos", 60: "En 1 hora", 120: "En 2 horas",
    1440: "Mañana", 2880: "En 2 días", 10080: "En 1 semana",
}
DIAS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]
MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]


def f2d(s: str) -> date:
    return date.fromisoformat(s)


def ocurrencias(ev: dict, desde: str, hasta: str) -> list[str]:
    """Fechas (YYYY-MM-DD) en que ocurre un evento dentro del rango, igual que en la app."""
    out: list[str] = []
    fecha = ev.get("fecha")
    if not fecha:
        return out
    fin = ev["repetirHasta"] if ev.get("repetirHasta") and ev["repetirHasta"] < hasta else hasta
    r = ev.get("repetir") or "no"
    if r == "no":
        if desde <= fecha <= hasta:
            out.append(fecha)
        return out
    if r == "mensual":
        base = f2d(fecha)
        for i in range(600):
            y, m = divmod(base.month - 1 + i, 12)
            y += base.year
            m += 1
            d = date(y, m, min(base.day, calendar.monthrange(y, m)[1])).isoformat()
            if d > fin:
                break
            if d >= desde:
                out.append(d)
        return out
    paso = PASOS.get(r, 7)
    s = f2d(fecha)
    if fecha < desde:
        diff = (f2d(desde) - s).days
        s += timedelta(days=(diff // paso) * paso)
    for _ in range(1500):
        iso = s.isoformat()
        if iso > fin:
            break
        if iso >= desde:
            out.append(iso)
        s += timedelta(days=paso)
    return out


def momento(ev: dict, fecha: str) -> datetime:
    h, m = map(int, (ev.get("hora") or HORA_TODO_EL_DIA).split(":"))
    d = f2d(fecha)
    return datetime(d.year, d.month, d.day, h, m, tzinfo=ZONA)


def fecha_bonita(fecha: str, hoy: date) -> str:
    d = f2d(fecha)
    if d == hoy:
        return "Hoy"
    if d == hoy + timedelta(days=1):
        return "Mañana"
    return f"{DIAS[d.weekday()]} {d.day} {MESES[d.month - 1]}"


def hora12(h: str | None) -> str:
    if not h:
        return "Todo el día"
    H, M = map(int, h.split(":"))
    return f"{(H + 11) % 12 + 1}:{M:02d} {'a.m.' if H < 12 else 'p.m.'}"


@dataclass
class Aviso:
    clave: str          # id único: evento|fecha|minutos
    ev: dict
    fecha: str
    minutos: int
    cuando: datetime


def avisos_pendientes(eventos: list[dict], ahora: datetime, ventana_min: int = 90,
                      enviados: set[str] | None = None) -> list[Aviso]:
    """Recordatorios cuya hora ya llegó (dentro de la ventana) y que aún no se han enviado."""
    enviados = enviados or set()
    hoy = ahora.astimezone(ZONA).date()
    desde, hasta = (hoy - timedelta(days=1)).isoformat(), (hoy + timedelta(days=8)).isoformat()
    out: list[Aviso] = []
    for ev in eventos:
        if ev.get("oculto"):
            continue
        for f in ocurrencias(ev, desde, hasta):
            if f in (ev.get("omitidas") or []) or f in (ev.get("hechos") or []):
                continue
            for m in ev.get("recordatorios") or []:
                cuando = momento(ev, f) - timedelta(minutes=int(m))
                clave = f"{ev['id']}|{f}|{m}"
                if cuando <= ahora < cuando + timedelta(minutes=ventana_min) and clave not in enviados:
                    out.append(Aviso(clave, ev, f, int(m), cuando))
    return sorted(out, key=lambda a: a.cuando)


def destinatarios(ev: dict, miembros: dict[str, dict]) -> list[str]:
    """uids que deben recibir el aviso según su preferencia ('todo' o 'mio')."""
    quien = ev.get("quien") or "ambos"
    uids = []
    for uid, m in miembros.items():
        if (m.get("avisosDe") or "todo") == "mio" and quien not in ("ambos", uid):
            continue
        uids.append(uid)
    return uids


def nombres_para(ev: dict, familia: dict[str, dict]) -> list[str]:
    return [familia[p]["nombre"] for p in (ev.get("para") or []) if p in familia]


def texto_aviso(a: Aviso, familia: dict[str, dict], categorias: dict[str, dict], hoy: date) -> tuple[str, str]:
    ev = a.ev
    para = nombres_para(ev, familia)
    titulo = (f"[{', '.join(para)}] " if para else "") + ev.get("titulo", "Evento")
    lineas = [f"{TEXTO_REC.get(a.minutos, 'Pronto')} · {fecha_bonita(a.fecha, hoy)} {hora12(ev.get('hora'))}"]
    if ev.get("lugar"):
        lineas.append(f"📍 {ev['lugar']}")
    if ev.get("llevar"):
        lineas.append("Llevar: " + ", ".join(ev["llevar"]))
    cat = categorias.get(ev.get("categoriaId") or "", {}).get("nombre")
    if cat:
        lineas.append(cat)
    return titulo, "\n".join(lineas)


def resumen_semana(eventos: list[dict], familia: dict[str, dict], items: list[dict], hoy: date) -> tuple[str, str]:
    """Texto del resumen de los próximos 7 días (para el aviso de los domingos)."""
    desde, hasta = (hoy + timedelta(days=1)).isoformat(), (hoy + timedelta(days=7)).isoformat()
    occ = []
    for ev in eventos:
        if ev.get("oculto"):
            continue
        for f in ocurrencias(ev, desde, hasta):
            if f not in (ev.get("omitidas") or []):
                occ.append((f, ev.get("hora") or "", ev))
    occ.sort(key=lambda x: (x[0], x[1]))
    if not occ:
        cuerpo = "Semana libre: no hay actividades registradas."
    else:
        por_persona: dict[str, int] = {}
        for _, _, ev in occ:
            for n in nombres_para(ev, familia) or ["General"]:
                por_persona[n] = por_persona.get(n, 0) + 1
        partes = [f"{n}: {c}" for n, c in sorted(por_persona.items(), key=lambda x: -x[1])]
        primeros = [f"• {fecha_bonita(f, hoy)} {hora12(h) if h else ''} {ev.get('titulo', '')}".replace("  ", " ")
                    for f, h, ev in occ[:4]]
        cuerpo = " · ".join(partes) + "\n" + "\n".join(primeros)
        if len(occ) > 4:
            cuerpo += f"\n…y {len(occ) - 4} más"
    pend = sum(1 for i in items if not i.get("hecho") and i.get("listaId") != "super")
    sup = sum(1 for i in items if not i.get("hecho") and i.get("listaId") == "super")
    extra = [x for x in (f"{pend} pendiente{'s' if pend != 1 else ''}" if pend else "",
                         f"{sup} cosa{'s' if sup != 1 else ''} del súper" if sup else "") if x]
    if extra:
        cuerpo += "\n" + " · ".join(extra)
    return f"📅 Tu semana: {len(occ)} actividad{'es' if len(occ) != 1 else ''}", cuerpo
