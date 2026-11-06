/**
 * ==============================================================================
 * DASHBOARD TELEMETRÍA ROBÓTICA UNITREE — TP05
 * Desarrollo de Aplicaciones II · UADE
 * 
 * Arquitectura: Cliente-Servidor (FastAPI <-> Vanilla ES6+ Web Dashboard)
 * Patrones aplicados: Observer (Event Bus), Facade (TelemetryClient), Adapter (Normalización)
 * ==============================================================================
 */

// ==============================================================================
// 1. CONFIGURACIÓN Y CONSTANTES
// ==============================================================================
const CONFIG = {
  DEFAULT_API_URL: 'http://127.0.0.1:8001',
  DEFAULT_WS_URL: 'ws://127.0.0.1:8001/ws',
  HIST_SIZE_MOTORS: 300, // 30s @ 10Hz (especificación electroSim)
  HIST_SIZE_IMU: 80,     // Ventana deslizante para IMU
  DEFAULT_POLL_INTERVAL: 500, // ms
  MAX_RECONNECT_DELAY: 5000,  // ms
  OVERHEAT_THRESHOLD: 60.0,   // °C
  WARNING_TEMP_THRESHOLD: 40.0 // °C
};

// Paleta de colores para gráficos
const CHART_COLORS = [
  '#38bdf8', '#f43f5e', '#10b981', '#fbbf24', '#a855f7',
  '#ec4899', '#3b82f6', '#14b8a6', '#f97316', '#8b5cf6',
  '#06b6d4', '#84cc16', '#e11d48', '#6366f1', '#d946ef'
];

// ==============================================================================
// 2. ESTADO GLOBAL DE LA APLICACIÓN
// ==============================================================================
const State = {
  robotModel: 'go2',
  robotName: 'Go2 (Cuadrúpedo)',
  numMotors: 12,
  motorNames: [],
  isConnected: false,
  commMode: 'ws', // 'ws' | 'poll'
  pollIntervalMs: CONFIG.DEFAULT_POLL_INTERVAL,
  lastSnapshot: null,
  
  // Búferes circulares históricos
  history: {
    ts: [],
    imu: { roll: [], pitch: [], yaw: [] },
    motors: {} // { motorId: [temp1, temp2, ...] }
  },

  // Filtros de motores para el gráfico térmico
  selectedMotorsForChart: new Set([0, 1, 2, 3]),

  // Capturas de sesión para exportación CSV
  capturedSamples: [],
  autoAlertCaptureEnabled: true,
  lastOverheatAlertTime: 0,

  // Métricas de red y sesión
  packetCount: 0,
  lastPacketTime: Date.now(),
  currentHz: 0,
  sessionStartTime: Date.now()
};

