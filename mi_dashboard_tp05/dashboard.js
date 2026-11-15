/**
 * ==============================================================================
 * DASHBOARD DE TELEMETRÍA ROBÓTICA UNITREE — TP05
 * Universidad Argentina de la Empresa (UADE)
 * Materia: Desarrollo de Aplicaciones II
 *
 * Arquitectura: Cliente-Servidor Desacoplada (FastAPI Provider <-> Browser Consumer)
 * Patrones aplicados:
 *   - Facade: TelemetryClient (unifica WebSocket, REST Polling y reconexión)
 *   - Observer: Bus de eventos reactivo para suscripción de cada panel
 *   - Adapter: Normalización entre modelos Go2 (12 motores) y G1 (29 motores)
 * ==============================================================================
 */

// ==============================================================================
// 1. CONFIGURACIÓN Y CONSTANTES DEL SISTEMA
// ==============================================================================
const HIST_SIZE = 300;     // 30 s a 10 Hz — igual al historial de electroSim
const DEFAULT_POLL_MS = 500; // Polling máximo 500 ms según consigna
const DEFAULT_API = 'http://127.0.0.1:8001';

const CONFIG = {
  DEFAULT_API_URL: DEFAULT_API,
  HIST_SIZE: HIST_SIZE,
  MAX_RECONNECT_DELAY: 4000,
  OVERHEAT_THRESHOLD: 60.0,
  WARNING_TEMP_THRESHOLD: 40.0,
};

const CHART_COLORS = [
  '#38bdf8', '#f43f5e', '#10b981', '#fbbf24', '#a855f7',
  '#ec4899', '#3b82f6', '#14b8a6', '#f97316', '#8b5cf6',
  '#06b6d4', '#84cc16', '#e11d48', '#6366f1', '#d946ef',
  '#2dd4bf', '#fb7185', '#34d399', '#fde047', '#c084fc',
  '#f472b6', '#60a5fa', '#22d3ee', '#a3e635', '#f87171',
  '#818cf8', '#e879f9', '#4ade80', '#facc15'
];

// ==============================================================================
// 2. ESTADO GLOBAL DE LA APLICACIÓN
// ==============================================================================
const initialParams = new URLSearchParams(window.location.search);
const initialModel = initialParams.get('modelo') || initialParams.get('model') || 'go2';
const initialMode = initialParams.get('mode') || 'ws';

let modelo = initialModel;
let histTemp = {}; // { motorId: [valores] } — buffer circular de 300
let muestras = []; // capturas para exportar CSV vía Blob
let chart = null;

const State = {
  robotModel: initialModel,
  robotName: initialModel === 'go2' ? 'Go2 (Cuadrúpedo)' : 'G1 (Humanoide)',
  numMotors: initialModel === 'go2' ? 12 : 29,
  motorNames: [],
  isConnected: false,
  commMode: initialMode, // 'ws' | 'poll' | 'sim'
  pollIntervalMs: DEFAULT_POLL_MS,
  lastSnapshot: null,

  history: {
    ts: [],
    imu: { roll: [], pitch: [], yaw: [] },
  },

  selectedMotorsForChart: new Set([0, 1, 2, 3]),
  autoAlertCaptureEnabled: true,
  lastOverheatAlertTime: 0,

  packetCount: 0,
  lastPacketTime: Date.now(),
  currentHz: 0,
  sessionStartTime: Date.now(),
};

// ==============================================================================
// 3. SEMÁFORO DE TEMPERATURA (Igual a electroSim)
// ==============================================================================
function colorTemp(t) {
  if (t < 40) return '#4CAF50'; // verde <40°C
  if (t < 60) return '#FFC107'; // amarillo 40–60°C
  return '#F44336';             // rojo >60°C
}

// ==============================================================================
// 4. FACHADA DE COMUNICACIÓN (FACADE PATTERN): TelemetryClient
// ==============================================================================
class TelemetryClient {
  constructor() {
    this.ws = null;
    this.pollTimer = null;
    this.pollAbortCtrl = null;
    this.simTimer = null;
    this.listeners = { data: [], status: [], info: [] };
    this.reconnectTimeout = null;
    this.reconnectAttempts = 0;
    this.isManualDisconnect = false;
    this.baseUrl = DEFAULT_API;
    this.mode = 'ws';
  }

