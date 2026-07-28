import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { buildTreeData } from './tree.js';
import {
  createUniforms, createFruitMesh, createBranchLines, createGround,
} from './materials.js';

const YMAX = 40;
const $ = (id) => document.getElementById(id);

// ============ エラー可視化(WebGPU 非対応やシェーダ失敗を画面に出す) ============
function showError(msg) {
  let el = $('err');
  if (!el) {
    el = document.createElement('div');
    el.id = 'err';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99;background:rgba(60,10,14,.92);' +
      'color:#F5C6C6;font:12px/1.7 monospace;padding:12px 16px;white-space:pre-wrap;letter-spacing:.03em';
    document.body.appendChild(el);
  }
  el.textContent = '⚠ ' + msg;
}
addEventListener('error', (e) => showError(e.message || String(e.error)));
addEventListener('unhandledrejection', (e) => showError('Promise: ' + (e.reason?.message || e.reason)));

// ============ レンダラ(WebGPU、非対応は WebGL2 に自動フォールバック) ============
const stage = $('stage');
const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
stage.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x05080F, 0.028);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const U = createUniforms();
scene.add(createGround(U));

// ============ 落下パレット: 熟した灯の色から HSL で類似 4 色を作る ============
// (完全ランダムではなく、色相を隣へ少しずつ・明度差をつけた調和色)
const PAL_DEFS = [
  [-0.055, 0.00, +0.02],   // 少し赤寄り
  [0.000, 0.05, +0.08],    // 本命を明るく
  [+0.045, -0.05, -0.02],  // 少し黄寄り
  [+0.100, -0.10, -0.06],  // さらに隣へ、落ち着いた一色
];
// customPal=true のテーマは落下色を複数色相で明示指定(カラフル)。
// false のときは熟した灯の色から類似 4 色を生成(同系統)。
let customPal = false;
function renderSwatch() {
  const sw = $('swatch');
  sw.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const el = document.createElement('i');
    el.style.background = '#' + U.uPal.array[i].getHexString();
    sw.appendChild(el);
  }
}
function updatePalette() {
  if (!customPal) {
    const hueK = parseFloat($('pHue').value);
    const litK = parseFloat($('pLit').value);
    const satAdj = parseFloat($('pSat').value);
    const hsl = { h: 0, s: 0, l: 0 };
    U.uRipeCol.value.getHSL(hsl);
    PAL_DEFS.forEach((d, i) => {
      const h = (hsl.h + d[0] * hueK + 1) % 1;
      const s = Math.min(0.95, Math.max(0.35, hsl.s + d[1] + satAdj));
      const l = Math.min(0.80, Math.max(0.30, hsl.l + d[2] * litK));
      U.uPal.array[i].setHSL(h, s, l);
    });
  }
  renderSwatch();
}

// ============ 木上パレット: 若い灯〜熟した灯から調和する 4 色を作る ============
function updateCanopyPalette(explicit = null) {
  if (explicit) {
    explicit.forEach((hex, i) => U.uCanopyPal.array[i].set(hex));
    return;
  }
  const young = U.uYoungCol.value;
  const ripe = U.uRipeCol.value;
  const stops = [0.0, 0.32, 0.68, 1.0];
  const hueShift = [-0.018, 0.014, -0.012, 0.020];
  stops.forEach((t, i) => {
    const c = U.uCanopyPal.array[i].lerpColors(young, ripe, t);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    c.setHSL(
      (hsl.h + hueShift[i] + 1) % 1,
      Math.min(0.95, hsl.s + 0.05),
      Math.min(0.78, Math.max(0.38, hsl.l + (i % 2 ? 0.05 : -0.01))),
    );
  });
}

// ============ 樹の構築(シード・数・枝密度・ワイブルから再現可能) ============
let branchLines = null, fruitMesh = null, life = null, N = 0;
let branchWidth = parseFloat($('branchWidthIn').value) || 1.0;