// ==============================================================================
// 3. FACHADA DE COMUNICACIÓN (FACADE PATTERN): TelemetryClient
// ==============================================================================
class TelemetryClient {
  constructor() {
    this.ws = null;
    this.pollTimer = null;
    this.pollAbortCtrl = null;
    this.simTimer = null;
    this.listeners = {
      data: [],
      status: [],
      info: []
    };
    this.reconnectTimeout = null;
    this.reconnectAttempts = 0;
    this.isManualDisconnect = false;
  }

  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(cb => {
        try { cb(data); } catch (err) { console.error(`Error en listener [${event}]:`, err); }
      });
    }
  }

  async connect(baseUrl, mode = 'sim') {
    this.disconnect();
    this.isManualDisconnect = false;
    this.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, '') : 'http://127.0.0.1:8001';
    this.mode = mode;

    if (this.mode === 'sim') {
      this.startDirectSimulation();
      return;
    }

    this.emit('status', { state: 'connecting', message: 'Conectando...' });

    // 1. Consultar metadatos del robot (/info) primero (Adapter / Facade)
    await this.fetchRobotInfo();

    // 2. Iniciar según el modo elegido
    if (this.mode === 'ws') {
      this.connectWebSocket();
    } else {
      this.startPolling();
    }
  }

  disconnect() {
    this.isManualDisconnect = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.simTimer) {
      clearInterval(this.simTimer);
      this.simTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.pollAbortCtrl) {
      this.pollAbortCtrl.abort();
      this.pollAbortCtrl = null;
    }
    this.emit('status', { state: 'disconnected', message: 'Desconectado' });
  }

  async fetchRobotInfo() {
    try {
      const resp = await fetch(`${this.baseUrl}/info`, { cache: 'no-store' });
      if (resp.ok) {
        const info = await resp.json();
        this.emit('info', info);
      }
    } catch (err) {
      console.warn('No se pudo obtener /info directamente (se deducirá del payload):', err.message);
    }
  }

  connectWebSocket() {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';
    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.emit('status', { state: 'connected', message: 'Conectado (WebSocket 10 Hz)' });
      };

      this.ws.onmessage = (event) => {
        try {
          const telemetry = JSON.parse(event.data);
          this.emit('data', telemetry);
        } catch (e) {
          console.error('Error parseando JSON WebSocket:', e);
        }
      };

      this.ws.onerror = (err) => {
        console.warn('Error en WebSocket:', err);
      };

      this.ws.onclose = () => {
        if (!this.isManualDisconnect) {
          this.emit('status', { state: 'connecting', message: 'Reconectando WebSocket...' });
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      this.emit('status', { state: 'disconnected', message: 'Error de conexión' });
      this.scheduleReconnect();
    }
  }

  startPolling() {
    this.emit('status', { state: 'connected', message: `Conectado (REST Polling ${State.pollIntervalMs}ms)` });

    const poll = async () => {
      if (this.isManualDisconnect) return;
      try {
        this.pollAbortCtrl = new AbortController();
        const res = await fetch(`${this.baseUrl}/telemetria`, {
          signal: this.pollAbortCtrl.signal,
          cache: 'no-store'
        });
        if (res.ok) {
          const telemetry = await res.json();
          this.emit('data', telemetry);
          this.reconnectAttempts = 0;
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          this.emit('status', { state: 'connecting', message: 'Reintentando polling...' });
        }
      }
    };

    poll();
    this.pollTimer = setInterval(poll, State.pollIntervalMs);
  }

  startDirectSimulation() {
    this.emit('status', { state: 'connected', message: '⚡ Simulación Directa en Navegador (10 Hz)' });
    const simStartTime = Date.now();

    const simMotorNamesGo2 = [
      "FR_hip", "FR_thigh", "FR_calf",
      "FL_hip", "FL_thigh", "FL_calf",
      "RR_hip", "RR_thigh", "RR_calf",
      "RL_hip", "RL_thigh", "RL_calf"
    ];

    this.simTimer = setInterval(() => {
      if (this.isManualDisconnect) return;
      const t = (Date.now() - simStartTime) / 1000.0;
      const isGo2 = (State.robotModel === 'go2');
      const nMotors = isGo2 ? 12 : 29;

      // Motores
      const motores = [];
      for (let i = 0; i < nMotors; i++) {
        const fase = i * 0.45;
        const angulo = Math.sin(t * 1.2 + fase) * 32;
        const velocidad = Math.cos(t * 1.2 + fase) * 2.8;
        const torque = Math.abs(Math.sin(t * 0.9 + i)) * 14 + 2;
        const tempBase = 32 + i * 0.6;
        // La temperatura sube gradualmente simulando uso y se estabiliza con variaciones
        const temp = tempBase + Math.min(t / 30, 1) * 26 + (Math.sin(t * 0.2 + i) * 3) + (Math.random() * 0.4 - 0.2);
        
        motores.push({
          id: i,
          nombre: isGo2 ? simMotorNamesGo2[i] : `Motor_${i}`,
          angulo: parseFloat(angulo.toFixed(2)),
          velocidad: parseFloat(velocidad.toFixed(3)),
          torque: parseFloat(torque.toFixed(2)),
          temperatura: parseFloat(temp.toFixed(1))
        });
      }

      // IMU
      const roll = Math.sin(t * 0.8) * 4.5 + (Math.random() * 0.2 - 0.1);
      const pitch = Math.sin(t * 1.4) * 6.8 + (Math.random() * 0.2 - 0.1);
      const yaw = ((t * 8.5) % 360) - 180;
      const ax = Math.sin(t * 1.2) * 0.6 + (Math.random() * 0.05 - 0.025);
      const ay = Math.cos(t * 1.2) * 0.4 + (Math.random() * 0.05 - 0.025);
      const az = 9.81 + Math.sin(t * 2.4) * 0.8;

      // BMS
      const soc = Math.max(15, 95 - (t / 120) * 10);
      const corriente = Math.round(1150 + Math.sin(t * 0.6) * 350 + (Math.random() * 40 - 20));
      const bmsTemp = parseFloat((31.5 + Math.sin(t * 0.05) * 4).toFixed(1));
      const celdas = Array.from({ length: 10 }, (_, idx) => {
        return parseFloat((3.72 - (100 - soc) * 0.005 + Math.sin(t * 0.1 + idx) * 0.02).toFixed(3));
      });

      // Fuerzas patas
      const gait = Math.sin(t * 3.5);
      const fuerzas = isGo2 ? {
        FR: (gait > 0) ? 1 : 0,
        RL: (gait > 0) ? 1 : 0,
        FL: (gait <= 0) ? 1 : 0,
        RR: (gait <= 0) ? 1 : 0
      } : {};

      const snapshot = {
        modelo: State.robotModel,
        ts: parseFloat(t.toFixed(2)),
        motores,
        imu: {
          roll: parseFloat(roll.toFixed(2)),
          pitch: parseFloat(pitch.toFixed(2)),
          yaw: parseFloat(yaw.toFixed(2)),
          ax: parseFloat(ax.toFixed(3)),
          ay: parseFloat(ay.toFixed(3)),
          az: parseFloat(az.toFixed(3))
        },
        bms: {
          soc: Math.round(soc),
          corriente,
          temperatura: bmsTemp,
          celdas
        },
        fuerzas
      };

      this.emit('data', snapshot);
    }, 100);
  }
}

