"""Servidor FastAPI de telemetria — Modo demo basado en electroSim
Provisto por la catedra para TP05 — Desarrollo de Aplicaciones II (UADE).

Implementa todos los endpoints de API.md y de las especificaciones del PDF:
  - GET  /telemetria?modelo=go2|g1
  - GET  /motores
  - GET  /imu
  - GET  /bms
  - GET  /fuerzas
  - GET  /info
  - GET  /modo
  - WS   /ws  (streaming push en tiempo real a 10 Hz)
"""

from __future__ import annotations

import argparse
import asyncio
import math
import base64
import os
import random
import sys
import time
import uvicorn
from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(
    title="Unitree Telemetry API — TP05",
    description="Servidor FastAPI de telemetria robotica en tiempo real (solo lectura)",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

inicio = time.time()
modelo_actual = "go2"

MOTORES_GO2 = [
    "FR_hip", "FR_thigh", "FR_calf",
    "FL_hip", "FL_thigh", "FL_calf",
    "RR_hip", "RR_thigh", "RR_calf",
    "RL_hip", "RL_thigh", "RL_calf",
]

MOTORES_G1 = [
    "left_hip_pitch", "left_hip_roll", "left_hip_yaw", "left_knee", "left_ankle_pitch", "left_ankle_roll",
    "right_hip_pitch", "right_hip_roll", "right_hip_yaw", "right_knee", "right_ankle_pitch", "right_ankle_roll",
    "waist_yaw", "waist_roll", "waist_pitch",
    "left_shoulder_pitch", "left_shoulder_roll", "left_shoulder_yaw", "left_elbow", "left_wrist_roll", "left_wrist_pitch", "left_wrist_yaw",
    "right_shoulder_pitch", "right_shoulder_roll", "right_shoulder_yaw", "right_elbow", "right_wrist_roll", "right_wrist_pitch", "right_wrist_yaw",
]


def simular_motor(i: int, modelo: str = "go2") -> dict:
    t = time.time() - inicio
    fase = i * 0.45
    angulo = math.sin(t * 1.2 + fase) * 30.0
    velocidad = math.cos(t * 1.2 + fase) * 5.0
    torque = abs(math.sin(t * 0.8 + i)) * 20.0
    temp_base = 28.0 + (i % 12) * 0.8
    # Aumenta con el uso hasta superar los 40 y acercarse a los 60 grados de alerta
    temperatura = temp_base + min(t / 45.0, 1.0) * 28.0 + random.uniform(-0.5, 0.5)

    if modelo == "go2":
        nombre = MOTORES_GO2[i] if i < len(MOTORES_GO2) else f"Motor_{i}"
    else:
        nombre = MOTORES_G1[i] if i < len(MOTORES_G1) else f"Motor_{i}"

    return {
        "id": i,
        "nombre": nombre,
        "angulo": round(angulo, 2),
        "velocidad": round(velocidad, 3),
        "torque": round(torque, 2),
        "temperatura": round(temperatura, 1),
    }


def simular_imu() -> dict:
    t = time.time() - inicio
    return {
        "roll": round(math.sin(t * 0.3) * 5.0, 2),
        "pitch": round(math.sin(t * 0.5) * 8.0, 2),
        "yaw": round(((t * 12.0) % 360.0) - 180.0, 2),
        "ax": round(random.gauss(0.0, 0.05), 3),
        "ay": round(random.gauss(0.0, 0.05), 3),
        "az": round(9.81 + random.gauss(0.0, 0.02), 3),
    }


def simular_bms() -> dict:
    t = time.time() - inicio
    soc = max(20.0, 95.0 - t / 600.0)
    return {
        "soc": round(soc, 1),
        "corriente": round(1200.0 + random.uniform(-50.0, 50.0), 0),
        "temperatura": round(32.0 + random.uniform(-1.0, 1.0), 1),
        "celdas": [round(3.7 + random.uniform(-0.05, 0.05), 3) for _ in range(10)],
    }


def obtener_telemetria_data(modelo: str = "go2") -> dict:
    global modelo_actual
    modelo_actual = modelo
    n_motores = 12 if modelo == "go2" else 29
    t = time.time() - inicio

    if modelo == "go2":
        gait = math.sin(t * 3.5)
        fuerzas = {
            "FR": 1 if gait > 0 else 0,
            "RL": 1 if gait > 0 else 0,
            "FL": 1 if gait <= 0 else 0,
            "RR": 1 if gait <= 0 else 0,
        }
    else:
        fuerzas = {}

    return {
        "modelo": modelo,
        "ts": round(t, 2),
        "motores": [simular_motor(i, modelo) for i in range(n_motores)],
        "imu": simular_imu(),
        "bms": simular_bms(),
        "fuerzas": fuerzas,
    }


@app.get("/telemetria")
def telemetria(modelo: str = Query(default="go2")):
    return obtener_telemetria_data(modelo)


@app.get("/motores")
def motores(modelo: str = Query(default="go2")):
    data = obtener_telemetria_data(modelo)
    return {"modelo": modelo, "n_motores": len(data["motores"]), "motores": data["motores"]}


@app.get("/imu")
def imu():
    return simular_imu()


@app.get("/bms")
def bms():
    return simular_bms()


@app.get("/fuerzas")
def fuerzas(modelo: str = Query(default="go2")):
    return obtener_telemetria_data(modelo)["fuerzas"]


@app.get("/info")
def info(modelo: str = Query(default="go2")):
    is_go2 = (modelo == "go2")
    return {
        "modelo": modelo,
        "nombre": "Unitree Go2 (Cuadrupedo)" if is_go2 else "Unitree G1 (Humanoide)",
        "tipo": "cuadrupedo" if is_go2 else "humanoide",
        "n_motores": 12 if is_go2 else 29,
        "motores_nombres": MOTORES_GO2 if is_go2 else MOTORES_G1,
        "patas": ["FR", "FL", "RR", "RL"] if is_go2 else [],
        "frecuencia_hz": 10,
        "modo": "demo",
    }


@app.get("/modo")
def modo():
    return {"modo": "demo", "robot": modelo_actual}


@app.get("/")
def raiz_dashboard():
    # Permite abrir directamente http://127.0.0.1:8001 en el navegador
    posibles = [
        os.path.join(os.path.dirname(__file__), "dashboard.html"),
        os.path.join(os.getcwd(), "mi_dashboard_tp05", "dashboard.html"),
        os.path.join(os.getcwd(), "dashboard.html"),
    ]
    for ruta in posibles:
        if os.path.exists(ruta):
            return FileResponse(ruta)
    return {"mensaje": "Unitree Telemetry Server TP05 OK. Abrir dashboard.html"}


@app.get("/dashboard.html")
def servir_html():
    return raiz_dashboard()


@app.get("/dashboard.js")
def servir_js():
    posibles = [
        os.path.join(os.path.dirname(__file__), "dashboard.js"),
        os.path.join(os.getcwd(), "mi_dashboard_tp05", "dashboard.js"),
        os.path.join(os.getcwd(), "dashboard.js"),
    ]
    for ruta in posibles:
        if os.path.exists(ruta):
            return FileResponse(ruta, media_type="application/javascript")
    return {"error": "dashboard.js no encontrado"}


@app.get("/dashboard.css")
def servir_css():
    posibles = [
        os.path.join(os.path.dirname(__file__), "dashboard.css"),
        os.path.join(os.getcwd(), "mi_dashboard_tp05", "dashboard.css"),
        os.path.join(os.getcwd(), "dashboard.css"),
    ]
    for ruta in posibles:
        if os.path.exists(ruta):
            return FileResponse(ruta, media_type="text/css")
    return {"error": "dashboard.css no encontrado"}


@app.post("/guardar_csv")
async def guardar_csv_endpoint(request: Request):
    body = await request.body()
    contenido = body.decode("utf-8")
    rutas = [
        os.path.join(os.getcwd(), "mi_dashboard_tp05", "capturas", "telemetria_captura_muestra.csv"),
        os.path.join(os.getcwd(), "mi_dashboard_tp05", "telemetria_captura_muestra.csv"),
        os.path.join(os.getcwd(), "UadeRobotLab", "05LaboratoriosTPs", "TP05_Desarrollo_de_Aplicaciones_II", "mi_dashboard", "capturas", "telemetria_captura_muestra.csv"),
    ]
    guardado_en = []
    for r in rutas:
        try:
            os.makedirs(os.path.dirname(r), exist_ok=True)
            with open(r, "w", encoding="utf-8") as f:
                f.write(contenido)
            guardado_en.append(r)
        except Exception:
            pass
    return {"status": "ok", "guardado_en": guardado_en}


@app.post("/guardar_captura_pantalla")
async def guardar_captura_pantalla_endpoint(request: Request):
    try:
        data = await request.json()
        image_b64 = data.get("image", "")
        if "," in image_b64:
            image_b64 = image_b64.split(",", 1)[1]
        
        img_bytes = base64.b64decode(image_b64)
        nombre = data.get("nombre", f"captura_dashboard_{int(time.time())}.png")
        rutas = [
            os.path.join(os.getcwd(), "mi_dashboard_tp05", "capturas", nombre),
            os.path.join(os.getcwd(), "mi_dashboard_tp05", "capturas", "captura_dashboard_actual.png"),
            os.path.join(os.getcwd(), "UadeRobotLab", "05LaboratoriosTPs", "TP05_Desarrollo_de_Aplicaciones_II", "mi_dashboard", "capturas", nombre),
        ]
        guardado_en = []
        for r in rutas:
            try:
                os.makedirs(os.path.dirname(r), exist_ok=True)
                with open(r, "wb") as f:
                    f.write(img_bytes)
                guardado_en.append(r)
            except Exception:
                pass
        return {"status": "ok", "archivo": nombre, "guardado_en": guardado_en}
    except Exception as e:
        return {"status": "error", "mensaje": str(e)}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            await ws.send_json(obtener_telemetria_data(modelo_actual))
            await asyncio.sleep(0.1)  # 10 Hz, igual que electroSim
    except (WebSocketDisconnect, RuntimeError):
        pass


def liberar_puerto(puerto: int):
    """Si habia un proceso anterior colgado en el puerto, lo libera limpiamente."""
    import subprocess
    try:
        cmd = f'powershell -Command "Get-NetTCPConnection -LocalPort {puerto} -ErrorAction SilentlyContinue | ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }}"'
        subprocess.run(cmd, shell=True, capture_output=True)
        time.sleep(0.4)
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser(description="Servidor FastAPI de Telemetria — TP05")
    parser.add_argument("--puerto", "--port", type=int, default=8001, help="Puerto HTTP/WS (por defecto 8001)")
    parser.add_argument("--modelo", default="go2", choices=("go2", "g1"), help="Modelo inicial (go2 o g1)")
    args = parser.parse_args()

    liberar_puerto(args.puerto)

    global modelo_actual
    modelo_actual = args.modelo

    print("=" * 66)
    print("  SERVIDOR FASTAPI DE TELEMETRIA — TP05 (MODO DEMO)")
    print("  Universidad Argentina de la Empresa (UADE)")
    print("  Materia: Desarrollo de Aplicaciones II")
    print("=" * 66)
    print(f"  Robot inicial : {args.modelo.upper()}")
    print(f"  Direccion     : http://127.0.0.1:{args.puerto}")
    print(f"  WebSocket     : ws://127.0.0.1:{args.puerto}/ws (10 Hz push)")
    print(f"  Docs Swagger  : http://127.0.0.1:{args.puerto}/docs")
    print("=" * 66)
    print("  Presiona Ctrl+C para detener el servidor.\n")

    uvicorn.run(app, host="0.0.0.0", port=args.puerto, log_level="warning")


if __name__ == "__main__":
    main()