function rebuild() {
  const seed = parseInt($('seedIn').value) || 0;
  const count = parseInt($('cntIn').value) || 24000;
  const depth = parseInt($('depthIn').value) || 14;
  const k = parseFloat($('pK').value) || 3.0;
  const eta = parseFloat($('pEta').value) || 21.2;

  const data = buildTreeData(seed, count, { k, eta, depth });

  if (branchLines) { scene.remove(branchLines); branchLines.geometry.dispose(); }
  if (fruitMesh) { scene.remove(fruitMesh); fruitMesh.geometry.dispose(); fruitMesh.dispose(); }

  branchLines = createBranchLines(U, data, branchWidth);
  scene.add(branchLines);
  fruitMesh = createFruitMesh(U, data);
  scene.add(fruitMesh);

  life = data.fruitLife; N = data.N;
  $('totalOut').textContent = N;
  refresh();
}

// ============ 経過年数(スライダーは表示装置、真実は yearVal) ============
let yearVal = 0;
let graphOpen = false;
let latestAlive = 0;
function setYear(v) {
  yearVal = Math.max(0, Math.min(YMAX, v));
  $('yrIn').value = yearVal;
  refresh();
}
function refresh() {
  U.uYear.value = yearVal;
  $('yrOut').textContent = yearVal.toFixed(1);
  let alive = 0;
  for (let i = 0; i < N; i++) if (life[i] > yearVal) alive++;
  latestAlive = alive;
  $('aliveOut').textContent = alive;
  if (graphOpen) drawWeibullGraph();
}