const client = new TelemetryClient();

// ==============================================================================
// 4. GESTIÓN DE GRÁFICOS (CHART.JS)
// ==============================================================================
let chartIMU = null;
let chartMotores = null;

function initCharts() {
  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    elements: { point: { radius: 0 } },
    scales: {
      x: {
        display: false,
        grid: { color: 'rgba(48, 54, 61, 0.3)' }
      },
      y: {
        grid: { color: 'rgba(48, 54, 61, 0.4)' },
        ticks: { color: '#8b949e', font: { size: 10 } }
      }
    },
    plugins: {
      legend: {
        labels: { color: '#e6edf3', font: { size: 11 }, boxWidth: 12 }
      },
      tooltip: { enabled: true }
    }
  };

  // Gráfico IMU (Roll, Pitch, Yaw)
  const ctxIMU = document.getElementById('chartIMU').getContext('2d');
  chartIMU = new Chart(ctxIMU, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Roll (°)', borderColor: '#38bdf8', borderWidth: 1.8, data: [] },
        { label: 'Pitch (°)', borderColor: '#f43f5e', borderWidth: 1.8, data: [] },
        { label: 'Yaw (°)', borderColor: '#fbbf24', borderWidth: 1.8, data: [] }
      ]
    },
    options: {
      ...commonOptions,
      scales: {
        ...commonOptions.scales,
        y: {
          ...commonOptions.scales.y,
          title: { display: true, text: 'Ángulo (°)', color: '#8b949e', font: { size: 10 } }
        }
      }
    }
  });

  // Gráfico Histórico de Motores
  const ctxMotores = document.getElementById('chartMotores').getContext('2d');
  chartMotores = new Chart(ctxMotores, {
    type: 'line',
    data: {
      labels: [],
      datasets: []
    },
    options: {
      ...commonOptions,
      scales: {
        ...commonOptions.scales,
        y: {
          ...commonOptions.scales.y,
          title: { display: true, text: 'Temperatura (°C)', color: '#8b949e', font: { size: 10 } }
        }
      }
    }
  });
}

