import * as THREE from 'three';
import { WebGPURenderer, PostProcessing } from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createGlobalUniforms, createGround } from './materials.js';
import { buildTemplateLibrary, PoolManager } from './field.js';

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
scene.fog = new THREE.FogExp2(0x05080F, 0.020); // 遠景をフェードさせ奥へ続く印象
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 300);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ============ 全樹共有 uniform・地面・テンプレ・プール ============
const G = createGlobalUniforms();
G.uFruitScale.value = 0.5; // 灯を大きめに(Bloom と合わせてしっかり光らせる)
const ground = createGround(G, 150);
scene.add(ground);

const templates = buildTemplateLibrary(G, 16);
// 建物が Grid 状に建つイメージ: 小さな木を格子にきっちり整列(jitter 0)し、密に並べる。
const pool = new PoolManager(scene, templates, { spacing: 6, radius: 7, jitter: 0 });

// ============ カメラ操作(OrbitControls・当面は自由に見回す) ============
const CAM_OFF = new THREE.Vector3(20, 24, 20); // 初期の右斜め上
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 3, 0);        // 木の中ほどを注視
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49; // 地面より下に潜らない
camera.position.copy(controls.target).add(CAM_OFF);
controls.update();
controls.addEventListener('start', () => $('hint').classList.add('gone'));

// ============ ポストプロセス(Bloom で灯を強く発光) ============
const scenePass = pass(scene, camera);
const scenePassColor = scenePass.getTextureNode();
const bloomPass = bloom(scenePassColor, 0.9, 0.35, 0.0); // strength, radius, threshold
const post = new PostProcessing(renderer);
post.outputNode = scenePassColor.add(bloomPass);

// ============ 経過年数(スライダーは表示、真実は yearVal) ============
let yearVal = 0;
function setYear(v) {
  yearVal = Math.max(0, Math.min(YMAX, v));
  G.uYear.value = yearVal;
  $('yrIn').value = yearVal;
  $('yrOut').textContent = yearVal.toFixed(1);
}

const playBtn = $('play');
let playing = true;
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

// ============ 下ドックの自動フェード(操作で復帰) ============
const dock = $('dock');
let idleT = null;
function wake() {
  dock.classList.remove('idle');
  clearTimeout(idleT);
  idleT = setTimeout(() => dock.classList.add('idle'), playing ? 2600 : 4200);
}
['pointermove', 'pointerdown', 'wheel', 'touchstart', 'keydown'].forEach(
  (ev) => addEventListener(ev, wake, { passive: true }),
);
dock.addEventListener('pointerenter', () => { dock.classList.remove('idle'); clearTimeout(idleT); });
dock.addEventListener('pointerleave', wake);

// ============ リサイズ ============
function resize() {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resize); resize();

// ============ ウォームアップ(全テンプレを一度描画してシェーダを事前コンパイル) ============
pool.warmup();
renderer.render(scene, camera);
pool.cooldown();
pool.update(controls.target); // 初期可視セルを配置

setYear(0);
wake();

// ============ ループ ============
const t0 = performance.now();
let prevNow = t0;
renderer.setAnimationLoop(async () => {
  const now = performance.now();
  const dtSec = Math.min((now - prevNow) / 1000, 0.1);
  prevNow = now;

  // 共通タイムライン(全樹で 1 つの uYear が進む)
  if (playing && !reduced) {
    const y = yearVal + dtSec * 1.1; // 1.1 年/秒
    setYear(y);
    if (y >= YMAX) stopPlay();
  }

  const t = (now - t0) / 1000;
  G.uTime.value = reduced ? t * 0.2 : t;

  controls.update();

  // 可視セルの更新(セル境界を跨いだフレームだけ実行)と地面追従
  pool.update(controls.target);
  ground.position.set(Math.round(controls.target.x), 0, Math.round(controls.target.z));

  await post.renderAsync();
});