// ============ ワイブル分析: S(t), F(t), h(t) と実測点灯率 ============
function drawWeibullGraph() {
  if (!graphOpen) return;
  const canvas = $('chartCanvas');
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  const dpr = Math.min(devicePixelRatio, 2);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const k = parseFloat($('pK').value) || 3;
  const eta = parseFloat($('pEta').value) || 21.2;
  const pad = { l: 28, r: 28, t: 12, b: 22 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const px = (t) => pad.l + (t / YMAX) * pw;
  const py = (v) => pad.t + (1 - v) * ph;
  const survival = (t) => Math.exp(-Math.pow(t / eta, k));
  const failure = (t) => 1 - survival(t);
  const hazard = (t) => (k / eta) * Math.pow(Math.max(t, 0.001) / eta, k - 1);

  // 分析ページらしい細かなグリッドと時間軸。
  ctx.font = '8px "Zen Kaku Gothic New", sans-serif';
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(147,163,174,.09)';
  ctx.fillStyle = 'rgba(147,163,174,.45)';
  ctx.textAlign = 'right';
  [0, 0.25, 0.5, 0.75, 1].forEach((v) => {
    ctx.beginPath(); ctx.moveTo(pad.l, py(v)); ctx.lineTo(w - pad.r, py(v)); ctx.stroke();
    ctx.fillText(`${Math.round(v * 100)}`, pad.l - 6, py(v) + 3);
  });
  ctx.textAlign = 'center';
  [0, 10, 20, 30, 40].forEach((t) => {
    ctx.beginPath(); ctx.moveTo(px(t), pad.t); ctx.lineTo(px(t), h - pad.b); ctx.stroke();
    ctx.fillText(`${t}`, px(t), h - 5);
  });

  let hazardMax = 0;
  for (let i = 0; i <= 160; i++) hazardMax = Math.max(hazardMax, hazard(YMAX * i / 160));
  hazardMax = Math.max(hazardMax, 0.001);
  const hazardNorm = (t) => Math.min(1, hazard(t) / hazardMax);

  const drawCurve = (fn, color, dashed = false) => {
    const path = new Path2D();
    for (let i = 0; i <= 180; i++) {
      const t = YMAX * i / 180;
      const x = px(t), y = py(fn(t));
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.45;
    ctx.setLineDash(dashed ? [4, 4] : []);
    ctx.shadowColor = color;
    ctx.shadowBlur = 7;
    ctx.stroke(path);
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
  };
  drawCurve(survival, '#72D9D0');
  drawCurve(failure, '#E8C15A');
  drawCurve(hazardNorm, '#B586E8', true);

  // 現在年の走査線と、木の実測値を重ねる。
  const nowX = px(yearVal);
  const sNow = survival(yearVal);
  const actualNow = N ? latestAlive / N : 0;
  const fNow = failure(yearVal);
  const hNow = hazard(yearVal);
  ctx.strokeStyle = 'rgba(233,237,233,.56)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);
  ctx.beginPath(); ctx.moveTo(nowX, pad.t); ctx.lineTo(nowX, h - pad.b); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(232,193,90,.28)';
  ctx.beginPath(); ctx.moveTo(nowX, py(sNow)); ctx.lineTo(nowX, py(actualNow)); ctx.stroke();
  [['#72D9D0', sNow], ['#E8C15A', fNow], ['#B586E8', hazardNorm(yearVal)]].forEach(([color, value]) => {
    ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(nowX, py(value), 2.8, 0, Math.PI * 2); ctx.fill();
  });
  ctx.fillStyle = '#FFFFFF'; ctx.shadowColor = '#E8C15A'; ctx.shadowBlur = 14;
  ctx.beginPath(); ctx.arc(nowX, py(actualNow), 2.2, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;

  $('chartNow').textContent = `t = ${yearVal.toFixed(1)} 年`;
  $('mSurvival').textContent = `${(sNow * 100).toFixed(1)}%`;
  $('mFailure').textContent = `${(fNow * 100).toFixed(1)}%`;
  $('mHazard').textContent = hNow.toFixed(3);
  $('mActual').textContent = `${(actualNow * 100).toFixed(1)}%`;
}

// ============ UI 配線 ============
const rotBtn = $('rot');
let rotating = true, rotAngle = 0, rotSpeed = 0.05;
rotBtn.addEventListener('click', () => { rotating = !rotating; rotBtn.classList.toggle('on', rotating); });
$('rotSpeedIn').addEventListener('input', (e) => {
  rotSpeed = parseFloat(e.target.value);
  $('rotSpeedv').textContent = rotSpeed.toFixed(2);
  rotBtn.classList.toggle('on', rotating && rotSpeed > 0);
});

const playBtn = $('play');
let playing = false;
function stopPlay() { playing = false; playBtn.textContent = '▶'; }
function startPlay() {
  if (yearVal >= YMAX - 0.1) setYear(0);
  playing = true; playBtn.textContent = '❚❚';
}
playBtn.addEventListener('click', () => (playing ? stopPlay() : startPlay()));
addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); playing ? stopPlay() : startPlay(); }
});
$('yrIn').addEventListener('input', () => { stopPlay(); setYear(parseFloat($('yrIn').value) || 0); });
$('replay').addEventListener('click', () => { stopPlay(); setYear(0); });
function setGraph(open) {
  graphOpen = open;
  document.body.classList.toggle('analysis-mode', open);
  $('weibullChart').classList.toggle('open', open);
  $('weibullChart').setAttribute('aria-hidden', String(!open));
  $('chartBtn').classList.toggle('on', open);
  $('chartBtn').textContent = 'PANEL';
  $('chartBtn').title = open ? 'サイドパネルを閉じる' : 'サイドパネルを表示';
  setSide(open);
  if (open) drawWeibullGraph();
  requestAnimationFrame(resize);
}
$('chartBtn').addEventListener('click', () => setGraph(!graphOpen));
$('closeChart').addEventListener('click', () => setGraph(false));
$('szIn').addEventListener('input', (e) => {
  U.uFruitScale.value = parseFloat(e.target.value);
  $('szv').textContent = parseFloat(e.target.value).toFixed(2);
});
$('branchWidthIn').addEventListener('input', (e) => {
  branchWidth = parseFloat(e.target.value);
  $('branchWidthv').textContent = branchWidth.toFixed(1);
  if (branchLines) branchLines.material.linewidth = branchWidth;
});
$('groundGlowIn').addEventListener('input', (e) => {
  U.uGroundGlow.value = parseFloat(e.target.value);
  $('groundGlowv').textContent = U.uGroundGlow.value.toFixed(2);
});
$('groundSpreadIn').addEventListener('input', (e) => {
  U.uGroundSpread.value = parseFloat(e.target.value);
  $('groundSpreadv').textContent = U.uGroundSpread.value.toFixed(1);
});
$('depthIn').addEventListener('input', () => { $('depthv').textContent = $('depthIn').value; });