function updateChartDatasets() {
  if (!chartMotores) return;
  const datasets = [];

  State.selectedMotorsForChart.forEach(motorId => {
    const motorName = State.motorNames[motorId] || `Motor ${motorId}`;
    const color = CHART_COLORS[motorId % CHART_COLORS.length];
    const data = State.history.motors[motorId] || [];

    datasets.push({
      label: `${motorName} (#${motorId})`,
      borderColor: color,
      borderWidth: 1.5,
      data: [...data]
    });
  });

  chartMotores.data.datasets = datasets;
  chartMotores.data.labels = State.history.ts;
  chartMotores.update('none');
}

// ==============================================================================
// 5. OBSERVER & ACTUALIZACIÓN DE PANELES
// ==============================================================================

// --- Panel 1: Motores y Semáforo de Temperatura ---
function updateMotorsPanel(motores) {
  if (!motores || !motores.length) return;

  const tbody = document.getElementById('tablaMotoresBody');
  let maxTemp = -Infinity;
  let sumTemp = 0;
  let maxTorque = 0;
  let overheatedMotors = [];

  const rowsHtml = motores.map(m => {
    const temp = Number(m.temperatura);
    const torque = Math.abs(Number(m.torque));
    const angulo = Number(m.angulo);
    const vel = Number(m.velocidad);

    if (temp > maxTemp) maxTemp = temp;
    sumTemp += temp;
    if (torque > maxTorque) maxTorque = torque;

    // Lógica del semáforo térmico (electroSim)
    let tempClass = 'temp-ok';
    if (temp >= CONFIG.OVERHEAT_THRESHOLD) {
      tempClass = 'temp-crit';
      overheatedMotors.push({ id: m.id, name: m.nombre, temp });
    } else if (temp >= CONFIG.WARNING_TEMP_THRESHOLD) {
      tempClass = 'temp-warn';
    }

    // Actualizar búfer circular del motor
    if (!State.history.motors[m.id]) State.history.motors[m.id] = [];
    State.history.motors[m.id].push(temp);
    if (State.history.motors[m.id].length > CONFIG.HIST_SIZE_MOTORS) {
      State.history.motors[m.id].shift();
    }

    const name = m.nombre || `Motor_${m.id}`;

    return `
      <tr>
        <td><strong>#${m.id}</strong></td>
        <td>${name}</td>
        <td><span class="temp-cell ${tempClass}">${temp.toFixed(1)} °C</span></td>
        <td>${angulo.toFixed(2)}°</td>
        <td>${vel.toFixed(3)} rad/s</td>
        <td>${torque.toFixed(2)} N·m</td>
      </tr>
    `;
  }).join('');

  tbody.innerHTML = rowsHtml;

  // Actualizar resumen térmico
  const avgTemp = (sumTemp / motores.length).toFixed(1);
  document.getElementById('motorMaxTemp').textContent = `${maxTemp.toFixed(1)} °C`;
  document.getElementById('motorAvgTemp').textContent = `${avgTemp} °C`;
  document.getElementById('motorMaxTorque').textContent = `${maxTorque.toFixed(2)} N·m`;

  const statusTag = document.getElementById('thermalStatusTag');
  if (overheatedMotors.length > 0) {
    statusTag.className = 'status-tag crit';
    statusTag.textContent = `Crítico (${overheatedMotors.length} sobrecalentado)`;
    handleOverheatAlert(overheatedMotors);
  } else if (maxTemp >= CONFIG.WARNING_TEMP_THRESHOLD) {
    statusTag.className = 'status-tag warn';
    statusTag.textContent = 'Alerta moderada';
  } else {
    statusTag.className = 'status-tag ok';
    statusTag.textContent = 'Óptimo';
  }
}

