import * as THREE from 'three';

// ============ シード付き乱数(樹形に番号を) ============
export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ============ 樹形パラメータ(発注仕様) ============
export const DEFAULT_TREE = {
  branchAngle: 55 * Math.PI / 180, angleVar: 20 * Math.PI / 180,
  upwardBias: 0.3, radialSpread: 0.25,
  primaryLen: 1.4 * 2.3, lenDecay: 0.76, trunkLen: 0.75 * 2.3,
  apical: 0.35, depth: 12,
};

const UP = new THREE.Vector3(0, 1, 0);

/**
 * L-system 風の再帰で樹を構築し、枝線分と果実(=設備)の座席・寿命を返す。
 * 果実の寿命は Weibull 分布 life = eta * (-ln(1-u))^(1/k) で与える。
 * すべて seed から再現可能。
 *
 * @returns {{
 *   branchPositions: Float32Array, branchW: Float32Array,
 *   fruitPos: Float32Array, fruitLife: Float32Array, fruitSeed: Float32Array,
 *   N: number
 * }}
 */
export function buildTreeData(seed, count, { k = 3.0, eta = 21.2, depth = 12, tree = DEFAULT_TREE } = {}) {
  const P = { ...tree, depth: Math.max(9, Math.min(14, depth | 0)) };
  const rand = mulberry32(seed);
  const branchPts = [], branchW = [], tips = [], twigs = [];

  (function grow(p, dir, len, depth) {
    if (depth <= 0 || len < 0.22) { tips.push(p.clone()); return; }
    const w0 = 1 - depth / P.depth, w1 = 1 - (depth - 1) / P.depth;
    const nxt = p.clone().addScaledVector(dir, len);
    branchPts.push(p.x, p.y, p.z, nxt.x, nxt.y, nxt.z);
    branchW.push(w0, w1);
    if (w1 > 0.62) twigs.push([p.x, p.y, p.z, nxt.x, nxt.y, nxt.z]); // 細枝は果実の座席候補
    for (let i = 0; i < 2; i++) {
      const isMain = (i === 0);
      const ang = (P.branchAngle + (rand() * 2 - 1) * P.angleVar) * (isMain ? P.apical : 1.0);
      const az = rand() * Math.PI * 2;
      const ortho1 = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) < 0.95 ? UP : new THREE.Vector3(1, 0, 0)).normalize();
      const ortho2 = new THREE.Vector3().crossVectors(dir, ortho1).normalize();
      const lateral = ortho1.clone().multiplyScalar(Math.cos(az)).addScaledVector(ortho2, Math.sin(az));
      let nd = dir.clone().multiplyScalar(Math.cos(ang)).addScaledVector(lateral, Math.sin(ang));
      nd.addScaledVector(UP, P.upwardBias * 0.35);
      const radial = new THREE.Vector3(nxt.x, 0, nxt.z);
      if (radial.lengthSq() > 1e-4) nd.addScaledVector(radial.normalize(), P.radialSpread * 0.5);
      nd.normalize();
      const nextLen = (depth === P.depth) ? P.primaryLen * (0.9 + rand() * 0.2) : len * (P.lenDecay + rand() * 0.05);
      grow(nxt, nd, nextLen, depth - 1);
    }
  })(new THREE.Vector3(0, 0, 0), UP, P.trunkLen, P.depth);

  const N = Math.max(100, Math.min(60000, count | 0));
  const fruitPos = new Float32Array(N * 3);
  const fruitLife = new Float32Array(N);
  const fruitSeed = new Float32Array(N * 2);
  const J = 0.16; // 細枝まわりの散り

  for (let i = 0; i < N; i++) {
    let x, y, z;
    if (i < tips.length) {                       // まず全ての枝先に一灯ずつ
      x = tips[i].x; y = tips[i].y; z = tips[i].z;
    } else {                                      // 残りは細枝の上にたわわに
      const s = twigs.length ? twigs[(rand() * twigs.length) | 0] : [0, 0, 0, 0, 1, 0];
      const t = rand();
      x = s[0] + (s[3] - s[0]) * t + (rand() - .5) * J;
      y = s[1] + (s[4] - s[1]) * t + (rand() - .5) * J;
      z = s[2] + (s[5] - s[2]) * t + (rand() - .5) * J;
    }
    const u = Math.min(.9995, Math.max(.0005, rand()));
    fruitLife[i] = eta * Math.pow(-Math.log(1 - u), 1 / k);
    fruitPos[i * 3] = x; fruitPos[i * 3 + 1] = y; fruitPos[i * 3 + 2] = z;
    fruitSeed[i * 2] = rand(); fruitSeed[i * 2 + 1] = rand();
  }

  return {
    branchPositions: new Float32Array(branchPts),
    branchW: new Float32Array(branchW),
    fruitPos, fruitLife, fruitSeed, N,
  };
}