  on(event, callback) {
    if (this.listeners[event]) this.listeners[event].push(callback);
  }

  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((cb) => {
        try { cb(data); } catch (e) { console.error(`Error en listener [${event}]:`, e); }
      });
    }
  }

  async connect(baseUrl, mode = 'ws') {
    this.disconnect();
    this.isManualDisconnect = false;
    this.baseUrl = (baseUrl || DEFAULT_API).replace(/\/+$/, '');
    this.mode = mode;

    if (this.mode === 'sim') {
      this.startDirectSimulation();
      return;
    }

    this.emit('status', { state: 'connecting', message: 'Conectando al servidor...' });
    await this.fetchRobotInfo();

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
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch (_) {}
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
    State.isConnected = false;
    State.currentHz = '0.0';
    const hzEl = document.getElementById('hzMetric');
    if (hzEl) hzEl.textContent = '0.0';

    this.emit('status', { state: 'disconnected', message: 'Desconectado (Pausado)' });
    showToast('🛑 Telemetría desconectada. Gráficos y datos en pausa.', 'toast-warning');
  }

  async fetchRobotInfo() {
    try {
      const resp = await fetch(`${this.baseUrl}/info?modelo=${State.robotModel}`, { cache: 'no-store' });
      if (resp.ok) {
        const info = await resp.json();
        this.emit('info', info);
      }
    } catch (_) {
      // Si /info falla transitoriamente, continuamos
    }
  }

  connectWebSocket() {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';
    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.emit('status', { state: 'connected', message: 'Conectado (WebSocket 10 Hz Push)' });
      };

      this.ws.onmessage = (event) => {
        try {
          const telemetry = JSON.parse(event.data);
          this.emit('data', telemetry);
        } catch (e) {
          console.error('Error parseando payload WebSocket:', e);
        }
      };

      this.ws.onerror = () => {
        this.emit('status', { state: 'connecting', message: 'Servidor no detectado. Reintentando...' });
      };

      this.ws.onclose = () => {
        if (!this.isManualDisconnect) {
          this.emit('status', { state: 'connecting', message: 'Conexión perdida. Reconectando...' });
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      this.emit('status', { state: 'disconnected', message: 'Error de socket' });
      this.scheduleReconnect();
    }
  }

  startPolling() {
    this.emit('status', { state: 'connected', message: `Conectado (REST Polling ${State.pollIntervalMs}ms)` });

    const pollTask = async () => {
      if (this.isManualDisconnect) return;
      try {
        this.pollAbortCtrl = new AbortController();
        const res = await fetch(`${this.baseUrl}/telemetria?modelo=${State.robotModel}`, {
          signal: this.pollAbortCtrl.signal,
          cache: 'no-store',
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
          this.emit('status', { state: 'connecting', message: 'Error en respuesta HTTP. Reintentando...' });
        }
      }
    };

    pollTask();
    this.pollTimer = setInterval(pollTask, State.pollIntervalMs);
  }

  scheduleReconnect() {
    if (this.isManualDisconnect || this.reconnectTimeout) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.3, this.reconnectAttempts), CONFIG.MAX_RECONNECT_DELAY);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (!this.isManualDisconnect) {
        if (this.mode === 'ws') this.connectWebSocket();
        else if (this.mode === 'poll') this.startPolling();
      }
    }, delay);
  }

  startDirectSimulation() {
    this.emit('status', { state: 'connected', message: '⚡ Modo Demo Offline (Generador Local 10 Hz)' });
    const simStartTime = Date.now();

    const simMotorNamesGo2 = [
      "FR_hip", "FR_thigh", "FR_calf",
      "FL_hip", "FL_thigh", "FL_calf",
      "RR_hip", "RR_thigh", "RR_calf",
      "RL_hip", "RL_thigh", "RL_calf",
    ];

    this.simTimer = setInterval(() => {
      if (this.isManualDisconnect) return;
      const t = (Date.now() - simStartTime) / 1000.0;
      const isGo2 = (State.robotModel === 'go2');
      const nMotors = isGo2 ? 12 : 29;

      const motores = [];
      for (let i = 0; i < nMotors; i++) {
        const fase = i * 0.45;
        const angulo = Math.sin(t * 1.2 + fase) * 30.0;
        const velocidad = Math.cos(t * 1.2 + fase) * 5.0;
        const torque = Math.abs(Math.sin(t * 0.8 + i)) * 20.0;
        const tempBase = 28.0 + (i % 12) * 0.8;
        const temp = tempBase + Math.min(t / 45.0, 1.0) * 28.0 + (Math.sin(t * 0.2 + i) * 2.5) + (Math.random() * 0.4 - 0.2);

        motores.push({
          id: i,
          nombre: isGo2 ? (simMotorNamesGo2[i] || `Motor_${i}`) : `G1_Joint_${i}`,
          angulo: parseFloat(angulo.toFixed(2)),
          velocidad: parseFloat(velocidad.toFixed(3)),
          torque: parseFloat(torque.toFixed(2)),
          temperatura: parseFloat(temp.toFixed(1)),
        });
      }

      const roll = Math.sin(t * 0.3) * 5.0;
      const pitch = Math.sin(t * 0.5) * 8.0;
      const yaw = ((t * 12.0) % 360.0) - 180.0;
      const ax = Math.sin(t * 1.2) * 0.05;
      const ay = Math.cos(t * 1.2) * 0.05;
      const az = 9.81 + Math.sin(t * 2.4) * 0.02;

      const soc = Math.max(20.0, 95.0 - t / 600.0);
      const corriente = Math.round(1200 + Math.sin(t * 0.6) * 50);
      const bmsTemp = parseFloat((32.0 + Math.sin(t * 0.05) * 2.0).toFixed(1));
      const celdas = Array.from({ length: 10 }, (_, idx) => {
        return parseFloat((3.7 + Math.sin(t * 0.1 + idx) * 0.04).toFixed(3));
      });

      const gait = Math.sin(t * 3.5);
      const fuerzas = isGo2 ? {
        FR: (gait > 0) ? 1 : 0,
        RL: (gait > 0) ? 1 : 0,
        FL: (gait <= 0) ? 1 : 0,
        RR: (gait <= 0) ? 1 : 0,
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
          az: parseFloat(az.toFixed(3)),
        },
        bms: {
          soc: Math.round(soc),
          corriente,
          temperatura: bmsTemp,
          celdas,
        },
        fuerzas,
      };

      this.emit('data', snapshot);
    }, 100);
  }
}