// --- Panel 2: IMU (Sistema Inercial) & Horizonte Artificial ---
function updateIMUPanel(imu) {
  if (!imu) return;

  const roll = Number(imu.roll);
  const pitch = Number(imu.pitch);
  const yaw = Number(imu.yaw);

  document.getElementById('imuRoll').textContent = `${roll.toFixed(2)}°`;
  document.getElementById('imuPitch').textContent = `${pitch.toFixed(2)}°`;
  document.getElementById('imuYaw').textContent = `${yaw.toFixed(2)}°`;

  document.getElementById('imuAx').textContent = Number(imu.ax || 0).toFixed(2);
  document.getElementById('imuAy').textContent = Number(imu.ay || 0).toFixed(2);
  document.getElementById('imuAz').textContent = Number(imu.az || 9.81).toFixed(2);

  // Actualizar Horizonte Artificial
  const horizonDisk = document.getElementById('horizonDisk');
  if (horizonDisk) {
    // Pitch desplaza en Y, Roll rota en grados
    const pitchOffset = Math.max(-45, Math.min(45, pitch)) * 1.2;
    horizonDisk.style.transform = `rotate(${-roll}deg) translateY(${pitchOffset}px)`;
    document.getElementById('horizonPitchRollText').textContent = `R: ${roll.toFixed(1)}° | P: ${pitch.toFixed(1)}°`;
  }

  // Búfer circular IMU
  State.history.imu.roll.push(roll);
  State.history.imu.pitch.push(pitch);
  State.history.imu.yaw.push(yaw);

  if (State.history.imu.roll.length > CONFIG.HIST_SIZE_IMU) {
    State.history.imu.roll.shift();
    State.history.imu.pitch.shift();
    State.history.imu.yaw.shift();
  }

  // Actualizar Chart IMU
  if (chartIMU) {
    chartIMU.data.labels = State.history.ts.slice(-State.history.imu.roll.length);
    chartIMU.data.datasets[0].data = State.history.imu.roll;
    chartIMU.data.datasets[1].data = State.history.imu.pitch;
    chartIMU.data.datasets[2].data = State.history.imu.yaw;
    chartIMU.update('none');
  }
}

// --- Panel 3: BMS (Batería y Celdas) ---
function updateBMSPanel(bms) {
  if (!bms) return;

  const soc = Math.max(0, Math.min(100, Number(bms.soc || 0)));
  const corriente = Number(bms.corriente || 0);
  const temp = Number(bms.temperatura || 0);
  const celdas = bms.celdas || [];

  document.getElementById('bmsSoc').textContent = Math.round(soc);
  document.getElementById('bmsCurrent').textContent = `${corriente} mA`;
  document.getElementById('bmsTemp').textContent = `${temp.toFixed(1)} °C`;

  // Indicador circular SVG (Gauge)
  const socCircle = document.getElementById('socCircle');
  if (socCircle) {
    const circumference = 2 * Math.PI * 42; // r=42
    const offset = circumference - (circumference * soc / 100);
    socCircle.style.strokeDashoffset = offset;

    if (soc > 50) socCircle.style.stroke = 'var(--temp-green)';
    else if (soc > 20) socCircle.style.stroke = 'var(--temp-yellow)';
    else socCircle.style.stroke = 'var(--temp-red)';
  }

  // Celdas individuales
  const celdasContainer = document.getElementById('celdasContainer');
  if (celdas.length > 0) {
    let avgCell = 0;
    celdasContainer.innerHTML = celdas.map((v, i) => {
      const vNum = Number(v);
      avgCell += vNum;
      return `
        <div class="cell-badge">
          <span class="c-name">C${i + 1}</span>
          <span class="c-val">${vNum.toFixed(3)}V</span>
        </div>
      `;
    }).join('');
    avgCell = (avgCell / celdas.length).toFixed(3);
    document.getElementById('bmsAvgCell').textContent = `${avgCell} V`;
  } else {
    celdasContainer.innerHTML = '<span class="text-muted" style="grid-column: span 5; font-size:0.75rem;">Sin datos de celdas</span>';
    document.getElementById('bmsAvgCell').textContent = '-- V';
  }
}