// 詳細パラメータ開閉
$('advBtn').addEventListener('click', (e) => {
  const open = $('adv').classList.toggle('open');
  e.target.textContent = open ? '詳細パラメータ ▴' : '詳細パラメータ ▾';
});

// 樹形・数・枝密度・ワイブル(要再構築)
$('seedIn').addEventListener('change', rebuild);
$('cntIn').addEventListener('change', rebuild);
$('depthIn').addEventListener('input', rebuild);
$('dice').addEventListener('click', () => { $('seedIn').value = Math.floor(Math.random() * 100000); rebuild(); });

// 基調色(4色ピッカー)。熟した灯を変えたら落下パレットも作り直す
const COLMAP = { cTrunk: 'uTrunkCol', cTwig: 'uTwigCol', cYoung: 'uYoungCol', cRipe: 'uRipeCol' };
Object.entries(COLMAP).forEach(([id, u]) => {
  $(id).addEventListener('input', (e) => {
    U[u].value.set(e.target.value);
    if (u === 'uYoungCol' || u === 'uRipeCol') updateCanopyPalette();
    if (u === 'uRipeCol') { customPal = false; updatePalette(); }
    document.querySelectorAll('.pal').forEach((b) => b.classList.remove('on'));
  });
});

// パレットプリセット。
//  ・cTrunk/cTwig/cYoung/cRipe/cMist … 樹と霧の基調色
//  ・pal[] を持つテーマは「落下色を複数色相で明示指定」= カラフル(同系統ではない)
//  ・pal を持たないテーマは従来どおり「熟した灯から類似色を生成」= 同系統
const PALETTES = {
  // --- おすすめ配色 ---
  ember: {
    cTrunk: '#FFE8CF', cTwig: '#7D4028', cYoung: '#789B35', cRipe: '#C7372F', cMist: '#E97832',
    canopy: ['#496B35', '#D5A62E', '#E96A24', '#A51F27'],
    pal: ['#8F1D24', '#D94828', '#ED8A24', '#6E7830'],
  }, // 黄昏: 深緑を残した紅葉〜燃える楓
  prism: { // 極彩: 桃・橙・翠・碧の四色相
    cTrunk: '#FFFFFF', cTwig: '#7A88C9', cYoung: '#4DA6FF', cRipe: '#FF6FA3', cMist: '#FFC15E',
    canopy: ['#47C8FF', '#55E08D', '#FFD34E', '#FF5EA8'],
    pal: ['#FF4D6D', '#FFB03A', '#4DE0A0', '#4DA6FF'],
  },
  neon: { // ネオン: マゼンタ・シアン・ライム・菫
    cTrunk: '#EAF6FF', cTwig: '#2AA6A0', cYoung: '#22E0D8', cRipe: '#FF3DAE', cMist: '#B6FF3D',
    canopy: ['#12F7E4', '#B6FF3D', '#FF35C8', '#955CFF'],
    pal: ['#FF3DAE', '#22E0D8', '#B6FF3D', '#9B5CFF'],
  },
  galaxy: { // 銀河: 碧・菫・桃・金
    cTrunk: '#DCE6FF', cTwig: '#4A5CA0', cYoung: '#5AC8FF', cRipe: '#FF6BD6', cMist: '#9B7BFF',
    canopy: ['#55D7FF', '#5475E8', '#A66BFF', '#FF78C9'],
    pal: ['#5AC8FF', '#9B7BFF', '#FF6BD6', '#FFD36B'],
  },
  aurora: { // オーロラ: 木上にも翠・碧・菫・桃の揺らぎ
    cTrunk: '#E8FBFF', cTwig: '#397D83', cYoung: '#4EF2C2', cRipe: '#A879FF', cMist: '#72D9FF',
    canopy: ['#55F2B8', '#56E6E6', '#78A8FF', '#D18CFF'],
    pal: ['#43E6B1', '#53D7FF', '#9A7BFF', '#F28AD8'],
  },
  primary: { // 原色: 混じり気のない赤・黄・青・緑
    cTrunk: '#FFFFFF', cTwig: '#175CFF', cYoung: '#006CFF', cRipe: '#FF1744', cMist: '#FFD600',
    canopy: ['#006CFF', '#00E65C', '#FFD600', '#FF1744'],
    pal: ['#FF1744', '#FF7A00', '#FFD600', '#006CFF'],
  },
  // --- 季節(多色) ---
  hanami: { // 桜: 淡紅〜白の花びら
    cTrunk: '#FFF3F7', cTwig: '#9C6B7E', cYoung: '#FFC2D6', cRipe: '#FF8FB4', cMist: '#FFD9E4',
    canopy: ['#FFF7FA', '#FFD7E5', '#FF9DBC', '#D95D8C'],
    pal: ['#FFB3C9', '#FF7FA8', '#FFE0EC', '#E86B9E'],
  },
  shinryoku: { // 新緑: 若葉のシャルトルーズ〜翠
    cTrunk: '#EAF7DA', cTwig: '#9E6C00', cYoung: '#A6E86B', cRipe: '#4FC96E', cMist: '#C8F0A0',
    canopy: ['#D7F477', '#9BE764', '#50C96F', '#187A4D'],
    pal: ['#9BE870', '#5FCB6A', '#D6E85A', '#3FB58C'],
  },
  // --- 和のパレット(サンプル準拠・類似色) ---
  sakura: { // 夜桜: 月明かりの青〜夜に浮かぶ桜色
    cTrunk: '#D8ECF4', cTwig: '#46759E', cYoung: '#7FD8DE', cRipe: '#F48FB1', cMist: '#C6B7E8',
    canopy: ['#FFB8D4', '#8CBCE3', '#E57FC2', '#FF91B5'],
  },
  hotaru: { // 蛍火: 水辺の青緑〜瞬く黄金
    cTrunk: '#CCEBE6', cTwig: '#61A8A8', cYoung: '#73DBCC', cRipe: '#F5B866', cMist: '#D9F58A',
    canopy: ['#61D9C5', '#92E68A', '#D8EC63', '#FFC45C'],
  },
  shigyo: { // 紫暁: 夜の藍〜朝焼けの紫桃
    cTrunk: '#E4D9F2', cTwig: '#6E5A9E', cYoung: '#8F86E8', cRipe: '#E070C8', cMist: '#C990E8',
    canopy: ['#6667C9', '#9A78E8', '#CF70D5', '#F08EBC'],
  },
};
function applyPalette(name) {
  const p = PALETTES[name]; if (!p) return;
  Object.entries(COLMAP).forEach(([id, u]) => {
    if (p[id]) { $(id).value = p[id]; U[u].value.set(p[id]); }
  });
  if (p.cMist) { $('cMist').value = p.cMist; U.uMistCol.value.set(p.cMist); }
  updateCanopyPalette(p.canopy || null);
  if (p.pal) { customPal = true; p.pal.forEach((hex, i) => U.uPal.array[i].set(hex)); }
  else { customPal = false; }
  updatePalette();
  document.querySelectorAll('.pal').forEach((b) => b.classList.toggle('on', b.dataset.p === name));
}
document.querySelectorAll('.pal').forEach((b) => b.addEventListener('click', () => applyPalette(b.dataset.p)));

