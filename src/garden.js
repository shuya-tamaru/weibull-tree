import * as THREE from 'three';
import { WebGPURenderer, PostProcessing } from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';
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
scene.fog = new THREE.FogExp2(0x05080F, 0.039); // 遠景をフェードさせ奥へ続く印象
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 300);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ============ 全樹共有 uniform・地面・テンプレ・プール ============
// 森の既定パラメータ(デバッグ UI で調節して決めた値をここへ焼き込む)。
// createGlobalUniforms 自体は index.html と共有なので、森側の値はここで明示する。
const G = createGlobalUniforms();
G.uFruitScale.value = 0.36;   // 灯は小さめ・引き締めて光の玉に
G.uFallScale.value = 1.0;     // 落下時間の全体倍率(実落下は木ごとの uFall × これ)
G.uMist.value = 26.55;        // 霧散(年)
G.uGroundGlow.value = 2.0;
G.uGroundSpread.value = 7.5;
const ground = createGround(G, 150);
scene.add(ground);

const branchWidth = 2.0; // 枝の太さ(screen space・デバッグ UI で可変)
const templates = buildTemplateLibrary(G, 16, branchWidth);
// 建物が Grid 状に建つイメージ: 小さな木を密な格子に並べ、セル内で少し散らす。
// デバッグ UI で上書きできるよう、初期値は 1 箇所にまとめる。
const layout = { spacing: 2, radius: 9, jitter: 0.99 };
let pool = new PoolManager(scene, templates, { ...layout });

// ============ カメラ操作(ドラッグでパンのみ・地面に沿って無限スクロール) ============
// 手動で決めた画を初期位置に焼き込み。pos−target の相対を保ったまま XZ 平面を平行移動する。
// 回転・ズームは無効。screenSpacePanning=false で「地面を掴んで引く」パンになる。
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(6.81, -2.95, 2.87);
camera.position.set(20.33, 11.55, 5.03);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enableRotate = false;
controls.enableZoom = false;
controls.screenSpacePanning = false; // 地面(XZ)に沿ってパン=無限スクロール
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
controls.touches = { ONE: THREE.TOUCH.PAN };
controls.update();
controls.addEventListener('start', () => { $('hint').classList.add('gone'); stage.classList.add('dragging'); });
controls.addEventListener('end', () => stage.classList.remove('dragging'));

// ---- 視点の傾き(斜め ⇄ ほぼ真上)。方位角・距離は固定、polar 角だけ補間で変える ----
const _camOff = new THREE.Vector3();
const camSph = new THREE.Spherical().setFromVector3(
  _camOff.copy(camera.position).sub(controls.target),
); // radius / phi(polar) / theta(azimuth) を保持。以後は phi だけ動かす。
const PHI_OBLIQUE = camSph.phi; // 焼き込んだ斜め
const PHI_TOP = 0.05;           // ほぼ真上(完全な真上は向きが不定になるので極小の傾きを残す)
let phiTarget = PHI_OBLIQUE;
let phiCur = PHI_OBLIQUE;
function setTopView(on) { phiTarget = on ? PHI_TOP : PHI_OBLIQUE; }
function toggleTopView() { setTopView(Math.abs(phiTarget - PHI_TOP) > 1e-3); }
addEventListener('keydown', (e) => {
  if (e.key === 't' && e.target.tagName !== 'INPUT') toggleTopView();
});

// ============ ポストプロセス(Bloom で灯を強く発光) ============
const scenePass = pass(scene, camera);
const scenePassColor = scenePass.getTextureNode();
const bloomPass = bloom(scenePassColor, 0.0, 0.0, 0.0); // strength, radius, threshold(既定は off・キリッと)
const post = new PostProcessing(renderer);
post.outputNode = scenePassColor.add(bloomPass);

// ============ 経過年数(スライダーは表示、真実は yearVal) ============
let yearVal = 0;
let yearSpeed = 1.1; // 年/秒(デバッグ UI で可変)
let refreshCam = null; // デバッグ UI: カメラ位置ライブ表示の更新フック
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

