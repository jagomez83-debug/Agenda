"""
Sincroniza Google Calendar → Agenda familiar.

Lee la "dirección secreta en formato iCal" de un calendario de Google y copia
sus eventos a la app (colección `eventos`). Corre junto con los avisos, cada
10 minutos. Solo lee el calendario: nunca cambia nada en Google.

Qué se copia de Google: título, fecha, hora, lugar, descripción y repetición.
Qué se queda en la app: si ya está hecho, lo palomeado de "qué llevar", y
—después de crearse— categoría, para quién, quién se encarga y recordatorios.
"""
from __future__ import annotations

import hashlib
import os
import re
import unicodedata
import urllib.request
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from agenda import ZONA, ocurrencias

# (secreto de GitHub con la URL del calendario, nombre del dueño tal como aparece en la app)
CALENDARIOS = [
    ("GCAL_ICS_MAMA", "Mamá"),
    ("GCAL_ICS_PAPA", "Papá"),
]
DIAS_ATRAS, DIAS_ADELANTE = 30, 365
BYDAY = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}

PALABRAS_CATEGORIA = {
    "medico": ["pediatra", "doctor", "dr.", "dra.", "medico", "dentista", "ortodonc", "vacuna", "analisis",
               "laboratorio", "consulta", "hospital", "clinica", "oftalm", "terapia", "psicolog", "nutri"],
    "basquet": ["basquet", "basket", "baloncesto"],
    "escuela": ["escuela", "colegio", "junta", "boleta", "festival", "excursion", "maestra", "maestro",
                "examen", "kinder", "primaria", "secundaria", "tarea", "inscripcion"],
    "fiestas": ["fiesta", "cumple", "posada", "pinata", "boda", "bautizo"],
    "entrenamientos": ["entrenamiento", "natacion", "futbol", "baile", "karate", "tae kwon", "gimnasia",
                       "ballet", "tenis", "practica"],
    "pendientes": ["pagar", "recoger", "llevar", "planchar", "tintoreria", "renovar", "tramite"],
}


