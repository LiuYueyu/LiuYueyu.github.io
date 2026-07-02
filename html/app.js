const $ = (id) => document.getElementById(id);

const state = {
  config: {
    type: 'walker',
    orbitCount: 50,
    satsPerOrbit: 20,
    phaseFactor: 1,
    altitude: 520,
    inclinationDeg: 70,
    viewMode: 'north',
    customLat: 30,
    customLon: 110
  },
  layers: { satellite: true, orbit: true, inter: true, ground: true, label: true },
  satellites: [],
  nodes: [],
  hover: null,
  mouse: null,
  drag: { active: false, pointerId: null, startX: 0, startY: 0, startLat: 0, startLon: 0, moved: false },
  selectedSatId: null,
  view: 'global',
  tick: 0,
  startTime: Date.now() - (12 * 24 * 3600 + 4 * 3600 + 32 * 60 + 18) * 1000
};

const canvas = $('spaceCanvas');
const ctx = canvas.getContext('2d');
const tooltip = $('satTooltip');

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function normalizeLon(lon) { return ((((lon + 180) % 360) + 360) % 360) - 180; }
function pad(n, l = 2) { return String(n).padStart(l, '0'); }
function hash(seed) { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); }
function fmt(n) { return Number(n).toLocaleString('en-US'); }
function statusClass(s) { return s === '异常' ? 'bad' : s === '告警' ? 'warn' : 'ok'; }

const EARTH_RADIUS_KM = 6371;
const ORBIT_OUTER_SCREEN_RATIO = 0.36;

function totalSat() { return state.config.orbitCount * state.config.satsPerOrbit; }
function linkTotal() { return Math.round(totalSat() * 22.48); }
function bizTotal() { return Math.max(64, Math.round(totalSat() * 0.256)); }
function alarmTotal() { return Math.max(8, Math.round(totalSat() * 0.032)); }

function inclination() {
  return clamp(state.config.inclinationDeg || 70, 0, 180) * Math.PI / 180;
}

function orbitRadius() {
  // 以地球半径为基准：轨道半径 = 地球半径 + 轨道高度
  const alt = clamp(state.config.altitude || 520, 200, 36000);
  return (EARTH_RADIUS_KM + alt) / EARTH_RADIUS_KM;
}

function earthPixelRadius(w, h) {
  // 让外层轨道始终落在画面内，同时保持地球半径与轨道高度的物理比例关系。
  return Math.min(w, h) * ORBIT_OUTER_SCREEN_RATIO / orbitRadius();
}

function syncConfigFromUI() {
  state.config.type = $('constellationType').value;
  state.config.orbitCount = clamp(parseInt($('orbitCount').value || '50', 10), 1, 120);
  state.config.satsPerOrbit = clamp(parseInt($('satsPerOrbit').value || '20', 10), 1, 120);
  state.config.phaseFactor = clamp(parseInt($('phaseFactor').value || '1', 10), 0, 20);
  state.config.altitude = clamp(parseFloat($('orbitAltitude').value || '520'), 200, 36000);
  state.config.inclinationDeg = clamp(parseFloat($('orbitInclination').value || '70'), 0, 180);
  $('orbitAltitude').value = state.config.altitude;
  $('orbitInclination').value = state.config.inclinationDeg;
  state.config.viewMode = $('viewMode').value;
  state.config.customLat = clamp(parseFloat($('customLat').value || '30'), -90, 90);
  state.config.customLon = clamp(parseFloat($('customLon').value || '110'), -180, 180);
  $('customView').classList.toggle('hidden', state.config.viewMode !== 'custom');
}

function generateSatellites() {
  const list = [];
  const total = totalSat();
  let idx = 1;
  for (let o = 0; o < state.config.orbitCount; o++) {
    for (let s = 0; s < state.config.satsPerOrbit; s++) {
      const h = hash(idx * 17 + o * 7 + s);
      const status = h > 0.968 ? '异常' : h > 0.902 ? '告警' : '正常';
      list.push({
        id: 'SAT-' + pad(idx, 4),
        orbit: o + 1,
        slot: s + 1,
        status,
        statusType: statusClass(status),
        load: Math.round(30 + hash(idx + 3) * 62),
        compute: Math.round(35 + hash(idx + 9) * 58),
        storage: Math.round(30 + hash(idx + 13) * 65),
        power: Math.round(42 + hash(idx + 19) * 50),
        delay: Math.round(18 + hash(idx + 21) * 70),
        bw: (1.0 + hash(idx + 33) * 2.7).toFixed(1)
      });
      idx++;
    }
  }
  state.satellites = list;
  if (!state.selectedSatId || !list.some(s => s.id === state.selectedSatId)) state.selectedSatId = list[0]?.id || null;
  renderSatelliteSelect();
}

