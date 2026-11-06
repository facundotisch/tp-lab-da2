"""Servidor FastAPI de Telemetría Robótica — Modo Demo TP05
UADE · Desarrollo de Aplicaciones II

Este servidor es 100% autónomo. NO requiere MuJoCo ni abre ventanas 3D.
Expone los mismos endpoints REST y WebSocket que el robot real / simulador:
  - GET  /telemetria
  - GET  /motores
  - GET  /imu
  - GET  /bms
  - GET  /fuerzas
  - GET  /info
  - WS   /ws   (Push en tiempo real a 10 Hz)
"""

from __future__ import annotations
import asyncio
import math
import random
import time
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="Unitree Telemetry API — Servidor Demo Autónomo",
    description="Servidor de telemetría robótica en tiempo real (solo lectura)",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

INICIO = time.time()
MODELO = "go2"
N_MOTORES = 12

MOTORES_NOMBRES_GO2 = [
    "FR_hip", "FR_thigh", "FR_calf",
    "FL_hip", "FL_thigh", "FL_calf",
    "RR_hip", "RR_thigh", "RR_calf",
    "RL_hip", "RL_thigh", "RL_calf"
]

def simular_motor(i: int, t: float) -> dict:
    fase = i * 0.45
    angulo = math.sin(t * 1.2 + fase) * 32.0
    velocidad = math.cos(t * 1.2 + fase) * 2.8
    torque = abs(math.sin(t * 0.9 + i)) * 14.0 + 2.0
    temp_base = 32.0 + i * 0.6
    temperatura = temp_base + min(t / 30.0, 1.0) * 26.0 + math.sin(t * 0.2 + i) * 3.0 + random.uniform(-0.2, 0.2)
    
    nombre = MOTORES_NOMBRES_GO2[i] if i < len(MOTORES_NOMBRES_GO2) else f"Motor_{i}"
    return {
        "id": i,
        "nombre": nombre,
        "angulo": round(angulo, 2),
        "velocidad": round(velocidad, 3),
        "torque": round(torque, 2),
        "temperatura": round(temperatura, 1)
    }

def obtener_telemetria() -> dict:
    t = time.time() - INICIO
    motores = [simular_motor(i, t) for i in range(N_MOTORES)]
    
    roll = math.sin(t * 0.8) * 4.5 + random.uniform(-0.1, 0.1)
    pitch = math.sin(t * 1.4) * 6.8 + random.uniform(-0.1, 0.1)
    yaw = round(((t * 8.5) % 360) - 180, 2)
    ax = round(math.sin(t * 1.2) * 0.6 + random.uniform(-0.02, 0.02), 3)
    ay = round(math.cos(t * 1.2) * 0.4 + random.uniform(-0.02, 0.02), 3)
    az = round(9.81 + math.sin(t * 2.4) * 0.8, 3)

    soc = max(15, 95.0 - (t / 120.0) * 10.0)
    corriente = round(1150 + math.sin(t * 0.6) * 350 + random.uniform(-20, 20))
    temp_bms = round(31.5 + math.sin(t * 0.05) * 4.0, 1)
    celdas = [round(3.72 - (100 - soc) * 0.005 + math.sin(t * 0.1 + idx) * 0.02, 3) for idx in range(10)]

    gait = math.sin(t * 3.5)
    fuerzas = {
        "FR": 1 if gait > 0 else 0,
        "RL": 1 if gait > 0 else 0,
        "FL": 1 if gait <= 0 else 0,
        "RR": 1 if gait <= 0 else 0
    }

    return {
        "modelo": MODELO,
        "ts": round(t, 2),
        "motores": motores,
        "imu": {
            "roll": round(roll, 2),
            "pitch": round(pitch, 2),
            "yaw": yaw,
            "ax": ax,
            "ay": ay,
            "az": az
        },
        "bms": {
            "soc": round(soc),
            "corriente": corriente,
            "temperatura": temp_bms,
            "celdas": celdas
        },
        "fuerzas": fuerzas
    }

@app.get("/telemetria")
def endpoint_telemetria():
    return obtener_telemetria()

@app.get("/motores")
def endpoint_motores():
    t = obtener_telemetria()
    return {"modelo": MODELO, "n_motores": N_MOTORES, "motores": t["motores"]}

@app.get("/imu")
def endpoint_imu():
    return obtener_telemetria()["imu"]

@app.get("/bms")
def endpoint_bms():
    return obtener_telemetria()["bms"]

@app.get("/fuerzas")
def endpoint_fuerzas():
    return obtener_telemetria()["fuerzas"]

@app.get("/info")
def endpoint_info():
    return {
        "modelo": MODELO,
        "nombre": "Unitree Go2 (Cuadrúpedo)",
        "tipo": "cuadrupedo",
        "n_motores": N_MOTORES,
        "motores_nombres": MOTORES_NOMBRES_GO2,
        "patas": ["FR", "FL", "RR", "RL"],
        "frecuencia_hz": 10,
        "modo": "demo"
    }

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            await ws.send_json(obtener_telemetria())
            await asyncio.sleep(0.1)  # 10 Hz
    except (WebSocketDisconnect, RuntimeError):
        pass

def main():
    print("=" * 66)
    print("  SERVIDOR FASTAPI DE TELEMETRÍA (MODO DEMO AUTÓNOMO)")
    print("  UADE · Desarrollo de Aplicaciones II")
    print("=" * 66)
    print("  Robot : Go2   Modo: Demo (sin simulador 3D)")
    print("  Servidor escuchando en: http://127.0.0.1:8001")
    print("  WebSocket listo en:      ws://127.0.0.1:8001/ws")
    print("  Documentación Swagger:   http://127.0.0.1:8001/docs")
    print("=" * 66)
    uvicorn.run(app, host="0.0.0.0", port=8001, log_level="warning")

if __name__ == "__main__":
    main()
