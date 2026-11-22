"""
Respaldo de la Agenda familiar.

    python respaldo.py                       # guarda respaldo-AAAA-MM-DD.json
    python respaldo.py --restaurar ARCHIVO   # vuelve a subir un respaldo (no borra nada)

Córrelo en tu computadora de vez en cuando y guarda el archivo en un lugar
privado (contiene toda la agenda familiar).
"""
from __future__ import annotations

import argparse
import json
from datetime import date, datetime

from avisos import conectar

COLECCIONES = ["miembros", "familia", "categorias", "eventos", "listas", "items"]


def a_json(v):
    if isinstance(v, datetime):
        return {"__fecha__": v.isoformat()}
    raise TypeError(type(v))


def de_json(d: dict):
    if "__fecha__" in d:
        return datetime.fromisoformat(d["__fecha__"])
    return d


def respaldar(db) -> str:
    datos = {c: {d.id: d.to_dict() for d in db.collection(c).stream()} for c in COLECCIONES}
    nombre = f"respaldo-{date.today().isoformat()}.json"
    with open(nombre, "w", encoding="utf-8") as f:
        json.dump(datos, f, ensure_ascii=False, indent=1, default=a_json)
    print(f"Respaldo guardado en {nombre}: " + ", ".join(f"{c} {len(v)}" for c, v in datos.items()))
    return nombre


def restaurar(db, archivo: str) -> None:
    with open(archivo, encoding="utf-8") as f:
        datos = json.load(f, object_hook=de_json)
    for c, docs in datos.items():
        for i, (id_, d) in enumerate(docs.items()):
            db.collection(c).document(id_).set(d)
        print(f"{c}: {len(docs)} restaurados")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--restaurar", metavar="ARCHIVO")
    a = p.parse_args()
    db = conectar()
    restaurar(db, a.restaurar) if a.restaurar else respaldar(db)
