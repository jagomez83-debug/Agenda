"""
Agenda familiar — programa en Python que envía los avisos al celular.

Corre cada 10 minutos (GitHub Actions). Lee la agenda en Firestore, ve qué
recordatorios ya tocan y los manda como notificación push a los teléfonos de
ustedes dos, aunque la app esté cerrada y la pantalla bloqueada.

Uso:
    python avisos.py              # envía los avisos que ya tocan
    python avisos.py --resumen    # envía el resumen de la semana
    python avisos.py --prueba     # manda un aviso de prueba a todos los teléfonos
    python avisos.py --simular    # muestra qué enviaría, sin enviar nada

También copia a la app los eventos de Google Calendar configurados en los
secretos GCAL_ICS_MAMA / GCAL_ICS_PAPA (ver calendario.py).

Credenciales: variable de entorno FIREBASE_SERVICE_ACCOUNT con el JSON de la
cuenta de servicio, o el archivo cuenta-servicio.json en esta carpeta.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

from agenda import ZONA, avisos_pendientes, destinatarios, resumen_semana, texto_aviso

DIAS_GUARDAR_ENVIADOS = 10


def conectar():
    import firebase_admin
    from firebase_admin import credentials, firestore

    crudo = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if crudo:
        cred = credentials.Certificate(json.loads(crudo))
    elif os.path.exists("cuenta-servicio.json"):
        cred = credentials.Certificate("cuenta-servicio.json")
    else:
        sys.exit("Faltan credenciales: define FIREBASE_SERVICE_ACCOUNT o pon cuenta-servicio.json aquí.")
    firebase_admin.initialize_app(cred)
    return firestore.client()


def leer(db, coleccion: str) -> list[dict]:
    return [{"id": d.id, **d.to_dict()} for d in db.collection(coleccion).stream()]


def enviar(db, uids: list[str] | None, titulo: str, cuerpo: str, etiqueta: str, simular: bool) -> int:
    """Envía a todos los teléfonos registrados de esos uids (None = todos). Devuelve cuántos recibieron."""
    tokens = [t for t in leer(db, "tokens") if uids is None or t.get("uid") in uids]
    if simular:
        print(f"  [simulado] → {len(tokens)} teléfono(s): {titulo} | {cuerpo.replace(chr(10), ' / ')}")
        return len(tokens)
    if not tokens:
        return 0
    from firebase_admin import messaging

    mensajes = [
        messaging.Message(
            token=t["token"],
            data={"title": titulo, "body": cuerpo, "tag": etiqueta},
            webpush=messaging.WebpushConfig(headers={"Urgency": "high", "TTL": "86400"}),
        )
        for t in tokens
    ]
    res = messaging.send_each(mensajes)
    ok = 0
    for t, r in zip(tokens, res.responses):
        if r.success:
            ok += 1
        else:
            err = type(r.exception).__name__
            print(f"  ✗ {t['id'][:12]}…: {err} {r.exception}")
            # Teléfono que desinstaló la app o cambió de token: se borra
            if err in ("UnregisteredError", "SenderIdMismatchError") or "not a valid FCM registration token" in str(r.exception):
                db.collection("tokens").document(t["id"]).delete()
    return ok


def correr_avisos(db, simular: bool) -> None:
    ahora = datetime.now(timezone.utc)
    # 1) Copiar a la app los eventos de Google Calendar (si hay secretos GCAL_ICS_*)
    try:
        import calendario
        calendario.sincronizar(db, simular=simular)
    except Exception as e:  # un problema con el calendario no debe frenar los avisos
        print(f"Sincronización de calendario falló: {type(e).__name__}: {e}")
    # 2) Copiar los eventos de la app al Google Calendar compartido (si hay secreto GCAL_FAMILIA_ID)
    gcal_familia = False
    try:
        import gcal_escritura
        gcal_familia = gcal_escritura.sincronizar(db, simular=simular)
    except Exception as e:
        print(f"Copia a Google Calendar falló: {type(e).__name__}: {e}")
    # 3) Avisar a la app que el programa está activo (la app deja de mandar avisos locales para no duplicar)
    if not simular:
        db.collection("estado").document("servidor").set({"ultimo": ahora, "gcalFamilia": gcal_familia})
    eventos = leer(db, "eventos")
    miembros = {m["id"]: m for m in leer(db, "miembros")}
    familia = {f["id"]: f for f in leer(db, "familia")}
    categorias = {c["id"]: c for c in leer(db, "categorias")}

    limite = ahora - timedelta(days=DIAS_GUARDAR_ENVIADOS)
    enviados = set()
    for d in db.collection("enviados").stream():
        ts = d.to_dict().get("ts")
        if ts and ts < limite and not simular:
            d.reference.delete()  # limpieza
        else:
            enviados.add(d.id)

    pendientes = avisos_pendientes(eventos, ahora, enviados={e.replace("~", "|") for e in enviados})
    print(f"{ahora.astimezone(ZONA):%Y-%m-%d %H:%M} · {len(eventos)} eventos · {len(pendientes)} aviso(s) por enviar")
    hoy = ahora.astimezone(ZONA).date()
    for a in pendientes:
        titulo, cuerpo = texto_aviso(a, familia, categorias, hoy)
        n = enviar(db, destinatarios(a.ev, miembros), titulo, cuerpo, a.clave, simular)
        print(f"  ✓ {titulo} ({n} teléfono/s)")
        if not simular:
            db.collection("enviados").document(a.clave.replace("|", "~")).set({"ts": ahora})


def correr_resumen(db, simular: bool) -> None:
    hoy = datetime.now(ZONA).date()
    titulo, cuerpo = resumen_semana(
        leer(db, "eventos"), {f["id"]: f for f in leer(db, "familia")}, leer(db, "items"), hoy)
    n = enviar(db, None, titulo, cuerpo, f"resumen-{hoy.isoformat()}", simular)
    print(f"Resumen enviado a {n} teléfono(s):\n{titulo}\n{cuerpo}")


def main() -> None:
    p = argparse.ArgumentParser(description="Avisos de la Agenda familiar")
    p.add_argument("--resumen", action="store_true", help="enviar el resumen de la semana")
    p.add_argument("--prueba", action="store_true", help="enviar un aviso de prueba")
    p.add_argument("--simular", action="store_true", help="no enviar nada, solo mostrar")
    args = p.parse_args()
    db = conectar()
    if args.prueba:
        n = enviar(db, None, "✅ Agenda familiar", "Los avisos con pantalla bloqueada funcionan.", "prueba", args.simular)
        print(f"Aviso de prueba enviado a {n} teléfono(s).")
    elif args.resumen:
        correr_resumen(db, args.simular)
    else:
        correr_avisos(db, args.simular)


if __name__ == "__main__":
    main()