const client = new TelemetryClient();

// ==============================================================================
// 5. GESTIÓN DE GRÁFICOS (CHART.JS)
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
      x: { display: false, grid: { color: 'rgba(48, 54, 61, 0.3)' } },
      y: {
        grid: { color: 'rgba(48, 54, 61, 0.4)' },
        ticks: { color: '#8b949e', font: { size: 10 } },
      },
    },
    plugins: {
      legend: { labels: { color: '#e6edf3', font: { size: 11 }, boxWidth: 12 } },
      tooltip: { enabled: true },
    },
  };

  // Gráfico Histórico IMU (mín. 60 muestras, buffer circular de 300)
  const ctxIMU = document.getElementById('chartIMU').getContext('2d');
  chartIMU = new Chart(ctxIMU, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Roll (°)', borderColor: '#38bdf8', borderWidth: 1.8, data: [] },
        { label: 'Pitch (°)', borderColor: '#f43f5e', borderWidth: 1.8, data: [] },
        { label: 'Yaw (°)', borderColor: '#fbbf24', borderWidth: 1.8, data: [] },
      ],
    },
    options: {
      ...commonOptions,
      scales: {
        ...commonOptions.scales,
        y: {
          ...commonOptions.scales.y,
          title: { display: true, text: 'Ángulo (°)', color: '#8b949e', font: { size: 10 } },
        },
      },
    },
  });

  // Gráfico Histórico de Temperatura de Motores
  const ctxMotores = document.getElementById('chartMotores').getContext('2d');
  chartMotores = new Chart(ctxMotores, {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      ...commonOptions,
      scales: {
        ...commonOptions.scales,
        y: {
          ...commonOptions.scales.y,
          title: { display: true, text: 'Temperatura (°C)', color: '#8b949e', font: { size: 10 } },
        },
      },
    },
  });
}

function updateChartDatasets() {
  if (!chartMotores) return;
  const datasets = [];

  State.selectedMotorsForChart.forEach((motorId) => {
    const motorName = State.motorNames[motorId] || `Motor ${motorId}`;
    const color = CHART_COLORS[motorId % CHART_COLORS.length];
    const data = histTemp[motorId] || [];

    datasets.push({
      label: `${motorName} (#${motorId})`,
      borderColor: color,
      borderWidth: 1.6,
      data: [...data],
    });
  });

  chartMotores.data.datasets = datasets;
  chartMotores.data.labels = State.history.ts;
  chartMotores.update('none');
}

// ==============================================================================
// 6. ACTUALIZACIÓN DE PANELES (OBSERVER DISPATCHERS)
// ==============================================================================