// ワイブル(値表示 + 再構築)。η はスライダー上限も同期
$('pK').addEventListener('input', () => {
  const v = parseFloat($('pK').value);
  $('pKv').textContent = v.toFixed(2);
  $('aK').value = v;
  $('aKv').textContent = v.toFixed(2);
  drawWeibullGraph();
});
$('pK').addEventListener('change', rebuild);
$('pEta').addEventListener('input', () => {
  const v = parseFloat($('pEta').value);
  $('pEtav').textContent = v.toFixed(1);
  $('aEta').value = v;
  $('aEtav').textContent = v.toFixed(1);
  $('yrIn').max = Math.max(YMAX, v * 1.9).toFixed(0);
  drawWeibullGraph();
});
$('pEta').addEventListener('change', rebuild);

// 分析画面のクイック操作を、操作盤の同じパラメータへ同期する。
$('aK').addEventListener('input', () => {
  const v = parseFloat($('aK').value);
  $('pK').value = v;
  $('pKv').textContent = v.toFixed(2);
  $('aKv').textContent = v.toFixed(2);
  drawWeibullGraph();
});
$('aK').addEventListener('change', rebuild);
$('aEta').addEventListener('input', () => {
  const v = parseFloat($('aEta').value);
  $('pEta').value = v;
  $('pEtav').textContent = v.toFixed(1);
  $('aEtav').textContent = v.toFixed(1);
  $('yrIn').max = Math.max(YMAX, v * 1.9).toFixed(0);
  drawWeibullGraph();
});
$('aEta').addEventListener('change', rebuild);