// ============ デバッグ UI(lil-gui) ============
// 見た目の調節用。値は localStorage に保存し、リロードしても保持する。
//   ・グリッド間隔 / 散り は即再配置、可視半径はプールを作り直す。
//   ・g キーでパネルの表示 / 非表示を切替。
{
  const LS_KEY = 'grove-debug';
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } })();

  const P = {
    spacing: layout.spacing,
    jitter: layout.jitter,
    radius: layout.radius,
    branchWidth,
    fog: scene.fog.density,
    fruitScale: G.uFruitScale.value,
    fallScale: G.uFallScale.value,
    mist: G.uMist.value,
    groundGlow: G.uGroundGlow.value,
    groundSpread: G.uGroundSpread.value,
    bloomStrength: bloomPass.strength.value,
    bloomRadius: bloomPass.radius.value,
    bloomThreshold: bloomPass.threshold.value,
    yearSpeed,
    ...saved, // 保存済みの値で上書き
  };
  const save = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(P)); } catch { /* 無視 */ } };

  // 枝の太さ(全テンプレのマテリアルへ即時反映)
  const applyBranchWidth = () => {
    for (const tmpl of templates) tmpl.branchMat.linewidth = P.branchWidth;
  };

  // uniform 系(即時反映・再構築不要)を現在値へ
  const applyUniforms = () => {
    scene.fog.density = P.fog;
    G.uFruitScale.value = P.fruitScale;
    G.uFallScale.value = P.fallScale;
    G.uMist.value = P.mist;
    G.uGroundGlow.value = P.groundGlow;
    G.uGroundSpread.value = P.groundSpread;
    bloomPass.strength.value = P.bloomStrength;
    bloomPass.radius.value = P.bloomRadius;
    bloomPass.threshold.value = P.bloomThreshold;
    yearSpeed = P.yearSpeed;
  };
  applyUniforms();
  applyBranchWidth();

  // spacing / jitter を反映して全セル再配置
  const relayoutGrid = () => {
    pool.S = P.spacing;
    pool.jitter = P.jitter;
    pool.relayout(controls.target);
  };
  relayoutGrid();

  // radius(=可視範囲=スロット数)はプールごと作り直す
  const rebuildPool = () => {
    pool.dispose();
    pool = new PoolManager(scene, templates, { spacing: P.spacing, radius: P.radius, jitter: P.jitter });
    pool.update(controls.target);
  };
  if (P.radius !== layout.radius) rebuildPool();

  const gui = new GUI({ title: '設備の森 — Debug (g で開閉)' });

  // ---- カメラ位置決め(自由に見回して「ここ」を決め、コピーして焼き込む)----
  const fCam = gui.addFolder('カメラ (位置決め)');
  const cam = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, dist: 0 };
  fCam.add(cam, 'x').name('pos x').listen().disable();
  fCam.add(cam, 'y').name('pos y').listen().disable();
  fCam.add(cam, 'z').name('pos z').listen().disable();
  fCam.add(cam, 'tx').name('注視 x').listen().disable();
  fCam.add(cam, 'ty').name('注視 y').listen().disable();
  fCam.add(cam, 'tz').name('注視 z').listen().disable();
  fCam.add(cam, 'dist').name('距離').listen().disable();
  refreshCam = () => {
    const p = camera.position; const t = controls.target;
    cam.x = +p.x.toFixed(2); cam.y = +p.y.toFixed(2); cam.z = +p.z.toFixed(2);
    cam.tx = +t.x.toFixed(2); cam.ty = +t.y.toFixed(2); cam.tz = +t.z.toFixed(2);
    cam.dist = +p.distanceTo(t).toFixed(2);
  };
  fCam.add({
    copy: () => {
      const p = camera.position; const t = controls.target;
      const txt =
        `camera.position.set(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)});\n` +
        `controls.target.set(${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)});`;
      console.log('[camera]\n' + txt);
      try { navigator.clipboard.writeText(txt); } catch { /* 非対応環境は console のみ */ }
    },
  }, 'copy').name('この位置をコピー');
  fCam.add({ topView: () => toggleTopView() }, 'topView').name('斜め ⇄ 真上 (t)');

  const fGrid = gui.addFolder('グリッド');
  fGrid.add(P, 'spacing', 2, 20, 0.5).name('間隔').onChange(() => { relayoutGrid(); save(); });
  fGrid.add(P, 'jitter', 0, 1, 0.01).name('散り(jitter)').onChange(() => { relayoutGrid(); save(); });
  fGrid.add(P, 'radius', 2, 12, 1).name('可視半径').onFinishChange(() => { rebuildPool(); save(); });
  fGrid.add(P, 'branchWidth', 0.5, 6, 0.1).name('枝の太さ').onChange(() => { applyBranchWidth(); save(); });
  fGrid.add(P, 'fog', 0, 0.06, 0.001).name('霧の濃さ').onChange((v) => { scene.fog.density = v; save(); });

  const fTree = gui.addFolder('灯・地面');
  fTree.add(P, 'fruitScale', 0.1, 1.5, 0.01).name('灯の大きさ').onChange((v) => { G.uFruitScale.value = v; save(); });
  fTree.add(P, 'fallScale', 0.2, 3, 0.05).name('落下時間×(木ごと乱数)').onChange((v) => { G.uFallScale.value = v; save(); });
  fTree.add(P, 'mist', 2, 30, 0.05).name('霧散(年)').onChange((v) => { G.uMist.value = v; save(); });
  fTree.add(P, 'groundGlow', 0, 5, 0.05).name('地面の輝き').onChange((v) => { G.uGroundGlow.value = v; save(); });
  fTree.add(P, 'groundSpread', 2, 15, 0.1).name('地面の広がり').onChange((v) => { G.uGroundSpread.value = v; save(); });

  const fPost = gui.addFolder('Bloom');
  fPost.add(P, 'bloomStrength', 0, 2, 0.01).name('強さ').onChange((v) => { bloomPass.strength.value = v; save(); });
  fPost.add(P, 'bloomRadius', 0, 1, 0.01).name('半径').onChange((v) => { bloomPass.radius.value = v; save(); });
  fPost.add(P, 'bloomThreshold', 0, 1, 0.01).name('閾値').onChange((v) => { bloomPass.threshold.value = v; save(); });

  gui.add(P, 'yearSpeed', 0, 4, 0.05).name('時間(年/秒)').onChange((v) => { yearSpeed = v; save(); });
  gui.add({ reset: () => { try { localStorage.removeItem(LS_KEY); } catch { /* 無視 */ } location.reload(); } }, 'reset').name('初期化してリロード');

  let hidden = false;
  addEventListener('keydown', (e) => {
    if (e.key === 'g' && e.target.tagName !== 'INPUT') { hidden = !hidden; gui.show(!hidden); }
  });
}