// --- Panel 1: Motores con Semáforo de Temperatura ---
function actualizarMotores(motores) {
  if (!motores || !motores.length) return;

  const tbody = document.querySelector('#tablaMotores tbody');
  let maxTemp = -Infinity;
  let sumTemp = 0;
  let maxTorque = 0;
  const overheatedMotors = [];

  const rows = [];
  motores.forEach((m) => {
    const temp = Number(m.temperatura);
    const torque = Math.abs(Number(m.torque));
    const angulo = Number(m.angulo);
    const vel = Number(m.velocidad);

    if (temp > maxTemp) maxTemp = temp;
    sumTemp += temp;
    if (torque > maxTorque) maxTorque = torque;

    const colorSemaforo = colorTemp(temp);

    let tempClass = 'temp-ok';
    if (temp >= CONFIG.OVERHEAT_THRESHOLD) {
      tempClass = 'temp-crit';
      overheatedMotors.push({ id: m.id, name: m.nombre, temp });
    } else if (temp >= CONFIG.WARNING_TEMP_THRESHOLD) {
      tempClass = 'temp-warn';
    }

    // Actualizar búfer circular histórico (300 entradas = 30s @ 10Hz)
    if (!histTemp[m.id]) histTemp[m.id] = [];
    histTemp[m.id].push(temp);
    if (histTemp[m.id].length > HIST_SIZE) histTemp[m.id].shift();

    const name = m.nombre || `Motor_${m.id}`;

    rows.push(`
      <tr>
        <td><strong>#${m.id}</strong></td>
        <td>${name}</td>
        <td><span class="temp-cell ${tempClass}" style="border-left: 4px solid ${colorSemaforo}; color: ${colorSemaforo};">${temp.toFixed(1)} °C</span></td>
        <td>${angulo.toFixed(2)} °</td>
        <td>${vel.toFixed(3)} rad/s</td>
        <td>${torque.toFixed(2)} N·m</td>
      </tr>
    `);
  });

  tbody.innerHTML = rows.join('');

  // Resumen térmico superior
  const avgTemp = (sumTemp / motores.length).toFixed(1);
  const elMax = document.getElementById('motorMaxTemp');
  const elAvg = document.getElementById('motorAvgTemp');
  const elTorque = document.getElementById('motorMaxTorque');
  const statusTag = document.getElementById('thermalStatusTag');

  if (elMax) elMax.textContent = `${maxTemp.toFixed(1)} °C`;
  if (elAvg) elAvg.textContent = `${avgTemp} °C`;
  if (elTorque) elTorque.textContent = `${maxTorque.toFixed(2)} N·m`;

  if (statusTag) {
    if (overheatedMotors.length > 0) {
      statusTag.className = 'status-tag crit';
      statusTag.textContent = `Crítico (${overheatedMotors.length} motores >60°C)`;
      handleOverheatAlert(overheatedMotors);
    } else if (maxTemp >= CONFIG.WARNING_TEMP_THRESHOLD) {
      statusTag.className = 'status-tag warn';
      statusTag.textContent = 'Alerta moderada';
    } else {
      statusTag.className = 'status-tag ok';
      statusTag.textContent = 'Óptimo';
    }
  }
}

// --- Panel 2: IMU (Roll, Pitch, Yaw, Aceleración) ---
function actualizarIMU(imu) {
  if (!imu) return;

  const roll = Number(imu.roll);
  const pitch = Number(imu.pitch);
  const yaw = Number(imu.yaw);

  const elRoll = document.getElementById('roll');
  const elPitch = document.getElementById('pitch');
  const elYaw = document.getElementById('yaw');

  if (elRoll) elRoll.textContent = `${roll.toFixed(2)} °`;
  if (elPitch) elPitch.textContent = `${pitch.toFixed(2)} °`;
  if (elYaw) elYaw.textContent = `${yaw.toFixed(2)} °`;

  const elAx = document.getElementById('imuAx');
  const elAy = document.getElementById('imuAy');
  const elAz = document.getElementById('imuAz');
  if (elAx) elAx.textContent = Number(imu.ax || 0).toFixed(2);
  if (elAy) elAy.textContent = Number(imu.ay || 0).toFixed(2);
  if (elAz) elAz.textContent = Number(imu.az || 9.81).toFixed(2);

  // Horizonte Artificial (Pitch desplaza verticalmente, Roll rota)
  const horizonDisk = document.getElementById('horizonDisk');
  if (horizonDisk) {
    const pitchOffset = Math.max(-45, Math.min(45, pitch)) * 1.2;
    horizonDisk.style.transform = `rotate(${-roll}deg) translateY(${pitchOffset}px)`;
    const textEl = document.getElementById('horizonPitchRollText');
    if (textEl) textEl.textContent = `R: ${roll.toFixed(1)}° | P: ${pitch.toFixed(1)}°`;
  }

  // Búfer circular histórico de IMU (300 muestras)
  State.history.imu.roll.push(roll);
  State.history.imu.pitch.push(pitch);
  State.history.imu.yaw.push(yaw);

  if (State.history.imu.roll.length > HIST_SIZE) {
    State.history.imu.roll.shift();
    State.history.imu.pitch.shift();
    State.history.imu.yaw.shift();
  }

  // Gráfico de línea histórico sin recrear componente
  if (chartIMU) {
    chartIMU.data.labels = State.history.ts.slice(-State.history.imu.roll.length);
    chartIMU.data.datasets[0].data = State.history.imu.roll;
    chartIMU.data.datasets[1].data = State.history.imu.pitch;
    chartIMU.data.datasets[2].data = State.history.imu.yaw;
    chartIMU.update('none');
  }
}