def sin_acentos(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


# ---------- Lectura del archivo iCal ----------
def _desdoblar(texto: str) -> list[str]:
    lineas: list[str] = []
    for l in texto.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if l[:1] in (" ", "\t") and lineas:
            lineas[-1] += l[1:]
        else:
            lineas.append(l)
    return lineas


def _prop(linea: str) -> tuple[str, dict, str]:
    # NOMBRE;PARAM=VAL;PARAM2="a:b":VALOR
    en_comillas, corte = False, -1
    for i, c in enumerate(linea):
        if c == '"':
            en_comillas = not en_comillas
        elif c == ":" and not en_comillas:
            corte = i
            break
    cab, valor = (linea[:corte], linea[corte + 1:]) if corte >= 0 else (linea, "")
    partes = cab.split(";")
    params = {}
    for p in partes[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            params[k.upper()] = v.strip('"')
    return partes[0].upper(), params, valor


def _texto(v: str) -> str:
    return (v.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",")
             .replace("\\;", ";").replace("\\\\", "\\").strip())


def leer_ics(texto: str) -> list[dict]:
    """Lista de VEVENT como dicts {NOMBRE: [(params, valor), ...]}."""
    eventos, actual, profundidad = [], None, 0
    for linea in _desdoblar(texto):
        if not linea:
            continue
        nombre, params, valor = _prop(linea)
        if nombre == "BEGIN":
            if valor.upper() == "VEVENT":
                actual, profundidad = {}, 0
            elif actual is not None:
                profundidad += 1  # VALARM, etc.
            continue
        if nombre == "END":
            if valor.upper() == "VEVENT" and actual is not None:
                eventos.append(actual)
                actual = None
            elif actual is not None:
                profundidad -= 1
            continue
        if actual is not None and profundidad == 0:
            actual.setdefault(nombre, []).append((params, valor))
    return eventos


def _uno(ve: dict, nombre: str, defecto=None):
    v = ve.get(nombre)
    return v[0] if v else defecto


def _valor(ve: dict, nombre: str) -> str:
    v = ve.get(nombre)
    return v[0][1] if v else ""


def _fecha_hora(params: dict, valor: str) -> tuple[datetime, bool]:
    """Convierte DTSTART/EXDATE/etc. a hora de CDMX. Devuelve (datetime, es_todo_el_dia)."""
    valor = valor.strip()
    if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", valor):
        return datetime.strptime(valor[:8], "%Y%m%d").replace(tzinfo=ZONA), True
    utc = valor.endswith("Z")
    d = datetime.strptime(valor.rstrip("Z")[:15], "%Y%m%dT%H%M%S")
    if utc:
        d = d.replace(tzinfo=timezone.utc)
    else:
        try:
            d = d.replace(tzinfo=ZoneInfo(params["TZID"]) if "TZID" in params else ZONA)
        except Exception:
            d = d.replace(tzinfo=ZONA)
    return d.astimezone(ZONA), False


def _fechas_lista(ve: dict, nombre: str) -> list[str]:
    out = []
    for params, valor in ve.get(nombre, []):
        for v in valor.split(","):
            if v.strip():
                out.append(_fecha_hora(params, v)[0].date().isoformat())
    return out


def _rrule(valor: str) -> dict:
    return {k.upper(): v for k, v in (p.split("=", 1) for p in valor.split(";") if "=" in p)}


# ---------- Conversión al formato de la app ----------
def _id(*partes: str) -> str:
    return "gcal-" + hashlib.sha1("|".join(partes).encode()).hexdigest()[:20]


def _hasta_por_count(e: dict, count: int) -> str:
    lejos = (date.fromisoformat(e["fecha"]) + timedelta(days=3700)).isoformat()
    occ = ocurrencias({**e, "repetirHasta": ""}, e["fecha"], lejos)
    return occ[min(count, len(occ)) - 1] if occ else e["fecha"]


def _expandir(rr_texto: str, inicio: datetime, desde: date, hasta: date) -> list[datetime]:
    from dateutil.rrule import rrulestr
    regla = rrulestr("RRULE:" + rr_texto, dtstart=inicio.replace(tzinfo=None), ignoretz=True)
    a = datetime.combine(desde, datetime.min.time())
    b = datetime.combine(hasta, datetime.max.time())
    return regla.between(a, b, inc=True)


def convertir(vevents: list[dict], hoy: date, origen: str) -> list[dict]:
    """De VEVENTs de Google a eventos de la app (solo los campos que vienen de Google)."""
    desde, hasta = hoy - timedelta(days=DIAS_ATRAS), hoy + timedelta(days=DIAS_ADELANTE)
    maestros: dict[str, dict] = {}
    cambios: list[dict] = []
    for i, ve in enumerate(vevents):
        if not _uno(ve, "DTSTART"):
            continue
        uid = _valor(ve, "UID") or f"sin-uid-{i}"
        if _uno(ve, "RECURRENCE-ID"):
            cambios.append(ve)
        else:
            maestros[uid] = ve

    out: list[dict] = []
    omitir_extra: dict[str, list[str]] = {}
    # Ocurrencias cambiadas o canceladas de una serie
    for ve in cambios:
        uid = _valor(ve, "UID")
        p, v = _uno(ve, "RECURRENCE-ID")
        original = _fecha_hora(p, v)[0].date().isoformat()
        omitir_extra.setdefault(uid, []).append(original)
        if _valor(ve, "STATUS").upper() == "CANCELLED":
            continue
        out += _a_app(ve, uid + "|" + original, desde, hasta, origen, sin_repetir=True)

    for uid, ve in maestros.items():
        if _valor(ve, "STATUS").upper() == "CANCELLED":
            continue
        for e in _a_app(ve, uid, desde, hasta, origen):
            if e["repetir"] != "no":
                e["omitidas"] = sorted(set(e["omitidas"] + omitir_extra.get(uid, [])))
            elif e["fecha"] in omitir_extra.get(uid, []):
                continue  # fecha suelta que fue cambiada: ya viene como cambio
            out.append(e)
    return out


def _a_app(ve: dict, clave: str, desde: date, hasta: date, origen: str, sin_repetir: bool = False) -> list[dict]:
    p, v = _uno(ve, "DTSTART")
    inicio, todo_dia = _fecha_hora(p, v)
    base = {
        "titulo": _texto(_valor(ve, "SUMMARY")) or "(Sin título)",
        "fecha": inicio.date().isoformat(),
        "hora": "" if todo_dia else f"{inicio.hour:02d}:{inicio.minute:02d}",
        "lugar": _texto(_valor(ve, "LOCATION"))[:200],
        "notas": re.sub(r"\s+\n", "\n", re.sub(r"<[^>]+>", " ", _texto(_valor(ve, "DESCRIPTION"))))[:500].strip(),
        "repetir": "no", "repetirHasta": "", "omitidas": _fechas_lista(ve, "EXDATE"),
        "origen": origen, "gcalUid": clave,
    }
    rr = None if sin_repetir else _uno(ve, "RRULE")
    if not rr:
        if desde.isoformat() <= base["fecha"] <= hasta.isoformat():
            return [{**base, "id": _id(origen, clave)}]
        return []

    texto_rr = rr[1]
    r = _rrule(texto_rr)
    freq, intervalo = r.get("FREQ", "").upper(), int(r.get("INTERVAL", "1") or 1)
    dias = [d for d in r.get("BYDAY", "").split(",") if d]
    hasta_rr = _fecha_hora({}, r["UNTIL"])[0].date().isoformat() if "UNTIL" in r else ""
    if hasta_rr and hasta_rr < desde.isoformat():
        return []

    def con_hasta(e: dict) -> dict:
        if hasta_rr:
            e["repetirHasta"] = hasta_rr
        elif "COUNT" in r:
            e["repetirHasta"] = _hasta_por_count(e, int(r["COUNT"]))
        return e

    dias_simples = all(re.fullmatch(r"[A-Z]{2}", d) for d in dias)
    extras = set(r) - {"FREQ", "INTERVAL", "UNTIL", "COUNT", "BYDAY", "WKST", "BYMONTHDAY"}
    if not extras:
        # Casos que la app entiende directo
        if freq == "DAILY" and intervalo == 1 and not dias and "BYMONTHDAY" not in r:
            return [con_hasta({**base, "id": _id(origen, clave), "repetir": "diario"})]
        if freq == "WEEKLY" and intervalo in (1, 2) and dias_simples and "COUNT" not in r and "BYMONTHDAY" not in r:
            rep = "semanal" if intervalo == 1 else "quincenal"
            if not dias or dias == [list(BYDAY)[inicio.weekday()]]:
                return [con_hasta({**base, "id": _id(origen, clave), "repetir": rep})]
            out = []
            for d in dias:  # una serie por cada día (ej. lunes y miércoles)
                f = inicio.date() + timedelta(days=(BYDAY[d] - inicio.weekday()) % 7)
                out.append(con_hasta({**base, "id": _id(origen, clave, d), "fecha": f.isoformat(), "repetir": rep}))
            return out
        if freq == "MONTHLY" and intervalo == 1 and not dias and r.get("BYMONTHDAY", str(inicio.day)) == str(inicio.day):
            return [con_hasta({**base, "id": _id(origen, clave), "repetir": "mensual"})]

    # Lo demás (anual, "segundo martes", cada 3 semanas, con COUNT…): fechas sueltas
    out = []
    for d in _expandir(texto_rr, inicio, max(desde, inicio.date()), hasta)[:200]:
        f = d.date().isoformat()
        if f not in base["omitidas"]:
            out.append({**base, "id": _id(origen, clave, f), "fecha": f, "omitidas": []})
    return out


# ---------- Adivinar categoría y para quién ----------
def adivinar_categoria(ev: dict, categorias: dict) -> str:
    t = sin_acentos(ev["titulo"] + " " + ev.get("notas", ""))
    for cat, palabras in PALABRAS_CATEGORIA.items():
        if cat in categorias and any(p in t for p in palabras):
            return cat
    return "otro" if "otro" in categorias else next(iter(categorias), "otro")


def adivinar_para(ev: dict, familia: dict) -> list[str]:
    t = " " + re.sub(r"[^a-z0-9 ]", " ", sin_acentos(ev["titulo"] + " " + ev.get("notas", ""))) + " "
    out = []
    for fid, f in familia.items():
        nombre = re.sub(r"[^a-z0-9 ]", " ", sin_acentos(f.get("nombre", ""))).strip()
        if not nombre:
            continue
        claves = {nombre}
        primera = nombre.split()[0]
        if len(primera) >= 4 and not any(primera == sin_acentos(o.get("nombre", "")).split()[0]
                                          for k, o in familia.items() if k != fid and o.get("nombre")):
            claves.add(primera)  # "Jose" solo si ningún otro familiar empieza igual
        if any(f" {c} " in t for c in claves):
            out.append(fid)
    return out


# ---------- Sincronización con Firestore ----------
def descargar(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "AgendaFamiliar/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


CAMPOS_GOOGLE = ["titulo", "fecha", "hora", "lugar", "notas", "repetir", "repetirHasta", "omitidas", "origen", "gcalUid"]


def sincronizar(db, hoy: date | None = None, simular: bool = False, textos: dict | None = None) -> None:
    """Copia a la app los calendarios configurados en los secretos GCAL_ICS_*."""
    hoy = hoy or datetime.now(ZONA).date()
    miembros = {m.id: m.to_dict() for m in db.collection("miembros").stream()}
    familia = {f.id: f.to_dict() for f in db.collection("familia").stream()}
    categorias = {c.id: c.to_dict() for c in db.collection("categorias").stream()}
    for secreto, nombre in CALENDARIOS:
        url = (textos or {}).get(secreto) or os.environ.get(secreto, "").strip()
        if not url:
            continue
        origen = "gcal-" + secreto.split("_")[-1].lower()
        try:
            texto = url if url.lstrip().startswith("BEGIN:VCALENDAR") else descargar(url)
        except Exception as e:
            print(f"Calendario de {nombre}: no se pudo descargar ({type(e).__name__}). Se reintenta en la próxima corrida.")
            continue
        nuevos = convertir(leer_ics(texto), hoy, origen)
        dueno = next((uid for uid, m in miembros.items()
                      if sin_acentos(m.get("nombre") or "") == sin_acentos(nombre)), "ambos")
        existentes = {d.id: d.to_dict() for d in db.collection("eventos").stream()
                      if (d.to_dict() or {}).get("origen") == origen}
        creados = actualizados = 0
        for e in nuevos:
            datos = {k: e[k] for k in CAMPOS_GOOGLE}
            ref = db.collection("eventos").document(e["id"])
            if e["id"] in existentes:
                if any(existentes[e["id"]].get(k) != datos[k] for k in CAMPOS_GOOGLE):
                    if not simular:
                        ref.set(datos, merge=True)
                    actualizados += 1
            else:
                datos.update({
                    "categoriaId": adivinar_categoria(e, categorias),
                    "para": adivinar_para(e, familia),
                    "quien": dueno,
                    "llevar": [],
                    "recordatorios": [60] if e["hora"] else [0],
                    "hechos": [], "checks": {},
                    "creado": datetime.now(timezone.utc), "creadoPor": "google-calendar",
                })
                if not simular:
                    ref.set(datos)
                creados += 1
        ids = {e["id"] for e in nuevos}
        quitados = [i for i in existentes if i not in ids]
        if not simular:
            for i in quitados:
                db.collection("eventos").document(i).delete()
        print(f"Calendario de {nombre}: {len(nuevos)} eventos · {creados} nuevos · "
              f"{actualizados} actualizados · {len(quitados)} quitados")