// ============ ループ ============
const t0 = performance.now();
let prevNow = t0;
renderer.setAnimationLoop(async () => {
  const now = performance.now();
  const dtSec = Math.min((now - prevNow) / 1000, 0.1);
  prevNow = now;

  // 共通タイムライン(全樹で 1 つの uYear が進む)
  if (playing && !reduced) {
    const y = yearVal + dtSec * yearSpeed; // 既定 1.1 年/秒(デバッグ UI で可変)
    setYear(y);
    if (y >= YMAX) stopPlay();
  }

  const t = (now - t0) / 1000;
  G.uTime.value = reduced ? t * 0.2 : t;

  // 視点の傾きを補間(斜め ⇄ 真上)。位置を上書きしてから update に拾わせる。
  if (Math.abs(phiCur - phiTarget) > 1e-4) {
    phiCur += (phiTarget - phiCur) * (1 - Math.exp(-dtSec * 6));
    camSph.phi = phiCur;
    camera.position.copy(controls.target).add(_camOff.setFromSpherical(camSph));
  }

  controls.update();
  if (refreshCam) refreshCam();

  // 可視セルの更新(セル境界を跨いだフレームだけ実行)と地面追従
  pool.update(controls.target);
  ground.position.set(Math.round(controls.target.x), 0, Math.round(controls.target.z));

  await post.renderAsync();
});