// --- Panel 3: BMS (Nivel de carga, Corriente, Temp, Celdas) ---
function actualizarBMS(bms) {
  if (!bms) return;

  const soc = Math.max(0, Math.min(100, Number(bms.soc || 0)));
  const corriente = Number(bms.corriente || 0);
  const temp = Number(bms.temperatura || 0);
  const celdas = bms.celdas || [];

  const elSoc = document.getElementById('soc');
  const elBmsI = document.getElementById('bmsI');
  const elBmsT = document.getElementById('bmsT');

  if (elSoc) elSoc.textContent = `${Math.round(soc)} %`;
  if (elBmsI) elBmsI.textContent = `${corriente} mA`;
  if (elBmsT) elBmsT.textContent = `${temp.toFixed(1)} °C`;

  // Gauge circular animado de SOC
  const socCircle = document.getElementById('socCircle');
  if (socCircle) {
    const circumference = 2 * Math.PI * 42;
    const offset = circumference - (circumference * soc / 100);
    socCircle.style.strokeDashoffset = offset;
    socCircle.style.stroke = (soc > 50) ? '#22c55e' : (soc > 20 ? '#eab308' : '#ef4444');
  }

  // Celdas individuales
  const celdasDiv = document.getElementById('celdas');
  if (celdasDiv) {
    if (celdas.length > 0) {
      let avg = 0;
      celdasDiv.innerHTML = celdas.map((v, i) => {
        const vNum = Number(v);
        avg += vNum;
        return `
          <div class="cell-badge">
            <span class="c-name">C${i + 1}</span>
            <span class="c-val">${vNum.toFixed(3)} V</span>
          </div>
        `;
      }).join('');
      const elAvg = document.getElementById('bmsAvgCell');
      if (elAvg) elAvg.textContent = `${(avg / celdas.length).toFixed(3)} V`;
    } else {
      celdasDiv.innerHTML = '<span class="text-muted" style="grid-column: span 5; font-size:0.75rem;">Sin datos de celdas</span>';
    }
  }
}

// --- Panel 4: Fuerzas por Pata (Contactos FR, FL, RR, RL) ---
function actualizarFuerzas(f) {
  const isGo2 = (State.robotModel === 'go2');
  const fuerzasNote = document.getElementById('fuerzasNote');
  const countEl = document.getElementById('patasApoyadasCount');
  const phaseEl = document.getElementById('gaitPhaseLabel');

  if (!isGo2) {
    if (fuerzasNote) fuerzasNote.textContent = 'ℹ️ Robot humanoide G1 (Bípedo). El monitor de 4 patas aplica al Go2.';
    if (countEl) countEl.textContent = 'N/A (Bípedo)';
    if (phaseEl) phaseEl.textContent = 'Marcha bípeda activa';
    ['FL', 'FR', 'RL', 'RR'].forEach((pata) => {
      const el = document.getElementById('pata' + pata);
      if (el) {
        el.className = 'leg-indicator airborne';
        el.style.background = 'rgba(139, 148, 158, 0.1)';
      }
      const st = document.getElementById('status' + pata);
      if (st) st.textContent = '—';
    });
    return;
  }

  if (fuerzasNote) fuerzasNote.textContent = '* Sensores de contacto activos para Go2 (Cuadrúpedo).';
  if (!f) return;

  const patas = ['FR', 'FL', 'RR', 'RL'];
  let apoyadas = 0;

  patas.forEach((pata) => {
    const el = document.getElementById('pata' + pata);
    const st = document.getElementById('status' + pata);
    const activa = Boolean(f[pata]);

    if (el) {
      el.style.background = activa ? 'rgba(34, 197, 94, 0.2)' : 'rgba(139, 148, 158, 0.1)';
      el.style.borderColor = activa ? '#22c55e' : '#30363d';
      el.className = activa ? 'leg-indicator supported' : 'leg-indicator airborne';
    }

    if (st) {
      st.textContent = activa ? 'APOYADA ✓' : 'EN EL AIRE —';
      st.style.color = activa ? '#22c55e' : '#8b949e';
    }

    if (activa) apoyadas++;
  });

  if (countEl) countEl.textContent = `${apoyadas} / 4`;

  if (phaseEl) {
    let fase = 'En movimiento';
    if (apoyadas === 4) fase = 'Apoyo cuádruple (Estable)';
    else if (apoyadas === 0) fase = 'Fase de salto / Vuelo';
    else if (apoyadas === 2) {
      if ((f.FL && f.RR) || (f.FR && f.RL)) fase = 'Trote diagonal (Gait)';
      else fase = 'Transición lateral';
    } else if (apoyadas === 3) {
      fase = 'Apoyo triple';
    } else {
      fase = 'Paso simple';
    }
    phaseEl.textContent = fase;
  }
}