function statusSummary() {
  const r = { 正常: 0, 告警: 0, 异常: 0 };
  state.satellites.forEach(s => r[s.status]++);
  return r;
}

function observerAngles() {
  if (state.config.viewMode === 'north') return { lat: 90, lon: 0 };
  if (state.config.viewMode === 'south') return { lat: -90, lon: 0 };
  return { lat: state.config.customLat, lon: state.config.customLon };
}

function observerLabel() {
  if (state.config.viewMode === 'north') return '北极';
  if (state.config.viewMode === 'south') return '南极';
  return `${state.config.customLat}°, ${state.config.customLon}°`;
}


function setCustomObserver(lat, lon) {
  state.config.viewMode = 'custom';
  state.config.customLat = clamp(lat, -89.9, 89.9);
  state.config.customLon = normalizeLon(lon);
  $('viewMode').value = 'custom';
  $('customLat').value = state.config.customLat.toFixed(1).replace(/\.0$/, '');
  $('customLon').value = state.config.customLon.toFixed(1).replace(/\.0$/, '');
  $('customView').classList.remove('hidden');
}

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function beginDrag(e) {
  if (e.button !== undefined && e.button !== 0) return;
  const p = canvasPoint(e);
  const current = observerAngles();
  state.drag = {
    active: true,
    pointerId: e.pointerId ?? null,
    startX: p.x,
    startY: p.y,
    startLat: current.lat,
    startLon: current.lon,
    moved: false
  };
  state.mouse = null;
  tooltip.classList.add('hidden');
  canvas.classList.add('dragging');
  if (canvas.setPointerCapture && e.pointerId !== undefined) canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function updateDrag(e) {
  if (!state.drag.active) return false;
  const p = canvasPoint(e);
  const dx = p.x - state.drag.startX;
  const dy = p.y - state.drag.startY;
  if (Math.abs(dx) + Math.abs(dy) > 2) state.drag.moved = true;
  // 水平拖动控制经度，垂直拖动控制纬度；系数越小旋转越细腻。
  setCustomObserver(state.drag.startLat + dy * 0.24, state.drag.startLon - dx * 0.24);
  state.mouse = null;
  tooltip.classList.add('hidden');
  e.preventDefault();
  return true;
}

function endDrag(e) {
  if (!state.drag.active) return;
  if (canvas.releasePointerCapture && state.drag.pointerId !== null) {
    try { canvas.releasePointerCapture(state.drag.pointerId); } catch (_) {}
  }
  state.drag.active = false;
  state.drag.pointerId = null;
  canvas.classList.remove('dragging');
  renderGlobal();
}

function basis() {
  const { lat, lon } = observerAngles();
  const phi = lat * Math.PI / 180, lam = lon * Math.PI / 180;
  return {
    east: [-Math.sin(lam), Math.cos(lam), 0],
    north: [-Math.sin(phi) * Math.cos(lam), -Math.sin(phi) * Math.sin(lam), Math.cos(phi)],
    view: [Math.cos(phi) * Math.cos(lam), Math.cos(phi) * Math.sin(lam), Math.sin(phi)]
  };
}

function project(p, b, cx, cy, scale) {
  const x = p.x * b.east[0] + p.y * b.east[1] + p.z * b.east[2];
  const y = p.x * b.north[0] + p.y * b.north[1] + p.z * b.north[2];
  const d = p.x * b.view[0] + p.y * b.view[1] + p.z * b.view[2];
  return { x: cx + x * scale, y: cy - y * scale, depth: d };
}

function orbitPoint(raan, inc, u, radius = 1.58) {
  const co = Math.cos(raan), so = Math.sin(raan), ci = Math.cos(inc), si = Math.sin(inc), cu = Math.cos(u), su = Math.sin(u);
  return { x: radius * (co * cu - so * su * ci), y: radius * (so * cu + co * su * ci), z: radius * su * si };
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawStars(w, h) {
  ctx.save();
  for (let i = 0; i < 180; i++) {
    const x = hash(i + 1) * w, y = hash(i + 88) * h;
    ctx.fillStyle = `rgba(190,235,255,${0.12 + hash(i + 7) * 0.5})`;
    const s = 0.7 + hash(i + 9) * 1.6;
    ctx.fillRect(x, y, s, s);
  }
  ctx.restore();
}

function drawEarth(cx, cy, r) {
  const pulse = (Math.sin(state.tick * 0.018) + 1) / 2;

  // Reference-style Earth: deep-blue luminous globe with soft atmosphere and clouds.
  // Kept fully procedural; no screenshot or external image is used.
  ctx.save();
  const aura = ctx.createRadialGradient(cx, cy, r * 0.58, cx, cy, r * 1.55);
  aura.addColorStop(0, 'rgba(58, 168, 255, 0.24)');
  aura.addColorStop(0.45, 'rgba(22, 106, 220, 0.18)');
  aura.addColorStop(0.72, 'rgba(10, 38, 96, 0.10)');
  aura.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.52, 0, Math.PI * 2);
  ctx.fillStyle = aura;
  ctx.fill();
  ctx.restore();

  ctx.save();

  // Main sphere: closer to the earlier reference image, not the dense HUD/matrix style.
  const ocean = ctx.createRadialGradient(cx - r * 0.38, cy - r * 0.42, r * 0.08, cx + r * 0.18, cy + r * 0.18, r * 1.08);
  ocean.addColorStop(0, '#d9fbff');
  ocean.addColorStop(0.08, '#76dcff');
  ocean.addColorStop(0.20, '#2f9df1');
  ocean.addColorStop(0.46, '#0b58a5');
  ocean.addColorStop(0.72, '#062b68');
  ocean.addColorStop(0.92, '#020f32');
  ocean.addColorStop(1, '#010715');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = ocean;
  ctx.shadowColor = 'rgba(67, 189, 255, 0.82)';
  ctx.shadowBlur = 28;
  ctx.fill();
  ctx.clip();
  ctx.shadowBlur = 0;

  // Light falloff / terminator shading.
  const terminator = ctx.createLinearGradient(cx - r * 0.9, cy - r, cx + r, cy + r);
  terminator.addColorStop(0, 'rgba(255,255,255,0.12)');
  terminator.addColorStop(0.34, 'rgba(255,255,255,0.02)');
  terminator.addColorStop(0.72, 'rgba(0,18,55,0.36)');
  terminator.addColorStop(1, 'rgba(0,5,18,0.72)');
  ctx.fillStyle = terminator;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  // Continents: subdued blue-green, blended into the ocean like a dashboard background globe.
  const landPolys = [
    [[-.70,-.10],[-.60,-.24],[-.42,-.31],[-.24,-.24],[-.10,-.09],[-.18,.08],[-.38,.18],[-.58,.10]],
    [[-.28,.26],[-.10,.20],[.02,.34],[-.03,.54],[-.20,.60],[-.36,.46]],
    [[.06,-.40],[.28,-.45],[.48,-.30],[.56,-.08],[.42,.10],[.18,.03],[.02,-.18]],
    [[.18,.15],[.42,.18],[.60,.34],[.46,.54],[.20,.48],[.02,.30]],
    [[-.04,-.62],[.20,-.60],[.31,-.48],[.10,-.40],[-.14,-.48]]
  ];
  landPolys.forEach((poly, idx) => {
    ctx.beginPath();
    poly.forEach(([x, y], i) => {
      const px = cx + x * r;
      const py = cy + y * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = idx % 2 ? 'rgba(58, 132, 130, 0.62)' : 'rgba(78, 118, 108, 0.58)';
    ctx.fill();
  });

  // Cloud bands and swirls.
  ctx.save();
  ctx.globalAlpha = 0.42;
  ctx.strokeStyle = 'rgba(228, 250, 255, 0.55)';
  ctx.lineWidth = Math.max(1, r * 0.018);
  for (let i = 0; i < 9; i++) {
    const y = cy - r * 0.58 + i * r * 0.14;
    const amp = r * (0.035 + hash(i + 211) * 0.035);
    ctx.beginPath();
    for (let k = 0; k <= 70; k++) {
      const t = k / 70;
      const x = cx - r * 0.92 + t * r * 1.84;
      const yy = y + Math.sin(t * Math.PI * 2.4 + i * 0.8 + state.tick * 0.006) * amp;
      if (k === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  for (let i = 0; i < 16; i++) {
    const a = hash(i + 600) * Math.PI * 2;
    const rr = Math.sqrt(hash(i + 701)) * r * 0.72;
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr * 0.86;
    ctx.beginPath();
    ctx.ellipse(x, y, r * (0.035 + hash(i + 802) * 0.035), r * (0.010 + hash(i + 903) * 0.015), a * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(240, 252, 255, 0.22)';
    ctx.fill();
  }
  ctx.restore();

  // Subtle city lights on the darker side.
  for (let i = 0; i < 90; i++) {
    const a = hash(i + 1200) * Math.PI * 2;
    const rr = Math.sqrt(hash(i + 1300)) * r * 0.86;
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    const darkness = (x - cx) / r * 0.55 + (y - cy) / r * 0.25;
    if (darkness < -0.1) continue;
    const alpha = 0.10 + hash(i + 1400) * 0.46;
    ctx.fillStyle = `rgba(255, 206, 116, ${alpha})`;
    ctx.fillRect(x, y, 1.2, 1.2);
  }

  // Very faint globe grid only, avoiding the overly dense tech matrix look.
  ctx.save();
  ctx.globalAlpha = 0.30;
  ctx.strokeStyle = 'rgba(146, 226, 255, 0.20)';
  ctx.lineWidth = 0.8;
  for (let i = -3; i <= 3; i++) {
    ctx.beginPath();
    ctx.ellipse(cx, cy + i * r / 4.7, r * Math.sqrt(Math.max(0, 1 - (i / 4.9) ** 2)), r * 0.055, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let i = -3; i <= 3; i++) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 0.065, r, i * Math.PI / 7.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  // Soft lens-like highlight, similar to the reference globe lighting.
  const highlight = ctx.createRadialGradient(cx - r * 0.36, cy - r * 0.44, 0, cx - r * 0.36, cy - r * 0.44, r * 0.72);
  highlight.addColorStop(0, `rgba(255,255,255,${0.22 + pulse * 0.04})`);
  highlight.addColorStop(0.38, 'rgba(140,230,255,0.08)');
  highlight.addColorStop(1, 'rgba(140,230,255,0)');
  ctx.fillStyle = highlight;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  ctx.restore();

  // Bright atmospheric rim and two faint decorative arcs.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(118, 220, 255, 0.92)';
  ctx.lineWidth = 2.2;
  ctx.shadowColor = 'rgba(54, 202, 255, 0.9)';
  ctx.shadowBlur = 18;
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.08, 0.10, 1.32);
  ctx.strokeStyle = 'rgba(95, 206, 255, 0.34)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.08, 3.78, 5.12);
  ctx.stroke();
  ctx.restore();
}


function buildNodes(cx, cy, scale) {
  const b = basis();
  const inc = inclination();
  const radius = orbitRadius();
  const P = state.config.orbitCount, S = state.config.satsPerOrbit, F = state.config.phaseFactor, T = P * S;
  const nodes = [];
  const speed = state.tick * 0.004;
  for (let o = 0; o < P; o++) {
    const raan = (o / P) * Math.PI * 2;
    const walkerOffset = (2 * Math.PI * F * o) / T;
    for (let s = 0; s < S; s++) {
      const u = (s / S) * Math.PI * 2 + walkerOffset + speed;
      const p = orbitPoint(raan, inc, u, radius);
      const pr = project(p, b, cx, cy, scale);
      nodes.push({ ...pr, orbit: o, slot: s, sat: state.satellites[o * S + s] });
    }
  }
  state.nodes = nodes;
  return nodes;
}

function findHover() {
  if (!state.mouse) return null;
  let best = null, bestD = 99;
  for (const n of state.nodes) {
    const d = Math.hypot(n.x - state.mouse.x, n.y - state.mouse.y);
    if (d < bestD) { bestD = d; best = n; }
  }
  return bestD < 12 ? best : null;
}

function drawOrbits(cx, cy, scale, hover) {
  const b = basis(), inc = inclination(), P = state.config.orbitCount, radius = orbitRadius();
  ctx.save();
  for (let o = 0; o < P; o++) {
    ctx.beginPath();
    for (let k = 0; k <= 220; k++) {
      const p = orbitPoint((o / P) * Math.PI * 2, inc, (k / 220) * Math.PI * 2, radius);
      const pr = project(p, b, cx, cy, scale);
      if (k === 0) ctx.moveTo(pr.x, pr.y); else ctx.lineTo(pr.x, pr.y);
    }
    const hi = hover && hover.orbit === o;
    ctx.setLineDash(hi ? [] : (o % 2 ? [5, 5] : []));
    ctx.lineWidth = hi ? 2.2 : 1;
    ctx.strokeStyle = hi ? 'rgba(130,232,255,.95)' : 'rgba(30,135,255,.45)';
    ctx.shadowColor = hi ? '#50dbff' : 'transparent';
    ctx.shadowBlur = hi ? 12 : 0;
    ctx.stroke();
  }
  ctx.restore();
}

function linkStyle(i, cross=false, hi=false) {
  if (hi) return { color: 'rgba(150,240,255,.98)', width: 2.2, dash: [] };
  if (i % 23 === 0) return { color: 'rgba(255,70,70,.85)', width: 1.2, dash: [7,4] };
  if (cross) return { color: 'rgba(255,192,50,.55)', width: .9, dash: [4,5] };
  return { color: 'rgba(65,218,96,.60)', width: .9, dash: [4,4] };
}

function drawLinks(nodes, hover) {
  const P = state.config.orbitCount, S = state.config.satsPerOrbit;
  ctx.save();
  let idx = 0;
  for (let o = 0; o < P; o++) {
    for (let s = 0; s < S; s++) {
      const a = nodes[o * S + s], b = nodes[o * S + ((s + 1) % S)];
      const c = nodes[((o + 1) % P) * S + s];
      [[b, false], [c, true]].forEach(([to, cross]) => {
        const hi = hover && (a.sat.id === hover.sat.id || to.sat.id === hover.sat.id);
        const st = linkStyle(idx++, cross, hi);
        ctx.strokeStyle = st.color; ctx.lineWidth = st.width; ctx.setLineDash(st.dash);
        ctx.shadowColor = hi ? '#5ce7ff' : 'transparent'; ctx.shadowBlur = hi ? 9 : 0;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      });
    }
  }
  ctx.restore();
}

function drawStations(cx, cy, earthR) {
  const b = basis();
  const st = [
    { id:'GS-001', lat:39, lon:116 }, { id:'GS-005', lat:28, lon:-80 }, { id:'GS-008', lat:-35, lon:149 }, { id:'GS-012', lat:64, lon:-21 }
  ];
  ctx.save();
  st.forEach((g, i) => {
    const lat = g.lat * Math.PI/180, lon = g.lon * Math.PI/180;
    const p = { x: Math.cos(lat)*Math.cos(lon), y: Math.cos(lat)*Math.sin(lon), z: Math.sin(lat) };
    // 地面站位于地球表面，投影半径按地球半径绘制。
    const pr = project(p, b, cx, cy, earthR);
    if (pr.depth < -.2) return;
    ctx.fillStyle = 'rgba(230,250,255,.95)';
    ctx.beginPath(); ctx.arc(pr.x, pr.y, 5, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#24caff'; ctx.stroke();
    ctx.fillStyle = 'rgba(215,245,255,.8)'; ctx.font = '11px Microsoft YaHei'; ctx.fillText(g.id, pr.x + 7, pr.y + 4);
    const n = state.nodes[(i * 137) % state.nodes.length];
    if (n) { ctx.strokeStyle = 'rgba(255,74,74,.55)'; ctx.setLineDash([6,5]); ctx.beginPath(); ctx.moveTo(pr.x, pr.y); ctx.lineTo(n.x,n.y); ctx.stroke(); }
  });
  ctx.restore();
}

function drawSatellites(nodes, hover) {
  ctx.save();
  const sorted = [...nodes].sort((a,b)=>a.depth-b.depth);
  sorted.forEach((n, i) => {
    const hi = hover && hover.sat.id === n.sat.id;
    const same = hover && hover.orbit === n.orbit && !hi;
    const color = n.sat.statusType === 'bad' ? '#ff4e50' : n.sat.statusType === 'warn' ? '#ffc83d' : '#a9d7ff';
    const alpha = hi ? 1 : same ? .9 : .42 + Math.max(0,n.depth + 1) * .25;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color; ctx.shadowColor = hi ? '#fff' : color; ctx.shadowBlur = hi ? 20 : 8;
    ctx.beginPath(); ctx.arc(n.x,n.y,hi?6:3.2,0,Math.PI*2); ctx.fill();
    ctx.shadowBlur = 0; ctx.strokeStyle='rgba(255,255,255,.75)'; ctx.stroke();
    if (hi || (state.layers.label && i % Math.max(20, Math.floor(nodes.length / 40)) === 0)) {
      ctx.font = hi ? 'bold 11px Microsoft YaHei' : '10px Microsoft YaHei';
      ctx.fillStyle = hi ? '#fff' : 'rgba(210,240,255,.75)';
      ctx.fillText(n.sat.id, n.x + 7, n.y - 7);
    }
  });
  ctx.restore();
}

function drawTooltip(hover) {
  if (!hover) { tooltip.classList.add('hidden'); return; }
  const s = hover.sat;
  tooltip.innerHTML = `<h4>${s.id} <span class="${s.statusType}">${s.status}</span></h4>
    <div><span>轨道面</span><b>第 ${s.orbit} 轨</b></div>
    <div><span>轨位号</span><b>第 ${s.slot} 星</b></div>
    <div><span>载荷负载</span><b>${s.load}%</b></div>
    <div><span>计算资源</span><b>${s.compute}%</b></div>
    <div><span>存储资源</span><b>${s.storage}%</b></div>
    <div><span>链路带宽</span><b>${s.bw} Gbps</b></div>`;
  const rect = canvas.getBoundingClientRect();
  let x = hover.x + 14, y = hover.y - 10;
  if (x + 210 > rect.width) x = hover.x - 220;
  if (y + 165 > rect.height) y = rect.height - 170;
  if (y < 10) y = 10;
  tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
  tooltip.classList.remove('hidden');
}

function drawSpace() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  if (!w || !h) return;
  ctx.clearRect(0,0,w,h);
  drawStars(w,h);
  const cx = w * .5, cy = h * .48;
  const earthR = earthPixelRadius(w, h);
  const scale = earthR;
  const nodes = buildNodes(cx,cy,scale);
  const hover = findHover();
  if (state.layers.orbit) drawOrbits(cx,cy,scale,hover);
  if (state.layers.inter) drawLinks(nodes,hover);
  drawEarth(cx,cy,earthR);
  if (state.layers.ground) drawStations(cx,cy,earthR);
  if (state.layers.satellite) drawSatellites(nodes,hover);
  drawTooltip(hover);
}

function renderGlobal() {
  const status = statusSummary();
  const total = totalSat(), links = linkTotal(), biz = bizTotal(), alarms = alarmTotal();
  $('globalCards').innerHTML = [
    ['🛰','卫星总数', fmt(total), `在线 ${fmt(status.正常 + status.告警)}`, `离线 ${fmt(status.异常)}`],
    ['🔗','链路总数', fmt(links), `正常 ${fmt(Math.round(links*.9765))}`, `异常 ${fmt(Math.round(links*.0235))}`],
    ['▰','业务总数', fmt(biz), `正常 ${fmt(Math.round(biz*.9375))}`, `异常 ${fmt(Math.round(biz*.0625))}`],
    ['⚠','告警总数', fmt(alarms), `紧急 ${Math.max(1,Math.round(alarms*.12))}`, `重要 ${Math.round(alarms*.38)}`]
  ].map((c,i)=>`<div class="global-card ${i===3?'alarm':''}"><div class="icon">${c[0]}</div><div class="name">${c[1]}</div><div class="value">${c[2]}</div><div class="sub"><span>${c[3]}</span><span>${c[4]}</span></div></div>`).join('');

  $('networkStatus').innerHTML = [
    ['网络可用性','99.28%'],['平均时延','48.6 ms'],['地球半径',`${EARTH_RADIUS_KM} km`],['轨道高度',`${state.config.altitude} km`],['轨道倾角',`${state.config.inclinationDeg}°`]
  ].map(x=>`<div class="status-card"><div class="k">${x[0]}</div><div class="v">${x[1]}</div></div>`).join('');

  renderTable('linkTable',['链路类型','正常链路','异常链路','总数','异常占比','平均时延'],[
    ['星间链路',fmt(Math.round(links*.66)),fmt(Math.round(links*.016)),fmt(Math.round(links*.676)),'2.42%','23.5 ms'],
    ['跨轨链路',fmt(Math.round(links*.184)),fmt(Math.round(links*.0095)),fmt(Math.round(links*.1935)),'4.93%','35.8 ms'],
    ['地面链路',fmt(Math.round(links*.133)),fmt(Math.round(links*.0014)),fmt(Math.round(links*.1344)),'1.06%','45.2 ms'],
    ['合计',fmt(Math.round(links*.977)),fmt(Math.round(links*.027)),fmt(links),'2.72%','28.4 ms']
  ]);
  renderRings('resourceRings',[
    ['卫星健康度',98.2,'var(--green)','正常'],['电源状态',92.6,'var(--green)','正常'],['推进剂余量',87.3,'var(--blue)','充足'],['载荷状态',95.1,'var(--green)','正常'],['星间带宽利用率',71.4,'var(--yellow)','中等']
  ]);
  renderTable('alarmTable',['级别','告警名称','关联对象','发生时间','状态'],[
    ['紧急','星间链路中断','SAT-0242 ↔ SAT-0432','2026-06-17 15:26:31','未恢复'],
    ['重要','组通信余量不足','SAT-0211 ↔ SAT-0422','2026-06-17 15:26:18','处理中'],
    ['次要','载荷温度偏高','SAT-0189','2026-06-17 15:24:45','已恢复'],
    ['次要','姿态遥测异常','SAT-0135','2026-06-17 15:22:07','已恢复'],
    ['提示','星间心跳丢失','SAT-0472','2026-06-17 15:19:33','已恢复']
  ]);
  drawCharts();
}

function renderRings(id, items) {
  $(id).innerHTML = items.map(x=>`<div class="ring"><div class="ring-circle" style="--v:${x[1]};--c:${x[2]}"><span>${x[1]}%</span></div><div class="ring-label">${x[0]}<br><b>${x[3]}</b></div></div>`).join('');
}

function renderTable(id, headers, rows) {
  $(id).innerHTML = `<thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td class="${c==='未恢复'?'bad':c==='处理中'?'warn':c==='已恢复'?'ok':''}">${c}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

function renderSatelliteSelect() {
  const sel = $('satelliteSelect');
  const max = Math.min(state.satellites.length, 1000);
  sel.innerHTML = state.satellites.slice(0,max).map(s=>`<option value="${s.id}">${s.id}</option>`).join('');
  sel.value = state.selectedSatId;
}

function selectedSat() { return state.satellites.find(s=>s.id===state.selectedSatId) || state.satellites[0]; }

function renderSingle() {
  const s = selectedSat(); if (!s) return;
  $('singleTitle').textContent = `单星信息 - ${s.id}`;
  $('singleSummary').innerHTML = [
    ['状态',s.status],['轨道面',`第 ${s.orbit} 轨`],['轨位号',`第 ${s.slot} 星`],['高度',`${state.config.altitude} km`],['倾角',`${state.config.inclinationDeg}°`],['相位因子',state.config.phaseFactor]
  ].map(x=>`<div class="single-item"><span>${x[0]}</span><b>${x[1]}</b></div>`).join('');
  renderRings('singleRings',[
    ['载荷负载',s.load, s.load>80?'var(--yellow)':'var(--green)', s.load>80?'偏高':'正常'],
    ['计算资源',s.compute,'var(--cyan)','正常'],['存储资源',s.storage,'var(--blue)','正常'],['电源裕量',s.power,'var(--green)','正常'],['链路质量',Math.max(62,100-s.delay),'var(--green)','良好']
  ]);
  const idx = s.index ? s.index : state.satellites.indexOf(s)+1;
  renderTable('singleLinkTable',['链路对象','类型','状态','带宽','时延'],[
    [`SAT-${pad((idx%totalSat())+1,4)}`,'同轨链路','正常',`${s.bw} Gbps`,`${s.delay} ms`],
    [`SAT-${pad(((idx+state.config.satsPerOrbit)%totalSat())+1,4)}`,'跨轨链路',s.status==='异常'?'异常':'正常',`${(s.bw*0.8).toFixed(1)} Gbps`,`${s.delay+8} ms`],
    ['GS-001','星地链路','正常','3.2 Gbps','42 ms']
  ]);
  renderTable('singleServiceTable',['业务','状态','资源占用','告警'],[
    ['遥感数据下传',s.status==='异常'?'异常':'正常',`${Math.round(s.load*.7)}%`,s.status==='异常'?'链路抖动':'无'],
    ['星间协同路由','正常',`${Math.round(s.compute*.55)}%`,'无'],
    ['遥测上报','正常','18%','无'],
    ['星上计算任务',s.compute>85?'告警':'正常',`${s.compute}%`,s.compute>85?'资源偏高':'无']
  ]);
}

function setView(v) {
  state.view = v;
  $('globalBtn').classList.toggle('active',v==='global');
  $('singleBtn').classList.toggle('active',v==='single');
  $('globalView').classList.toggle('active',v==='global');
  $('singleView').classList.toggle('active',v==='single');
  renderSingle();
}

function drawCharts() {
  drawDonut();
  drawLine('linkTrend');
  drawBars('alarmTrend');
}

function drawDonut() {
  const c = $('statusDonut'), r = statusSummary();
  const ctx2 = c.getContext('2d'), w=c.clientWidth||120,h=c.clientHeight||140,dpr=window.devicePixelRatio||1;
  c.width=w*dpr;c.height=h*dpr;ctx2.setTransform(dpr,0,0,dpr,0,0);ctx2.clearRect(0,0,w,h);
  const vals=[r.正常,r.告警,r.异常], colors=['#38e58b','#ffc83d','#ff4e50'], total=vals.reduce((a,b)=>a+b,0);
  let a=-Math.PI/2; vals.forEach((v,i)=>{ const e=a+v/total*Math.PI*2; ctx2.beginPath();ctx2.moveTo(w/2,h/2);ctx2.arc(w/2,h/2,46,a,e);ctx2.fillStyle=colors[i];ctx2.fill();a=e;});
  ctx2.globalCompositeOperation='destination-out';ctx2.beginPath();ctx2.arc(w/2,h/2,28,0,Math.PI*2);ctx2.fill();ctx2.globalCompositeOperation='source-over';
  $('statusLegend').innerHTML = `<div><i style="background:#38e58b"></i>正常 ${fmt(r.正常)} (${(r.正常/total*100).toFixed(1)}%)</div><div><i style="background:#ffc83d"></i>异常 ${fmt(r.告警)}</div><div><i style="background:#ff4e50"></i>离线 ${fmt(r.异常)}</div>`;
}

function chartSetup(id){ const c=$(id),ctx3=c.getContext('2d'),w=c.clientWidth,h=c.clientHeight,dpr=window.devicePixelRatio||1;c.width=w*dpr;c.height=h*dpr;ctx3.setTransform(dpr,0,0,dpr,0,0);ctx3.clearRect(0,0,w,h);return {c,ctx:ctx3,w,h};}
function drawAxis(ctx,w,h){ctx.strokeStyle='rgba(110,170,230,.22)';ctx.lineWidth=1;for(let i=0;i<4;i++){const y=20+i*(h-36)/3;ctx.beginPath();ctx.moveTo(28,y);ctx.lineTo(w-10,y);ctx.stroke();}}
function drawLine(id){const {ctx,w,h}=chartSetup(id);drawAxis(ctx,w,h);const n=28;ctx.strokeStyle='#37e58b';ctx.lineWidth=2;ctx.beginPath();for(let i=0;i<n;i++){const v=.58+hash(i+88)*.25+Math.sin(i*.8)*.06;const x=30+i*(w-45)/(n-1),y=h-22-v*(h-45);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.stroke();ctx.strokeStyle='#ff4e50';ctx.beginPath();for(let i=0;i<n;i++){const v=.05+hash(i+188)*.06;const x=30+i*(w-45)/(n-1),y=h-22-v*(h-45);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.stroke();}
function drawBars(id){const {ctx,w,h}=chartSetup(id);drawAxis(ctx,w,h);const n=24,bw=(w-42)/n-3;for(let i=0;i<n;i++){const total=16+hash(i+50)*38;let x=30+i*(bw+3),bottom=h-22;['#1d86ff','#ffc83d','#ff9e2d','#ff4e50'].forEach((col,j)=>{const bh=total*(.18+j*.09+hash(i+j*8)*.12);ctx.fillStyle=col;ctx.fillRect(x,bottom-bh,bw,bh);bottom-=bh;});}}

function updateTime() {
  const now = new Date();
  const t = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const compactTime = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  $('clock').textContent = t; $('netTime').textContent = compactTime;
  const sec = Math.floor((Date.now()-state.startTime)/1000);
  const d=Math.floor(sec/86400), h=Math.floor(sec%86400/3600), m=Math.floor(sec%3600/60), s=sec%60;
  $('runTime').textContent = `${d}天 ${pad(h)}:${pad(m)}:${pad(s)}`;
}

function applyAll() {
  syncConfigFromUI();
  generateSatellites();
  renderGlobal(); renderSingle();
  drawSpace();
}

function bind() {
  $('applyBtn').addEventListener('click', applyAll);
  $('viewMode').addEventListener('change', () => { syncConfigFromUI(); applyAll(); });
  $('globalBtn').addEventListener('click',()=>setView('global'));
  $('singleBtn').addEventListener('click',()=>setView('single'));
  $('satelliteSelect').addEventListener('change', e=>{state.selectedSatId=e.target.value; setView('single');});
  document.querySelectorAll('[data-layer]').forEach(cb=>cb.addEventListener('change',e=>{state.layers[e.target.dataset.layer]=e.target.checked;}));
  canvas.addEventListener('pointerdown', beginDrag);
  canvas.addEventListener('pointermove', e=>{
    if (updateDrag(e)) return;
    const p = canvasPoint(e);
    state.mouse = { x: p.x, y: p.y };
  });
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave',()=>{
    if (state.drag.active) return;
    state.mouse=null; tooltip.classList.add('hidden');
  });
  window.addEventListener('resize',()=>{resize(); drawCharts();});
}

function init(){
  generateSatellites(); renderSatelliteSelect(); renderGlobal(); renderSingle(); bind(); resize(); updateTime();
  setInterval(updateTime,1000);
  function loop(){ state.tick++; drawSpace(); requestAnimationFrame(loop); }
  loop();
}
init();
