# 🤖 Dashboard Web de Telemetría Robótica — TP05
### Materia: Desarrollo de Aplicaciones II (UADE)

Este proyecto contiene la solución completa para el estudiante correspondiente al **Trabajo Práctico Obligatorio Nº 5 (TP05)**: visualización y análisis en tiempo real de telemetría de robots **Unitree Go2** (cuadrúpedo) y **Unitree G1** (humanoide) mediante una arquitectura web orientada a servicios.

---

## 📁 Estructura de Archivos

```text
mi_dashboard_tp05/
├── dashboard.html                   # Estructura del dashboard, 4 paneles y controles
├── dashboard.css                    # Estilos modernos dark-mode, semáforos térmicos y gauges
├── dashboard.js                     # Lógica en JS ES6+, WebSocket, Polling, Chart.js y exportación CSV
├── telemetria_captura_muestra.csv   # Muestra capturada con >10 registros de telemetría
├── DOCUMENTO_TECNICO.md             # Informe técnico completo (arquitectura, patrones, análisis)
├── INICIAR_DASHBOARD.bat            # Script de inicio rápido (abre el dashboard en el navegador)
└── README.md                        # Esta guía
```

---

## 🚀 Cómo Ejecutar

1. **Levantar el Backend / Simulador**:
   - Ir a la carpeta: `UadeRobotLab\05LaboratoriosTPs\TP05_Desarrollo_de_Aplicaciones_II`
   - Ejecutar `INICIAR_TP05.bat` y elegir el robot (1 = G1, 2 = Go2).
   - El backend quedará escuchando en `http://127.0.0.1:8001`.

2. **Abrir el Dashboard**:
   - Hacer doble clic en [`INICIAR_DASHBOARD.bat`](file:///c:/Users/facun/Documents/Facultad/Materias/Desarrollo%20de%20apps%202/Tp%20lab/mi_dashboard_tp05/INICIAR_DASHBOARD.bat) (o abrir [`dashboard.html`](file:///c:/Users/facun/Documents/Facultad/Materias/Desarrollo%20de%20apps%202/Tp%20lab/mi_dashboard_tp05/dashboard.html) directamente en Google Chrome, Edge o Firefox).
   - El dashboard se conectará automáticamente vía **WebSocket a 10 Hz** (o podés seleccionar **REST Polling** desde la barra superior).

---

## 🎯 Paneles y Funcionalidades Desarrolladas

### 1. Panel de Motores
- Tabla interactiva con ID, nombre de articulación, temperatura, ángulo (°), velocidad (rad/s) y torque estimado (N·m).
- **Semáforo térmico idéntico a electroSim**:
  - 🟢 **Verde** (< 40°C): Normal
  - 🟡 **Amarillo** (40–60°C): Alerta moderada
  - 🔴 **Rojo** (> 60°C): Crítico / Sobrecalentamiento con animación pulsante.
- Resumen térmico en tiempo real (T° máx, promedio, torque máx y estado general).
- Gráfico histórico continuo (búfer circular de 300 muestras = 30s @ 10Hz) con selector de motores por checkboxes.

### 2. Panel IMU (Sistema Inercial)
- Indicadores numéricos de Roll, Pitch, Yaw y acelerómetro 3D ($a_x, a_y, a_z$).
- **Horizonte Artificial** reactivo que rota e inclina según los ángulos de alabeo y cabeceo.
- Gráfico de líneas histórico en tiempo real con ventana deslizante de 80 muestras.

### 3. Panel BMS (Gestión de Batería)
- Gauge circular animado con porcentaje de Estado de Carga (SOC).
- Corriente de consumo (mA), temperatura de batería (°C) y tensión promedio de celda.
- Visualización detallada de voltajes individuales de celda (C1 a C10).

### 4. Panel de Fuerzas por Pata (Contactos)
- Diagrama 2D del chasis con indicadores para **FL** (delantera izq), **FR** (delantera der), **RL** (trasera izq) y **RR** (trasera der).
- Contador de patas en apoyo y detección automática de la fase de marcha (apoyo cuádruple, trote diagonal, salto).
- Detección automática del robot humanoide G1 (indicando su cinemática bípeda).

### 5. Captura y Exportación CSV en el Navegador
- Botón **"Capturar Muestra"**: registra el estado instantáneo de todos los subsistemas.
- Botón **"Exportar CSV"**: genera y descarga un archivo `.csv` en el cliente usando la API `Blob` sin pasar por el servidor.
- **Auto-captura por alarma**: registra automáticamente snapshots si algún motor supera los 60°C.
- Manejo robusto de reconexión y tolerancia a caídas de red.