// ==============================================================================
// 7. PIPELINE REACTIVO (OBSERVER EVENT DISPATCHER)
// ==============================================================================
client.on('data', (data) => {
  State.lastSnapshot = data;
  State.packetCount++;

  const ts = data.ts !== undefined ? Number(data.ts).toFixed(1) : ((Date.now() - State.sessionStartTime) / 1000).toFixed(1);
  const tsEl = document.getElementById('telemetryTs');
  if (tsEl) tsEl.textContent = ts;

  State.history.ts.push(ts);
  if (State.history.ts.length > HIST_SIZE) State.history.ts.shift();

  if (data.modelo && data.modelo !== State.robotModel) {
    setRobotModel(data.modelo, data.motores ? data.motores.length : 12);
  }

  // Despacho a los 4 paneles
  actualizarMotores(data.motores);
  actualizarIMU(data.imu);
  actualizarBMS(data.bms);
  actualizarFuerzas(data.fuerzas);

  // Actualizar gráfico de motores
  updateChartDatasets();
});

client.on('status', ({ state, message }) => {
  const indicator = document.getElementById('statusIndicator');
  const label = document.getElementById('statusLabel');

  if (indicator) indicator.className = `status-indicator ${state}`;
  if (label) label.textContent = message;

  const btnConnect = document.getElementById('btnConnect');
  if (btnConnect) {
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
  }
});

client.on('info', (info) => {
  if (info.modelo) {
    setRobotModel(info.modelo, info.n_motores, info.motores_nombres, info.nombre);
  }
});

function setRobotModel(newModel, nMotors, motorNames = [], prettyName = null) {
  State.robotModel = newModel;
  modelo = newModel;
  State.numMotors = nMotors || (newModel === 'go2' ? 12 : 29);
  State.robotName = prettyName || (newModel === 'go2' ? 'Go2 (Cuadrúpedo)' : 'G1 (Humanoide)');

  const badge = document.getElementById('motoresCountBadge');
  if (badge) badge.textContent = `${State.numMotors} Motores`;

  const robotSelect = document.getElementById('robotSelect');
  if (robotSelect && robotSelect.value !== newModel) {
    robotSelect.value = newModel;
  }

  State.motorNames = (motorNames && motorNames.length) ? motorNames : Array.from({ length: State.numMotors }, (_, i) => `Motor_${i}`);
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

  container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const id = parseInt(e.target.dataset.motorId, 10);
      if (e.target.checked) State.selectedMotorsForChart.add(id);
      else State.selectedMotorsForChart.delete(id);
      updateChartDatasets();
    });
  });
}