// --- Panel 4: Fuerzas y Contactos de Patas ---
function updateFuerzasPanel(fuerzas, modelo) {
  const isQuadruped = (modelo === 'go2');
  const robotChassis = document.getElementById('robotChassis');
  const fuerzasNote = document.getElementById('fuerzasNote');

  if (!isQuadruped) {
    // Es G1 (Humanoid)
    if (fuerzasNote) fuerzasNote.textContent = 'ℹ️ Robot humanoide G1 (Bípedo). El sensor de 4 patas aplica a cuadrúpedos Go2.';
    document.getElementById('patasApoyadasCount').textContent = 'N/A (Bípedo)';
    document.getElementById('gaitPhaseLabel').textContent = 'Marcha bípeda';
    ['FL', 'FR', 'RL', 'RR'].forEach(p => {
      const el = document.getElementById(`pata${p}`);
      if (el) el.className = 'leg-indicator airborne';
      const st = document.getElementById(`status${p}`);
      if (st) st.textContent = '—';
    });
    return;
  }

  if (!fuerzas) return;

  const patas = ['FL', 'FR', 'RL', 'RR'];
  let countApoyadas = 0;

  patas.forEach(p => {
    const supported = Boolean(fuerzas[p]);
    const el = document.getElementById(`pata${p}`);
    const st = document.getElementById(`status${p}`);

    if (supported) {
      countApoyadas++;
      if (el) el.className = 'leg-indicator supported';
      if (st) st.textContent = 'APOYADA ✓';
    } else {
      if (el) el.className = 'leg-indicator airborne';
      if (st) st.textContent = 'EN EL AIRE';
    }
  });

  document.getElementById('patasApoyadasCount').textContent = `${countApoyadas} / 4`;

  // Deducción de fase de marcha
  let fase = 'En movimiento';
  if (countApoyadas === 4) fase = 'Apoyo cuádruple (Firme)';
  else if (countApoyadas === 0) fase = 'Fase de vuelo / Salto';
  else if (countApoyadas === 2) {
    if ((fuerzas.FL && fuerzas.RR) || (fuerzas.FR && fuerzas.RL)) {
      fase = 'Trote diagonal (Gait)';
    } else {
      fase = 'Apoyo lateral / Transición';
    }
  } else if (countApoyadas === 3) {
    fase = 'Paso de apoyo triple';
  } else {
    fase = 'Apoyo simple';
  }
  document.getElementById('gaitPhaseLabel').textContent = fase;
}

// ==============================================================================
// 6. PIPELINE CENTRAL DE TELEMETRÍA (OBSERVER DISPATCHER)
// ==============================================================================
client.on('data', (data) => {
  State.lastSnapshot = data;
  State.packetCount++;

  // Timestamp histórico
  const ts = data.ts !== undefined ? Number(data.ts).toFixed(1) : ((Date.now() - State.sessionStartTime) / 1000).toFixed(1);
  document.getElementById('telemetryTs').textContent = ts;

  State.history.ts.push(ts);
  if (State.history.ts.length > CONFIG.HIST_SIZE_MOTORS) {
    State.history.ts.shift();
  }

  // Normalización del modelo
  if (data.modelo && data.modelo !== State.robotModel) {
    setRobotModel(data.modelo, data.motores ? data.motores.length : 12);
  }

  // Despacho a paneles individuales
  updateMotorsPanel(data.motores);
  updateIMUPanel(data.imu);
  updateBMSPanel(data.bms);
  updateFuerzasPanel(data.fuerzas, State.robotModel);

  // Actualizar gráfico de motores
  updateChartDatasets();
});

// Listener de estado de conexión
client.on('status', ({ state, message }) => {
  const indicator = document.getElementById('statusIndicator');
  const label = document.getElementById('statusLabel');

  indicator.className = `status-indicator ${state}`;
  label.textContent = message;

  const btnConnect = document.getElementById('btnConnect');
  if (state === 'connected') {
    State.isConnected = true;
    btnConnect.textContent = 'Desconectar';
    btnConnect.className = 'btn btn-ghost';
  } else if (state === 'connecting') {
    State.isConnected = false;
    btnConnect.textContent = 'Cancelando...';
  } else {
    State.isConnected = false;
    btnConnect.textContent = 'Conectar';
    btnConnect.className = 'btn btn-primary';
  }
});

// Listener de metadatos del robot (/info)
client.on('info', (info) => {
  if (info.modelo) {
    setRobotModel(info.modelo, info.n_motores, info.motores_nombres, info.nombre);
  }
});

function setRobotModel(modelo, nMotors, motorNames = [], prettyName = null) {
  State.robotModel = modelo;
  State.numMotors = nMotors || (modelo === 'go2' ? 12 : 29);
  State.robotName = prettyName || (modelo === 'go2' ? 'Go2 (Cuadrúpedo)' : 'G1 (Humanoid)');

  document.getElementById('robotNameText').textContent = State.robotName;
  document.getElementById('motoresCountBadge').textContent = `${State.numMotors} Motores`;

  // Construir nombres de motores por defecto si no vienen
  State.motorNames = (motorNames && motorNames.length) ? motorNames : Array.from({ length: State.numMotors }, (_, i) => `Motor_${i}`);

  // Reconstruir checkboxes para el gráfico térmico
  renderMotorCheckboxes();
}

