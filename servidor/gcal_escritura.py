"""
App → Google Calendar.

Copia los eventos creados en la Agenda familiar a un calendario de Google
compartido ("Agenda familiar"). Corre cada 10 minutos junto con los avisos.

- Crear, cambiar o borrar un evento en la app lo crea, cambia o borra en Google.
- Los eventos que vinieron de Google Calendar (📆) no se copian de regreso.
- El calendario se indica con el secreto GCAL_FAMILIA_ID (ID del calendario) y
  debe estar compartido con la cuenta de servicio con permiso de "Hacer cambios en eventos".
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from datetime import date, datetime, timedelta

from agenda import ZONA

API = "https://www.googleapis.com/calendar/v3/calendars/{cal}/events"
ALCANCE = "https://www.googleapis.com/auth/calendar.events"
COLORES = {"medico": "11", "escuela": "9", "fiestas": "4", "basquet": "6",
           "entrenamientos": "10", "pendientes": "8", "otro": "3"}
RRULE = {"diario": "FREQ=DAILY", "semanal": "FREQ=WEEKLY", "quincenal": "FREQ=WEEKLY;INTERVAL=2", "mensual": "FREQ=MONTHLY"}
DURACION_MIN = 60


def id_google(id_app: str) -> str:
    """ID estable para Google (solo letras a-v y números)."""
    return "agenda" + base64.b32hexencode(id_app.encode()).decode().lower().rstrip("=")


def a_google(ev: dict, familia: dict, categorias: dict, miembros: dict) -> dict:
    para = [familia[p]["nombre"] for p in ev.get("para") or [] if p in familia]
    titulo = (f"[{', '.join(para)}] " if para else "") + (ev.get("titulo") or "Evento")
    det = []
    cat = categorias.get(ev.get("categoriaId") or "", {}).get("nombre")
    if cat:
        det.append(f"Categoría: {cat}")
    q = ev.get("quien") or "ambos"
    det.append("Se encarga: " + ("Ambos" if q == "ambos" else (miembros.get(q, {}).get("nombre") or "—")))
    if ev.get("llevar"):
        det.append("Llevar: " + ", ".join(ev["llevar"]))
    if ev.get("notas"):
        det.append("\n" + ev["notas"])
    det.append("\n— Creado desde la Agenda familiar")

    f = ev["fecha"]
    cuerpo: dict = {"summary": titulo, "description": "\n".join(det), "location": ev.get("lugar") or "",
                    "colorId": COLORES.get(ev.get("categoriaId") or "", "3"), "status": "confirmed",
                    "reminders": {"useDefault": True}}
    if ev.get("hora"):
        h, m = map(int, ev["hora"].split(":"))
        ini = datetime.fromisoformat(f).replace(hour=h, minute=m)
        fin = ini + timedelta(minutes=DURACION_MIN)
        cuerpo["start"] = {"dateTime": ini.strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": "America/Mexico_City"}
        cuerpo["end"] = {"dateTime": fin.strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": "America/Mexico_City"}
    else:
        cuerpo["start"] = {"date": f}
        cuerpo["end"] = {"date": (date.fromisoformat(f) + timedelta(days=1)).isoformat()}

    regla = RRULE.get(ev.get("repetir") or "no")
    if regla:
        if ev.get("repetirHasta"):
            if ev.get("hora"):  # 23:59 de ese día en CDMX = 05:59 UTC del día siguiente
                fin_utc = date.fromisoformat(ev["repetirHasta"]) + timedelta(days=1)
                regla += ";UNTIL=" + fin_utc.isoformat().replace("-", "") + "T055959Z"
            else:
                regla += ";UNTIL=" + ev["repetirHasta"].replace("-", "")
        rec = ["RRULE:" + regla]
        omit = sorted(set(ev.get("omitidas") or []))
        if omit:
            if ev.get("hora"):
                hh = ev["hora"].replace(":", "") + "00"
                rec.append("EXDATE;TZID=America/Mexico_City:" + ",".join(o.replace("-", "") + "T" + hh for o in omit))
            else:
                rec.append("EXDATE;VALUE=DATE:" + ",".join(o.replace("-", "") for o in omit))
        cuerpo["recurrence"] = rec
    elif f in (ev.get("hechos") or []):
        cuerpo["summary"] = "✓ " + cuerpo["summary"]
    return cuerpo


def huella(cuerpo: dict) -> str:
    return hashlib.sha1(json.dumps(cuerpo, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def sesion():
    """Sesión HTTP autenticada con la cuenta de servicio de Firebase."""
    from google.auth.transport.requests import AuthorizedSession
    from google.oauth2 import service_account
    crudo = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    info = json.loads(crudo) if crudo else json.load(open("cuenta-servicio.json"))
    cred = service_account.Credentials.from_service_account_info(info, scopes=[ALCANCE])
    return AuthorizedSession(cred)


def _guardar(http, url_base: str, gid: str, cuerpo: dict) -> int:
    """Actualiza el evento; si no existe, lo crea con nuestro ID. Devuelve el código HTTP."""
    r = http.put(f"{url_base}/{gid}", json=cuerpo, timeout=30)
    if r.status_code == 404:
        r = http.post(url_base, json={**cuerpo, "id": gid}, timeout=30)
    return r.status_code


def sincronizar(db, http=None, simular: bool = False) -> bool:
    """Copia los eventos de la app al calendario compartido. Devuelve True si está configurado."""
    cal = os.environ.get("GCAL_FAMILIA_ID", "").strip()
    if not cal:
        return False
    from urllib.parse import quote
    url_base = API.format(cal=quote(cal, safe=""))
    http = http or (None if simular else sesion())

    familia = {d.id: d.to_dict() for d in db.collection("familia").stream()}
    categorias = {d.id: d.to_dict() for d in db.collection("categorias").stream()}
    miembros = {d.id: d.to_dict() for d in db.collection("miembros").stream()}
    eventos = {d.id: d.to_dict() for d in db.collection("eventos").stream()}
    estado = {d.id: d.to_dict() for d in db.collection("gcal_sync").stream()}

    propios = {i: e for i, e in eventos.items()
               if e.get("fecha") and not (e.get("origen") or "").startswith("gcal") and not e.get("oculto")}
    creados = cambiados = borrados = errores = 0
    for i, ev in propios.items():
        cuerpo = a_google({**ev, "id": i}, familia, categorias, miembros)
        h = huella(cuerpo)
        if estado.get(i, {}).get("huella") == h:
            continue
        gid = id_google(i)
        if simular:
            print(f"  [simulado] {'cambiar' if i in estado else 'crear'}: {cuerpo['summary']}")
            continue
        codigo = _guardar(http, url_base, gid, cuerpo)
        if codigo in (200, 201):
            db.collection("gcal_sync").document(i).set({"huella": h, "gid": gid, "ts": datetime.now(ZONA)})
            if i in estado:
                cambiados += 1
            else:
                creados += 1
        else:
            errores += 1
            print(f"  ✗ {cuerpo['summary']}: HTTP {codigo}")
            if codigo in (403, 404) and errores == 1:
                print("    Revisa que el calendario esté compartido con la cuenta de servicio "
                      "(permiso 'Hacer cambios en eventos') y que la API de Google Calendar esté habilitada.")
            if errores >= 5:
                break

    for i, st in estado.items():
        if i in propios:
            continue
        if simular:
            print(f"  [simulado] borrar de Google: {i}")
            continue
        r = http.delete(f"{url_base}/{st.get('gid') or id_google(i)}", timeout=30)
        if r.status_code in (200, 204, 404, 410):
            db.collection("gcal_sync").document(i).delete()
            borrados += 1
        else:
            errores += 1
            print(f"  ✗ borrar {i}: HTTP {r.status_code}")

    print(f"Google Calendar 'Agenda familiar': {creados} nuevos · {cambiados} cambiados · {borrados} borrados"
          + (f" · {errores} con error" if errores else ""))
    return True