// タイミング・霧色(即時反映)
const bindLive = (id, valId, uni) => $(id).addEventListener('input', () => {
  U[uni].value = parseFloat($(id).value); $(valId).textContent = parseFloat($(id).value).toFixed(2);
});
bindLive('pFall', 'pFallv', 'uFall');
bindLive('pMist', 'pMistv', 'uMist');
$('cMist').addEventListener('input', (e) => U.uMistCol.value.set(e.target.value));

// パレット生成パラメータ(即時反映 + プレビュー)
['pHue', 'pLit', 'pSat'].forEach((id) => {
  $(id).addEventListener('input', () => {
    $(id + 'v').textContent = parseFloat($(id).value).toFixed(2);
    customPal = false; // スライダー操作で類似色モードへ戻す
    updatePalette();
  });
});

// ============ 右パネルの開閉 ============
const side = $('side');
function setSide(open) {
  side.classList.toggle('collapsed', !open);
}
$('closeSide').addEventListener('click', () => setGraph(false));

// ============ 下ドックの自動フェード(操作で復帰) ============
const dock = $('dock');
let idleT = null;
function wake() {
  dock.classList.remove('idle');
  clearTimeout(idleT);
  idleT = setTimeout(() => dock.classList.add('idle'), playing ? 2200 : 4000);
}
['pointermove', 'pointerdown', 'wheel', 'touchstart', 'keydown'].forEach(
  (ev) => addEventListener(ev, wake, { passive: true }),
);
dock.addEventListener('pointerenter', () => { dock.classList.remove('idle'); clearTimeout(idleT); });
dock.addEventListener('pointerleave', wake);

// ============ カメラ(手動調整で確定した設定を焼き込み) ============
const LOOK = new THREE.Vector3(0.90, 6.84, -0.02); // 注視点
const CAM_R = 23.22; // xz 周回半径(ズーム)
const CAM_Y = 3.60;  // カメラ高さ
let displayCamR = CAM_R;

// ============ リサイズ & ループ ============
function resize() {
  const w = stage.clientWidth || innerWidth;
  const h = stage.clientHeight || innerHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  drawWeibullGraph();
}
addEventListener('resize', resize);
new ResizeObserver(resize).observe(stage);
resize();

updatePalette();
updateCanopyPalette();
applyPalette('shinryoku');
rebuild();

// URL ハッシュ #y=15 で初期経過年数を指定(検証・ディープリンク用)
const hp = new URLSearchParams(location.hash.slice(1));
if (hp.get('theme')) applyPalette(hp.get('theme'));
const hy = parseFloat(hp.get('y'));
if (!Number.isNaN(hy)) setYear(hy);

wake();

const t0 = performance.now();
let prevNow = t0;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dtSec = Math.min((now - prevNow) / 1000, 0.1);
  prevNow = now;

  if (playing) {
    const y = yearVal + dtSec * 1.1; // 1.1 年/秒
    setYear(y);
    if (y >= YMAX) stopPlay();
  }

  const t = (now - t0) / 1000;
  U.uTime.value = reduced ? t * 0.2 : t;

  if (rotating && !reduced) rotAngle += dtSec * rotSpeed; // 回転速度は可変
  const sway = Math.sin(t * 0.08) * 0.06;
  const targetCamR = graphOpen ? CAM_R * 1.12 : CAM_R;
  displayCamR += (targetCamR - displayCamR) * (1 - Math.exp(-dtSec * 4.5));
  camera.position.x = LOOK.x + Math.sin(rotAngle + sway) * displayCamR;
  camera.position.z = LOOK.z + Math.cos(rotAngle + sway) * displayCamR;
  camera.position.y = CAM_Y + Math.sin(t * 0.11) * 0.4;
  camera.lookAt(LOOK);

  renderer.render(scene, camera);
});