// ==============================================================================
// 8. CAPTURA Y EXPORTACIÓN CSV (BLOB API CLIENT-SIDE)
// ==============================================================================
function capturarMuestra(data) {
  const snapshot = data || State.lastSnapshot;
  if (!snapshot) {
    showToast('Esperando datos de telemetría para capturar...', 'toast-warning');
    return;
  }

  const imu = snapshot.imu || {};
  const bms = snapshot.bms || {};
  const motores = snapshot.motores || [];
  const fuerzas = snapshot.fuerzas || {};

  const muestra = {
    timestamp: new Date().toISOString(),
    ts: snapshot.ts || 0,
    modelo: snapshot.modelo || State.robotModel,
    roll: imu.roll || 0,
    pitch: imu.pitch || 0,
    yaw: imu.yaw || 0,
    ax: imu.ax || 0,
    ay: imu.ay || 0,
    az: imu.az || 0,
    bms_soc: bms.soc || 0,
    bms_corriente: bms.corriente || 0,
    bms_temperatura: bms.temperatura || 0,
    bms_celdas: (bms.celdas || []).join(';'),
    pata_FR: fuerzas.FR !== undefined ? fuerzas.FR : '',
    pata_FL: fuerzas.FL !== undefined ? fuerzas.FL : '',
    pata_RR: fuerzas.RR !== undefined ? fuerzas.RR : '',
    pata_RL: fuerzas.RL !== undefined ? fuerzas.RL : '',
  };

  motores.forEach((m) => {
    muestra[`motor_${m.id}_temp`] = m.temperatura;
    muestra[`motor_${m.id}_angulo`] = m.angulo;
    muestra[`motor_${m.id}_vel`] = m.velocidad;
    muestra[`motor_${m.id}_torque`] = m.torque;
  });

  muestras.push(muestra);

  const nMuestrasEl = document.getElementById('nMuestras');
  if (nMuestrasEl) nMuestrasEl.textContent = muestras.length;

  const btnExport = document.getElementById('btnExportCSV');
  const btnClear = document.getElementById('btnClearCaptures');
  if (btnExport) btnExport.disabled = (muestras.length === 0);
  if (btnClear) btnClear.disabled = (muestras.length === 0);

  showToast(`📝 Muestra #${muestras.length} capturada en memoria. Hacé clic en 'Exportar CSV' para guardarla.`, 'toast-success');
}

function exportarCSV() {
  if (!muestras.length) {
    showToast('No hay muestras capturadas para exportar', 'toast-warning');
    return;
  }

  const cols = Object.keys(muestras[0]);
  const csv = [
    cols.join(','),
    ...muestras.map((r) => cols.map((c) => {
      const val = r[c] !== undefined ? r[c] : '';
      return `"${('' + val).replace(/"/g, '""')}"`;
    }).join(',')),
  ].join('\r\n');

  // 1. Descarga vía Blob en el cliente (Requisito estricto de la cátedra)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `telemetria_unitree_${State.robotModel}_${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  // 2. Guardar también directamente en la carpeta capturas/ del proyecto si el backend está activo
  fetch(`${client.baseUrl}/guardar_csv`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv;charset=utf-8' },
    body: csv,
  })
    .then((r) => r.json())
    .then((res) => {
      if (res && res.status === 'ok') {
        showToast(`✅ CSV guardado directamente en ${res.guardado_en[0] || 'la carpeta capturas'}`, 'toast-success');
      }
    })
    .catch(() => {});

  showToast(`✅ Archivo CSV (${muestras.length} muestras) exportado vía Blob API`, 'toast-success');
}