function renderMotorCheckboxes() {
  const container = document.getElementById('motorCheckboxesContainer');
  if (!container) return;

  container.innerHTML = State.motorNames.map((name, i) => {
    const isChecked = State.selectedMotorsForChart.has(i) ? 'checked' : '';
    const color = CHART_COLORS[i % CHART_COLORS.length];
    return `
      <label style="border-left: 3px solid ${color}">
        <input type="checkbox" data-motor-id="${i}" ${isChecked}>
        <span>#${i} ${name}</span>
      </label>
    `;
  }).join('');

  container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const id = parseInt(e.target.dataset.motorId, 10);
      if (e.target.checked) State.selectedMotorsForChart.add(id);
      else State.selectedMotorsForChart.delete(id);
      updateChartDatasets();
    });
  });
}

// ==============================================================================
// 7. ALERTAS Y CAPTURA CSV (CLIENT-SIDE BLOB EXPORT)
// ==============================================================================
function handleOverheatAlert(overheatedMotors) {
  const now = Date.now();
  if (now - State.lastOverheatAlertTime > 6000) { // Alarma cada 6s máximo
    State.lastOverheatAlertTime = now;
    const motorList = overheatedMotors.map(m => `#${m.id} (${m.temp.toFixed(1)}°C)`).join(', ');
    showToast(`⚠️ Sobrecalentamiento detectado: ${motorList}`, 'toast-error');

    if (State.autoAlertCaptureEnabled && State.lastSnapshot) {
      captureSample(State.lastSnapshot, 'Alerta Sobrecalentamiento > 60°C');
    }
  }
}

function captureSample(snapshot, motivo = 'Manual') {
  if (!snapshot) {
    showToast('No hay datos disponibles para capturar', 'toast-warning');
    return;
  }

  const imu = snapshot.imu || {};
  const bms = snapshot.bms || {};
  const motores = snapshot.motores || [];
  const fuerzas = snapshot.fuerzas || {};

  // Formato plano y completo para exportar
  const sample = {
    timestamp_local: new Date().toISOString(),
    telemetria_ts: snapshot.ts || 0,
    modelo: snapshot.modelo || State.robotModel,
    motivo_captura: motivo,
    // IMU
    imu_roll: imu.roll || 0,
    imu_pitch: imu.pitch || 0,
    imu_yaw: imu.yaw || 0,
    imu_ax: imu.ax || 0,
    imu_ay: imu.ay || 0,
    imu_az: imu.az || 0,
    // BMS
    bms_soc_pct: bms.soc || 0,
    bms_corriente_ma: bms.corriente || 0,
    bms_temp_c: bms.temperatura || 0,
    bms_celdas: (bms.celdas || []).join(';'),
    // Fuerzas patas
    pata_FR: fuerzas.FR !== undefined ? fuerzas.FR : '',
    pata_FL: fuerzas.FL !== undefined ? fuerzas.FL : '',
    pata_RR: fuerzas.RR !== undefined ? fuerzas.RR : '',
    pata_RL: fuerzas.RL !== undefined ? fuerzas.RL : ''
  };

  // Agregar datos de motores
  motores.forEach(m => {
    sample[`motor_${m.id}_temp_c`] = m.temperatura;
    sample[`motor_${m.id}_angulo_deg`] = m.angulo;
    sample[`motor_${m.id}_vel_rads`] = m.velocidad;
    sample[`motor_${m.id}_torque_nm`] = m.torque;
  });

  State.capturedSamples.push(sample);
  updateCaptureUI();
  showToast(`Muestra #${State.capturedSamples.length} capturada (${motivo})`, 'toast-success');
}

function updateCaptureUI() {
  const count = State.capturedSamples.length;
  document.getElementById('nMuestras').textContent = count;
  document.getElementById('btnExportCSV').disabled = (count === 0);
  document.getElementById('btnClearCaptures').disabled = (count === 0);
}

