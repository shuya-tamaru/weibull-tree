import * as THREE from 'three';
import { buildTreeData, mulberry32 } from './tree.js';
import {
  createTemplateUniforms, createFruitMaterial, createBranchMaterial,
  createBranchGeometry, buildFruitMesh, makePalette,
} from './materials.js';

// ============ 森用の小さな樹形(幹を低く・こんもり。建物のように各区画に建つ) ============
// DEFAULT_TREE(単体ページ用の大きい樹)は使わず、幹丈を詰めた小型パラメータを渡す。
const SMALL_TREE = {
  branchAngle: 52 * Math.PI / 180,
  angleVar: 22 * Math.PI / 180,
  upwardBias: 0.26,
  radialSpread: 0.32,
  primaryLen: 0.92,
  lenDecay: 0.72,
  trunkLen: 0.28,   // 幹の高さはほぼ無し
  apical: 0.42,
  depth: 10,
};

// ============ テンプレート・ライブラリ ============
// 起動時に ~N 種の樹を一度だけ構築する。各テンプレは
//   ・固有の樹形(seed)     ・固有の灯数(数百〜約1800、可変で少なめ)
//   ・固有の配色(makePalette) ・固有のワイブル k/η(劣化速度が違う)
// を持ち、無限ラティスのセルへ配置・使い回される。
// per-instance データはマテリアルのノードに埋まっているので、同じ material を
// 参照する InstancedMesh を position 違いで何本でも置ける(=1テンプレ=1本分の灯群)。
export function buildTemplateLibrary(G, numTemplates = 16) {
  const templates = [];
  for (let t = 0; t < numTemplates; t++) {
    const rand = mulberry32(9000 + t * 131);
    const seed = 1000 + t * 97;
    const count = Math.round(120 + rand() * 480);     // ~120..600 灯(小さい木ぶん控えめ)
    const eta = 6 + rand() * 28;                      // 劣化尺度 η: 6..34 年
    const k = 1.3 + rand() * 3.2;                     // 形状 k: 1.3..4.5
    const depth = 9 + Math.floor(rand() * 3);         // 枝密度 9..11
    const data = buildTreeData(seed, count, { k, eta, depth, tree: SMALL_TREE });
    const colors = makePalette(rand);
    const T = createTemplateUniforms({ colors, k, eta });
    templates.push({
      fruitMat: createFruitMaterial(G, T, data),
      branchMat: createBranchMaterial(G, T),
      branchGeo: createBranchGeometry(data),
      N: data.N,
    });
  }
  return templates;
}

// ============ セル → 決定論的な内容(同じ場所は常に同じ樹) ============
export function cellHash(i, j, numTemplates) {
  const rand = mulberry32((((i * 73856093) ^ (j * 19349663)) >>> 0) + 2654435761);
  return {
    t: Math.floor(rand() * numTemplates),
    yaw: Math.floor(rand() * 4) * (Math.PI / 2), // 90°刻みで見た目に変化
    jx: rand() - 0.5,                            // セル内の散り(-0.5..0.5)
    jz: rand() - 0.5,
  };
}

// ============ プール: 可視範囲のスロットを使い回して無限を描く ============
// スロット総数 = (2R+1)^2 = 可視セル数。unmount → mount の順で回すので
// 空きスロットが枯れることはない(evict 不要)。dispose はページ破棄時のみ。
export class PoolManager {
  constructor(scene, templates, { spacing = 18, radius = 5, jitter = 0 } = {}) {
    this.templates = templates;
    this.S = spacing;
    this.R = radius;
    this.jitter = jitter * spacing;
    this.MAX_N = Math.max(...templates.map((t) => t.N));
    this.mounted = new Map();
    this.free = [];
    this.slots = [];
    this.ci = null;
    this.cj = null;

    const POOL = (2 * radius + 1) * (2 * radius + 1);
    const t0 = templates[0];
    for (let n = 0; n < POOL; n++) {
      const fruit = buildFruitMesh(t0.fruitMat, t0.N, this.MAX_N);
      fruit.visible = false;
      const branch = new THREE.LineSegments(t0.branchGeo, t0.branchMat);
      branch.frustumCulled = false;
      branch.visible = false;
      scene.add(fruit);
      scene.add(branch);
      const slot = { fruit, branch, key: null, i: 0, j: 0 };
      this.slots.push(slot);
      this.free.push(slot);
    }
  }

  key(i, j) { return i * 100000 + j; }

  mount(i, j, slot) {
    const c = cellHash(i, j, this.templates.length);
    const tmpl = this.templates[c.t];
    const x = i * this.S + c.jx * this.jitter;
    const z = j * this.S + c.jz * this.jitter;

    slot.fruit.material = tmpl.fruitMat;   // 共有マテリアル(clone しない)
    slot.fruit.count = tmpl.N;             // 描画本数だけ切替(再確保なし)
    slot.fruit.position.set(x, 0, z);
    slot.fruit.rotation.y = c.yaw;
    slot.fruit.visible = true;

    slot.branch.geometry = tmpl.branchGeo;
    slot.branch.material = tmpl.branchMat;
    slot.branch.position.set(x, 0, z);
    slot.branch.rotation.y = c.yaw;
    slot.branch.visible = true;

    slot.key = this.key(i, j);
    slot.i = i;
    slot.j = j;
    this.mounted.set(slot.key, slot);
  }

  unmount(slot) {
    slot.fruit.visible = false;
    slot.branch.visible = false;
    this.mounted.delete(slot.key);
    slot.key = null;
    this.free.push(slot);
  }

  // target(地面上の注視点)が別セルに移ったときだけ paging する。
  update(target) {
    const ci = Math.round(target.x / this.S);
    const cj = Math.round(target.z / this.S);
    if (ci === this.ci && cj === this.cj) return;
    this.ci = ci;
    this.cj = cj;
    const R = this.R;

    for (const slot of this.mounted.values()) {
      if (Math.abs(slot.i - ci) > R || Math.abs(slot.j - cj) > R) this.unmount(slot);
    }
    for (let di = -R; di <= R; di++) {
      for (let dj = -R; dj <= R; dj++) {
        const i = ci + di;
        const j = cj + dj;
        if (this.mounted.has(this.key(i, j))) continue;
        const slot = this.free.pop();
        if (!slot) continue;
        this.mount(i, j, slot);
      }
    }
  }

  // 起動時: 全テンプレのマテリアルを一度コンパイルさせる(初出現時のカクつき防止)。
  warmup() {
    const n = Math.min(this.templates.length, this.slots.length);
    for (let t = 0; t < n; t++) {
      const s = this.slots[t];
      const tmpl = this.templates[t];
      s.fruit.material = tmpl.fruitMat;
      s.fruit.count = tmpl.N;
      s.fruit.position.set(0, -1000, 0);
      s.fruit.visible = true;
      s.branch.geometry = tmpl.branchGeo;
      s.branch.material = tmpl.branchMat;
      s.branch.position.set(0, -1000, 0);
      s.branch.visible = true;
    }
  }

  cooldown() {
    for (const s of this.slots) {
      s.fruit.visible = false;
      s.branch.visible = false;
    }
  }
}