async function tomarCapturaPantalla() {
  const btn = document.getElementById('btnScreenshot');
  if (btn) btn.disabled = true;
  showToast('Generando captura de pantalla PNG...', 'toast-info');

  try {
    if (typeof html2canvas === 'undefined') {
      throw new Error('Biblioteca html2canvas cargando o no disponible');
    }
    const canvas = await html2canvas(document.body, {
      scale: 1.2,
      useCORS: true,
      logging: false,
      backgroundColor: '#0a0d14',
    });
    const imgData = canvas.toDataURL('image/png');
    const filename = `captura_dashboard_${State.robotModel}_${Date.now()}.png`;

    // 1. Descargar en el navegador
    const a = document.createElement('a');
    a.href = imgData;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // 2. Guardar en el backend en la carpeta capturas/
    try {
      await fetch(`${client.baseUrl}/guardar_captura_pantalla`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imgData, nombre: filename }),
      });
      showToast(`📸 Captura guardada en la carpeta capturas/${filename}`, 'toast-success');
    } catch (_) {
      showToast(`📸 Captura descargada con éxito: ${filename}`, 'toast-success');
    }
  } catch (err) {
    console.error('Error al capturar pantalla:', err);
    showToast(`Error al capturar pantalla: ${err.message}`, 'toast-error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function clearCaptures() {
  muestras = [];
  const nMuestrasEl = document.getElementById('nMuestras');
  if (nMuestrasEl) nMuestrasEl.textContent = 0;
  const btnExport = document.getElementById('btnExportCSV');
  const btnClear = document.getElementById('btnClearCaptures');
  if (btnExport) btnExport.disabled = true;
  if (btnClear) btnClear.disabled = true;
  showToast('Muestras borradas', 'toast-warning');
}

function handleOverheatAlert(overheatedMotors) {
  const now = Date.now();
  if (now - State.lastOverheatAlertTime > 8000) {
    State.lastOverheatAlertTime = now;
    const lista = overheatedMotors.map((m) => `#${m.id} (${m.temp.toFixed(1)}°C)`).join(', ');
    showToast(`⚠️ Sobrecalentamiento detectado: ${lista}`, 'toast-error');

    if (State.autoAlertCaptureEnabled && State.lastSnapshot) {
      capturarMuestra(State.lastSnapshot);
    }
  }
}

// ==============================================================================
// 9. TOASTS Y MÉTRICAS
// ==============================================================================
function showToast(message, type = 'toast-info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
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

setInterval(() => {
  const now = Date.now();
  const elapsedSec = (now - State.lastPacketTime) / 1000;
  if (elapsedSec >= 1.0) {
    State.currentHz = (State.packetCount / elapsedSec).toFixed(1);
    const hzEl = document.getElementById('hzMetric');
    if (hzEl) hzEl.textContent = State.isConnected ? State.currentHz : '0';
    State.packetCount = 0;
    State.lastPacketTime = now;
  }

  const totalSec = Math.floor((now - State.sessionStartTime) / 1000);
  const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');
  const timeEl = document.getElementById('sessionTime');
  if (timeEl) timeEl.textContent = `${mins}:${secs}`;
}, 1000);

// ==============================================================================
// 10. INICIALIZACIÓN Y EVENT LISTENERS
// ==============================================================================
document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  renderMotorCheckboxes();

  const btnConnect = document.getElementById('btnConnect');
  const serverInput = document.getElementById('serverUrl');
  const pollRateContainer = document.getElementById('pollRateContainer');
  const pollIntervalSelect = document.getElementById('pollInterval');
  const robotSelect = document.getElementById('robotSelect');

  btnConnect.addEventListener('click', () => {
    if (State.isConnected) {
      client.disconnect();
    } else {
      const mode = document.querySelector('input[name="commMode"]:checked').value;
      State.commMode = mode;
      client.connect(serverInput.value.trim(), mode);
    }
  });

  document.querySelectorAll('input[name="commMode"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      State.commMode = e.target.value;
      pollRateContainer.style.display = (State.commMode === 'poll') ? 'flex' : 'none';
      if (State.isConnected) {
        client.connect(serverInput.value.trim(), State.commMode);
      }
    });
  });

  pollIntervalSelect.addEventListener('change', (e) => {
    State.pollIntervalMs = parseInt(e.target.value, 10);
    if (State.isConnected && State.commMode === 'poll') {
      client.connect(serverInput.value.trim(), 'poll');
    }
  });

  if (robotSelect) {
    robotSelect.addEventListener('change', (e) => {
      const newModel = e.target.value;
      setRobotModel(newModel, newModel === 'go2' ? 12 : 29);
      if (State.isConnected) {
        client.connect(serverInput.value.trim(), State.commMode);
      }
    });
  }

  document.getElementById('btnCapture').addEventListener('click', () => capturarMuestra(State.lastSnapshot));
  document.getElementById('btnExportCSV').addEventListener('click', exportarCSV);
  document.getElementById('btnClearCaptures').addEventListener('click', clearCaptures);

  const btnScreenshot = document.getElementById('btnScreenshot');
  if (btnScreenshot) {
    btnScreenshot.addEventListener('click', tomarCapturaPantalla);
  }

  document.getElementById('autoAlertCapture').addEventListener('change', (e) => {
    State.autoAlertCaptureEnabled = e.target.checked;
  });

  // Intentar conectar automáticamente por WebSocket por defecto (o según query param)
  setTimeout(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const paramMode = urlParams.get('mode');
    const paramModel = urlParams.get('modelo') || urlParams.get('model');

    if (paramModel) {
      setRobotModel(paramModel, paramModel === 'go2' ? 12 : 29);
      if (robotSelect) robotSelect.value = paramModel;
    }

    const checkedMode = document.querySelector('input[name="commMode"]:checked');
    const mode = paramMode || (checkedMode ? checkedMode.value : 'ws');
    State.commMode = mode;

    const radioToSelect = document.querySelector(`input[name="commMode"][value="${mode}"]`);
    if (radioToSelect) radioToSelect.checked = true;

    client.connect(serverInput.value.trim(), mode);
  }, 250);
});