function exportCSV() {
  if (State.capturedSamples.length === 0) {
    showToast('No hay muestras capturadas para exportar', 'toast-warning');
    return;
  }

  const samples = State.capturedSamples;
  // Obtener todas las columnas
  const headers = Object.keys(samples[0]);

  const csvRows = [];
  csvRows.push(headers.join(','));

  samples.forEach(row => {
    const values = headers.map(header => {
      const val = row[header] !== undefined ? row[header] : '';
      const escaped = ('' + val).replace(/"/g, '""');
      return `"${escaped}"`;
    });
    csvRows.push(values.join(','));
  });

  const csvString = csvRows.join('\r\n');
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const downloadLink = document.createElement('a');
  const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
  downloadLink.href = url;
  downloadLink.download = `telemetria_unitree_${State.robotModel}_${timestampStr}.csv`;
  document.body.appendChild(downloadLink);
  downloadLink.click();
  document.body.removeChild(downloadLink);

  URL.revokeObjectURL(url);
  showToast(`Archivo CSV con ${samples.length} muestras exportado con éxito`, 'toast-success');
}

function clearCaptures() {
  State.capturedSamples = [];
  updateCaptureUI();
  showToast('Capturas eliminadas', 'toast-warning');
}

// ==============================================================================
// 8. TOAST NOTIFICATIONS & MÉTRICAS
// ==============================================================================
function showToast(message, type = 'toast-info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Cálculo de Hz y tiempo de sesión
setInterval(() => {
  const now = Date.now();
  const elapsedSec = (now - State.lastPacketTime) / 1000;
  if (elapsedSec >= 1.0) {
    State.currentHz = (State.packetCount / elapsedSec).toFixed(1);
    document.getElementById('hzMetric').textContent = State.isConnected ? State.currentHz : '0';
    State.packetCount = 0;
    State.lastPacketTime = now;
  }

  // Tiempo de sesión
  const totalSec = Math.floor((now - State.sessionStartTime) / 1000);
  const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');
  document.getElementById('sessionTime').textContent = `${mins}:${secs}`;
}, 1000);

// ==============================================================================
// 9. EVENT LISTENERS & INICIALIZACIÓN
// ==============================================================================
document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  renderMotorCheckboxes();

  // Botón Conectar / Desconectar
  const btnConnect = document.getElementById('btnConnect');
  const serverInput = document.getElementById('serverUrl');
  const pollRateContainer = document.getElementById('pollRateContainer');
  const pollIntervalSelect = document.getElementById('pollInterval');

  btnConnect.addEventListener('click', () => {
    if (State.isConnected) {
      client.disconnect();
    } else {
      const mode = document.querySelector('input[name="commMode"]:checked').value;
      State.commMode = mode;
      client.connect(serverInput.value.trim(), mode);
    }
  });

  // Selector de modo (WebSocket vs Polling)
  document.querySelectorAll('input[name="commMode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      State.commMode = e.target.value;
      pollRateContainer.style.display = (State.commMode === 'poll') ? 'flex' : 'none';
      if (State.isConnected) {
        client.connect(serverInput.value.trim(), State.commMode);
      }
    });
  });

  // Intervalo de Polling
  pollIntervalSelect.addEventListener('change', (e) => {
    State.pollIntervalMs = parseInt(e.target.value, 10);
    if (State.isConnected && State.commMode === 'poll') {
      client.connect(serverInput.value.trim(), 'poll');
    }
  });

  // Captura y exportación
  document.getElementById('btnCapture').addEventListener('click', () => {
    captureSample(State.lastSnapshot, 'Captura Manual');
  });

  document.getElementById('btnExportCSV').addEventListener('click', exportCSV);
  document.getElementById('btnClearCaptures').addEventListener('click', clearCaptures);

  document.getElementById('autoAlertCapture').addEventListener('change', (e) => {
    State.autoAlertCaptureEnabled = e.target.checked;
  });

  // Auto-conectar al cargar
  setTimeout(() => {
    client.connect(serverInput.value.trim(), State.commMode);
  }, 300);
});
