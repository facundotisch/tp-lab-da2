# Documento Técnico — Dashboard Web de Telemetría Robótica
**Materia:** Desarrollo de Aplicaciones II — UADE  
**Trabajo Práctico:** TP 05 · TPO  
**Proyecto:** Dashboard Web de Telemetría en Tiempo Real para Robots Unitree (Go2 / G1)  

---

## 1. Descripción de la Arquitectura del Sistema

La solución implementa una **arquitectura cliente-servidor desacoplada** orientada a servicios (SOA). Esta arquitectura permite supervisar en tiempo real el estado físico, energético y cinemático de robots cuadrúpedos (Go2) y humanoides (G1) sin necesidad de software de escritorio ni dependencias nativas del sistema operativo en el cliente.

```
┌──────────────────────────────────────────────────────────┐
│                   CAPA DE SERVICIOS (Backend)            │
│  FastAPI (Python) + Uvicorn                              │
│  - Endpoint REST: GET /telemetria, /motores, /info...    │
│  - Endpoint WebSocket: WS /ws (Push ~10 Hz)              │
│  - Middleware: CORS (Cross-Origin Resource Sharing)      │
└────────────────────────────┬─────────────────────────────┘
                             │ JSON Data (HTTP / WS)
┌────────────────────────────▼─────────────────────────────┐
│                 CAPA DE PRESENTACIÓN (Frontend)          │
│  HTML5 + CSS3 (Modern Dark Theme) + JavaScript (ES6+)    │
│  - TelemetryClient (Facade + Reconnection Strategy)      │
│  - Dispatcher & State Store (Observer Pattern)           │
│  - Visualización: Chart.js (Line Charts) + DOM Dinámico  │
│  - Exportación: Web Blob API (Client-side CSV generator) │
└──────────────────────────────────────────────────────────┘
```

### 1.1 Endpoints Consumidos
El frontend interactúa con los siguientes servicios provistos por la API:
- **`GET /info`**: Metadatos del robot activo (nombre, tipo, cantidad de motores y nombres de articulaciones). Permite la auto-adaptación de la UI al robot conectado.
- **`GET /telemetria`**: Snapshot integral unificado de todos los subsistemas (motores, IMU, BMS, fuerzas de apoyo).
- **`WS /ws`**: Canal bidireccional / push que transmite snapshots de telemetría a 10 Hz continuos (100 ms de período).

---

## 2. Patrones de Diseño e Integración Aplicados

1. **Patrón Facade (`TelemetryClient`)**:  
   Encapsula la complejidad del protocolo subyacente (WebSocket con handshake y reconexión exponencial vs. Polling REST asíncrono con `AbortController`). El resto de la aplicación sólo interactúa mediante métodos de alto nivel (`connect`, `disconnect`, `on('data')`).

2. **Patrón Observer (Event Bus / Reactive UI)**:  
   La llegada de cada snapshot de telemetría notifica a los suscriptores independientes:
   - Panel de Motores (actualización de tabla y semáforo térmico).
   - Panel IMU (actualización de métricas, horizonte artificial y gráfico Chart.js).
   - Panel BMS (cálculo de gauge de batería y voltajes de celdas C1-C10).
   - Panel de Fuerzas (diagrama 2D de marcha del cuadrúpedo).
   - Módulo de Alerta Térmica y Captura Automática.

3. **Patrón Adapter (Normalización de Modelos Go2 / G1)**:  
   Abstrae las diferencias estructurales entre el robot cuadrúpedo **Go2** (12 motores, 4 sensores de pata) y el humanoide **G1** (29 motores, cinemática bípeda), adaptando las tablas y gráficos dinámicamente según la respuesta de `/info`.

---

## 3. Decisiones de Diseño de los Paneles

| Panel | Decisiones Técnicas y de Diseño | Justificación |
|---|---|---|
| **Motores** | Tabla reactiva con semáforo térmico por celda: Verde (<40°C), Amarillo (40–60°C), Rojo (>60°C). Resumen térmico superior (T° máx, promedio, torque máx). Gráfico histórico con checkboxes selectores. | Permite identificar visualmente y en milisegundos qué articulaciones sufren sobrecalentamiento. El selector de motores evita la saturación visual al permitir monitorear curvas específicas. |
| **IMU** | Indicadores numéricos de Roll, Pitch, Yaw y aceleración ($a_x, a_y, a_z$). Horizonte artificial estilizado y gráfico de líneas continuo. | El horizonte artificial ofrece conciencia situacional inmediata al operador. El gráfico de líneas de 80 muestras muestra la periodicidad del paso de marcha. |
| **BMS** | Gauge circular SVG animado para el SOC (%), métricas de corriente y temperatura, y grid de celdas individuales C1–C10. | Facilita detectar desbalance de celdas de litio y consumo excesivo en maniobras de alto torque. |
| **Fuerzas** | Diagrama 2D del chasis (FL, FR, RL, RR) con estados de apoyo y deducción de fase de marcha (trote, apoyo cuádruple, salto). | Visualización intuitiva de la postura y marcha del robot cuadrúpedo. Si se conecta un G1, se indica automáticamente su naturaleza bípeda. |
| **Exportador CSV** | Generación en memoria en el cliente mediante la Web API `Blob` y descarga mediante elemento `<a>` temporal. | Cero sobrecarga en el servidor; preserva la privacidad y rapidez de la exportación sin requerir endpoints adicionales. |

---

## 4. Análisis Comparativo: REST Polling vs. WebSocket

| Criterio | REST Polling (HTTP GET cada 500 ms) | WebSocket (`ws://` Push 10 Hz) |
|---|---|---|
| **Latencia de Entrega** | Alta e irregular ($250\text{ ms} - 500\text{ ms} + \text{RTT}$). Los datos envejecen en el intervalo. | Mínima (< 15 ms). Los datos se empujan ni bien son producidos por el simulador/robot. |
| **Sobrecarga de Red (Overhead)** | **Muy alta**. Cada petición reenvía headers HTTP (cookies, CORS, user-agent), ~800 bytes por consulta. | **Mínima**. Tras el handshake inicial (HTTP 101), la trama WebSocket añade solo 2–6 bytes de framing por mensaje. |
| **Carga de CPU en Servidor** | Alta por la creación constante de sockets TCP, parsing HTTP y enrutamiento en cada ciclo. | Baja; conexión TCP persistente y un único bucle asíncrono con `send_json()`. |
| **Comportamiento ante caídas** | Tolera desconexiones transitorias de forma natural (el próximo `fetch` simplemente reintenta). | Requiere lógica de reconexión explícita con backoff para restablecer el canal tras un cierre abrupto. |
| **Idoneidad para Telemetría** | Adecuado solo para tableros estáticos o de baja frecuencia (ej. estado de batería cada 5 segundos). | **Óptimo para telemetría robótica en tiempo real**, animación de gráficos y visualización de dinámicas rápidas. |

---

## 5. Conclusión y Verificación

El dashboard desarrollado cumple íntegramente con los requerimientos técnicos y pedagógicos del TP05:
- Actualización fluida sin parpadeos usando búferes circulares deslizantes (Chart.js sin recrear componentes).
- Tolerancia a fallos de red con mantenimiento del último estado conocido.
- Exportación client-side de datos capturados para análisis posterior.
- Experiencia de usuario de alta fidelidad, comparable a la herramienta nativa *electroSim*, pero con la versatilidad de la web.
