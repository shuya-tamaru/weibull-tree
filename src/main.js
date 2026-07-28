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

// ============ 樹の構築(シード・数・枝密度・ワイブルから再現可能) ============
let branchLines = null, fruitMesh = null, life = null, N = 0;

function rebuild() {
  const seed = parseInt($('seedIn').value) || 0;
  const count = parseInt($('cntIn').value) || 24000;
  const depth = parseInt($('depthIn').value) || 14;
  const k = parseFloat($('pK').value) || 3.0;
  const eta = parseFloat($('pEta').value) || 21.2;

  const data = buildTreeData(seed, count, { k, eta, depth });

  if (branchLines) { scene.remove(branchLines); branchLines.geometry.dispose(); }
  if (fruitMesh) { scene.remove(fruitMesh); fruitMesh.geometry.dispose(); fruitMesh.dispose(); }

  branchLines = createBranchLines(U, data);
  scene.add(branchLines);
  fruitMesh = createFruitMesh(U, data);
  scene.add(fruitMesh);

  life = data.fruitLife; N = data.N;
  $('totalOut').textContent = N;
  refresh();
}

// ============ 経過年数(スライダーは表示装置、真実は yearVal) ============
let yearVal = 0;
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
  $('aliveOut').textContent = alive;
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
$('szIn').addEventListener('input', (e) => {
  U.uFruitScale.value = parseFloat(e.target.value);
  $('szv').textContent = parseFloat(e.target.value).toFixed(2);
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
  ember: { cTrunk: '#FFEBD6', cTwig: '#B5643C', cYoung: '#FFD27A', cRipe: '#FF9E5E', cMist: '#FFB877' }, // 黄昏(類似色)
  prism: { // 極彩: 桃・橙・翠・碧の四色相
    cTrunk: '#FFFFFF', cTwig: '#7A88C9', cYoung: '#4DA6FF', cRipe: '#FF6FA3', cMist: '#FFC15E',
    pal: ['#FF4D6D', '#FFB03A', '#4DE0A0', '#4DA6FF'],
  },
  neon: { // ネオン: マゼンタ・シアン・ライム・菫
    cTrunk: '#EAF6FF', cTwig: '#2AA6A0', cYoung: '#22E0D8', cRipe: '#FF3DAE', cMist: '#B6FF3D',
    pal: ['#FF3DAE', '#22E0D8', '#B6FF3D', '#9B5CFF'],
  },
  galaxy: { // 銀河: 碧・菫・桃・金
    cTrunk: '#DCE6FF', cTwig: '#4A5CA0', cYoung: '#5AC8FF', cRipe: '#FF6BD6', cMist: '#9B7BFF',
    pal: ['#5AC8FF', '#9B7BFF', '#FF6BD6', '#FFD36B'],
  },
  // --- 季節(多色) ---
  hanami: { // 桜: 淡紅〜白の花びら
    cTrunk: '#FFF3F7', cTwig: '#9C6B7E', cYoung: '#FFC2D6', cRipe: '#FF8FB4', cMist: '#FFD9E4',
    pal: ['#FFB3C9', '#FF7FA8', '#FFE0EC', '#E86B9E'],
  },
  shinryoku: { // 新緑: 若葉のシャルトルーズ〜翠
    cTrunk: '#EAF7DA', cTwig: '#6FA84E', cYoung: '#A6E86B', cRipe: '#4FC96E', cMist: '#C8F0A0',
    pal: ['#9BE870', '#5FCB6A', '#D6E85A', '#3FB58C'],
  },
  // --- 和のパレット(サンプル準拠・類似色) ---
  sakura: { cTrunk: '#D8ECF4', cTwig: '#46759E', cYoung: '#7FD8DE', cRipe: '#F48FB1' }, // 夜桜
  hotaru: { cTrunk: '#CCEBE6', cTwig: '#61A8A8', cYoung: '#73DBCC', cRipe: '#F5B866' }, // 蛍火
  shigyo: { cTrunk: '#E4D9F2', cTwig: '#6E5A9E', cYoung: '#8F86E8', cRipe: '#E070C8' }, // 紫暁
};
function applyPalette(name) {
  const p = PALETTES[name]; if (!p) return;
  Object.entries(COLMAP).forEach(([id, u]) => {
    if (p[id]) { $(id).value = p[id]; U[u].value.set(p[id]); }
  });
  if (p.cMist) { $('cMist').value = p.cMist; U.uMistCol.value.set(p.cMist); }
  if (p.pal) { customPal = true; p.pal.forEach((hex, i) => U.uPal.array[i].set(hex)); }
  else { customPal = false; }
  updatePalette();
  document.querySelectorAll('.pal').forEach((b) => b.classList.toggle('on', b.dataset.p === name));
}
document.querySelectorAll('.pal').forEach((b) => b.addEventListener('click', () => applyPalette(b.dataset.p)));

// ワイブル(値表示 + 再構築)。η はスライダー上限も同期
$('pK').addEventListener('input', () => { $('pKv').textContent = parseFloat($('pK').value).toFixed(2); });
$('pK').addEventListener('change', rebuild);
$('pEta').addEventListener('input', () => {
  const v = parseFloat($('pEta').value);
  $('pEtav').textContent = v.toFixed(1);
  $('yrIn').max = Math.max(YMAX, v * 1.9).toFixed(0);
});
$('pEta').addEventListener('change', rebuild);

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
const handle = $('handle');
function setSide(open) {
  side.classList.toggle('collapsed', !open);
  handle.classList.toggle('show', !open);
}
$('closeSide').addEventListener('click', () => setSide(false));
handle.addEventListener('click', () => setSide(true));

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

// ============ リサイズ & ループ ============
function resize() {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resize); resize();

updatePalette();
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
  camera.position.x = LOOK.x + Math.sin(rotAngle + sway) * CAM_R;
  camera.position.z = LOOK.z + Math.cos(rotAngle + sway) * CAM_R;
  camera.position.y = CAM_Y + Math.sin(t * 0.11) * 0.4;
  camera.lookAt(LOOK);

  renderer.render(scene, camera);
});
