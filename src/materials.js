import * as THREE from 'three';
import {
  LineBasicNodeMaterial, Line2NodeMaterial, SpriteNodeMaterial, MeshBasicNodeMaterial,
} from 'three/webgpu';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import {
  Fn, uniform, uniformArray, attribute, instancedBufferAttribute, positionLocal, uv,
  vec2, vec3, vec4, float, int, mod, cos, sin, exp, pow, mix, smoothstep, clamp,
  max, length, step, If,
} from 'three/tsl';

// ============ 落下パレット定義(熟した灯から HSL で類似 4 色を作る係数) ============
// [色相ずれ, 彩度ずれ, 明度ずれ]。main.js の updatePalette と同一の意匠。
export const PAL_DEFS = [
  [-0.055, 0.00, +0.02],   // 少し赤寄り
  [0.000, 0.05, +0.08],    // 本命を明るく
  [+0.045, -0.05, -0.02],  // 少し黄寄り
  [+0.100, -0.10, -0.06],  // さらに隣へ、落ち着いた一色
];

// ============ 既定色(単体ページ「寿命の樹」の初期値と一致) ============
function defaultColors() {
  const young = new THREE.Color('#2FD8C4');
  const ripe = new THREE.Color('#B4E44E');
  return {
    trunk: new THREE.Color('#FFFFFF'),
    twig: new THREE.Color('#E6EDF1'),
    young,
    ripe,
    mist: new THREE.Color('#B4E44E'),
    canopy: [
      young.clone(),
      young.clone().lerp(ripe, 0.33),
      young.clone().lerp(ripe, 0.66),
      ripe.clone(),
    ],
    pal: [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()],
  };
}

// ============ 色セット生成: 1 本の基調から調和のとれた樹の配色を作る ============
// rand: [0,1) を返す乱数関数(シード付きにすれば決定論的)。
// 森の各テンプレートは互いに色相の違う一式を持つ(=「色々」)。
export function makePalette(rand) {
  const h0 = rand();
  const ripe = new THREE.Color().setHSL(h0, 0.60 + rand() * 0.28, 0.52 + rand() * 0.12);
  const hy = (h0 + (rand() < 0.5 ? -1 : 1) * (0.08 + rand() * 0.20) + 1) % 1;
  const young = new THREE.Color().setHSL(hy, 0.58 + rand() * 0.30, 0.60 + rand() * 0.12);
  const trunk = new THREE.Color().setHSL(h0, 0.14, 0.90 + rand() * 0.06);
  const twig = new THREE.Color().setHSL((h0 + 0.02) % 1, 0.36 + rand() * 0.14, 0.40 + rand() * 0.08);
  const mist = new THREE.Color().setHSL((h0 + 0.03) % 1, 0.48, 0.68);
  const canopy = [0, 0.33, 0.66, 1].map((t) => young.clone().lerp(ripe, t));

  const hsl = { h: 0, s: 0, l: 0 };
  ripe.getHSL(hsl);
  const pal = PAL_DEFS.map((d) => {
    const h = (hsl.h + d[0] * 1.6 + 1) % 1;
    const s = Math.min(0.95, Math.max(0.35, hsl.s + d[1]));
    const l = Math.min(0.80, Math.max(0.30, hsl.l + d[2] * 1.3));
    return new THREE.Color().setHSL(h, s, l);
  });
  return { trunk, twig, young, ripe, mist, canopy, pal };
}

// ============ 全樹で共有する uniform(時間・経過年・落下/霧散のタイミング) ============
export function createGlobalUniforms() {
  return {
    uTime: uniform(0),
    uYear: uniform(0),
    uFruitScale: uniform(0.5),
    uFall: uniform(2.7),
    uMist: uniform(14.65),
    uGroundGlow: uniform(2.0),
    uGroundSpread: uniform(7.5),
  };
}

// ============ 樹ごとに変わる uniform(配色・ワイブル k/η) ============
// colors を渡さなければ「寿命の樹」の既定色。森ではテンプレートごとに makePalette で与える。
export function createTemplateUniforms({ colors, k = 3.0, eta = 21.2 } = {}) {
  const c = colors || defaultColors();
  return {
    uK: uniform(k),
    uEta: uniform(eta),
    uTrunkCol: uniform(c.trunk),
    uTwigCol: uniform(c.twig),
    uYoungCol: uniform(c.young),
    uRipeCol: uniform(c.ripe),
    uMistCol: uniform(c.mist),
    // 木上の灯もテーマに沿った複数色を持つ。
    uCanopyPal: uniformArray(c.canopy || [
      c.young.clone(),
      c.young.clone().lerp(c.ripe, 0.33),
      c.young.clone().lerp(c.ripe, 0.66),
      c.ripe.clone(),
    ], 'color'),
    // 落下の調和パレット: 各果実は aSeed.x で 1 色を選ぶ。
    uPal: uniformArray(c.pal, 'color'),
  };
}

// ============ 共有 uniform(全パラメータ可変・単体ページ互換) ============
// 「寿命の樹」(main.js)はこの 1 束をそのまま使い続ける(グローバル＋テンプレを合体)。
export function createUniforms() {
  return { ...createGlobalUniforms(), ...createTemplateUniforms() };
}

// ============ 枝マテリアル(幹→枝先グラデーション+呼吸) ============
// G: グローバル uniform(uTime), T: テンプレ uniform(uTrunkCol/uTwigCol)。
export function createBranchMaterial(G, T = G) {
  const m = new LineBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const vW = attribute('aW', 'float');
  const vY = positionLocal.y;
  const breathe = float(0.88).add(float(0.12).mul(sin(G.uTime.mul(0.45).add(vY.mul(0.4)))));
  m.colorNode = mix(T.uTrunkCol, T.uTwigCol, smoothstep(0.1, 0.9, vW)).mul(breathe);
  m.opacityNode = mix(float(0.95), float(0.40), smoothstep(0.1, 0.95, vW));
  return m;
}

// ============ 果実マテリアル(=設備機器の劣化アニメを内包) ============
// 各果実に Weibull 寿命 aLife を持たせ、経過年数 uYear で
//   若い灯 → 熟した灯 → 深紅 → 落下(調和パレット色) → 霧散
// と遷移する。per-instance データ(aLife/aSeed/aPos)はこのマテリアルのノードに埋め込まれる。
// → 同じマテリアルを参照する InstancedMesh を position 違いで複数置けば、同じ樹を各所に描ける。
export function createFruitMaterial(G, T, data) {
  const { fruitPos, fruitLife, fruitSeed } = data;

  // NOTE: three r185 の instancedBufferAttribute(rawArray) は scalar/vecN で
  // setInstanced(true) を呼ばず per-vertex 属性になる。InstancedBufferAttribute を渡す。
  const aLife = instancedBufferAttribute(new THREE.InstancedBufferAttribute(fruitLife, 1), 'float');
  const aSeed = instancedBufferAttribute(new THREE.InstancedBufferAttribute(fruitSeed, 2), 'vec2');
  const aPos = instancedBufferAttribute(new THREE.InstancedBufferAttribute(fruitPos, 3), 'vec3');

  // 熟成に伴う on-tree の色(基調色由来)
  const ripenColor = Fn(([ripen]) => {
    const crimson = mix(T.uRipeCol, vec3(1.0, 0.32, 0.24), 0.65);
    const canopyIdx = int(mod(aSeed.x.mul(4.0), 4.0));
    const ageColor = mix(T.uYoungCol, T.uRipeCol, smoothstep(0.35, 0.8, ripen));
    const col = mix(ageColor, T.uCanopyPal.element(canopyIdx), 0.58).toVar();
    col.assign(mix(col, crimson, smoothstep(0.85, 1.0, ripen)));
    return col;
  });

  // 頂点: 位置(落下変位)とスケールを構築
  const vertPack = Fn(() => {
    const Tl = aLife;
    const remain = clamp(G.uYear.sub(Tl).negate().div(Tl), 0.0, 1.0);
    const ripen = remain.oneMinus();

    const p = aPos.toVar();
    const mist = float(0.0).toVar();
    const sizeMul = float(0.84).toVar();

    If(G.uYear.greaterThanEqual(Tl), () => {
      const s = G.uYear.sub(Tl).div(G.uFall);
      If(s.lessThan(1.0), () => {
        const e = s.mul(s);
        p.y.assign(mix(aPos.y, 0.15, e));
        p.x.addAssign(sin(s.mul(6.0).add(aSeed.x.mul(20.0))).mul(0.25).mul(s));
        p.z.addAssign(cos(s.mul(5.0).add(aSeed.y.mul(20.0))).mul(0.25).mul(s));
        sizeMul.assign(0.50);
      }).Else(() => {
        const mm = G.uYear.sub(Tl).sub(G.uFall).div(G.uMist);
        If(mm.lessThan(1.0), () => {
          mist.assign(mm);
          p.y.assign(float(0.15).add(mm.mul(1.6).mul(float(0.4).add(aSeed.y))));
          p.x.addAssign(aSeed.x.sub(0.5).mul(mm).mul(2.6));
          p.z.addAssign(aSeed.y.sub(0.5).mul(mm).mul(2.6));
          sizeMul.assign(0.55);
        }).Else(() => {
          mist.assign(1.0);
        });
      });
    });

    const base = float(0.30).mul(float(1.0).add(aSeed.y.mul(0.45)))
      .mul(float(1.0).add(smoothstep(0.6, 1.0, ripen).mul(0.30)));
    const scaleV = base.mul(float(1.0).add(mist.mul(1.1))).mul(sizeMul).mul(G.uFruitScale);
    return vec4(p, scaleV);
  });

  // フラグメント: 色とアルファ(グロー形状)を vec4(col.rgb, alpha) に詰める
  const stateFrag = Fn(() => {
    const Tl = aLife;
    const remain = clamp(G.uYear.sub(Tl).negate().div(Tl), 0.0, 1.0);
    const ripen = remain.oneMinus();

    const lam = pow(max(G.uYear.div(T.uEta), 0.02), T.uK.sub(1.0));
    const tw = float(0.72).add(float(0.28).mul(sin(G.uTime.mul(float(0.8).add(lam.mul(2.2))).add(aSeed.x.mul(30.0)))));

    const col = ripenColor(ripen).toVar();
    const glow = mix(float(0.45), float(1.0), smoothstep(0.5, 1.0, ripen)).mul(tw).toVar();
    const mist = float(0.0).toVar();

    If(G.uYear.greaterThanEqual(Tl), () => {
      const s = G.uYear.sub(Tl).div(G.uFall);
      If(s.lessThan(1.0), () => {
        glow.assign(0.9);
        // 落下: 調和パレットの 1 色へ(果実ごとに seed で選択)
        const idx = int(mod(aSeed.x.mul(4.0), 4.0));
        col.assign(mix(col, T.uPal.element(idx), s.mul(0.75)));
      }).Else(() => {
        const mm = G.uYear.sub(Tl).sub(G.uFall).div(G.uMist);
        If(mm.lessThan(1.0), () => {
          mist.assign(mm);
          glow.assign(mm.oneMinus().mul(0.7));
          // 霧も果実ごとの調和色を保ち、消える際にミスト色へ
          const midx = int(mod(aSeed.x.mul(4.0), 4.0));
          col.assign(mix(T.uPal.element(midx), T.uMistCol, smoothstep(0.15, 1.0, mm)));
        }).Else(() => {
          glow.assign(0.0); mist.assign(1.0);
        });
      });
    });

    // 点スプライトの柔らかいグロー(core + halo)
    const q = uv().sub(0.5);
    const d2 = length(q).mul(length(q));
    const core = exp(d2.mul(-34.0));
    const halo = exp(d2.mul(-6.5)).mul(0.45);
    const a = core.add(halo).mul(glow).toVar();
    a.mulAssign(mix(float(1.0), exp(d2.mul(-3.0)).mul(0.8), mist));
    a.mulAssign(step(0.001, glow)); // 消灯した果実は描かない

    return vec4(col, a);
  });

  const packed = vertPack();
  const frag = stateFrag();

  const material = new SpriteNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  material.positionNode = packed.xyz;
  material.scaleNode = vec2(packed.w);
  material.colorNode = frag.xyz;
  material.opacityNode = frag.w;
  return material;
}

// ============ 果実 InstancedMesh を組む(instanceMatrix は単位) ============
// capacity を指定すると max 容量で確保(森のプールが count を切り替えて使い回す)。
export function buildFruitMesh(material, N, capacity = N) {
  const geo = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.InstancedMesh(geo, material, capacity);
  const I = new THREE.Matrix4();
  for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, I);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.count = N;
  mesh.frustumCulled = false;
  return mesh;
}

// ============ 果実メッシュ(単体ページ互換ラッパー) ============
export function createFruitMesh(U, data) {
  return buildFruitMesh(createFruitMaterial(U, U, data), data.N);
}

// ============ 枝ジオメトリ ============
export function createBranchGeometry(data) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.branchPositions, 3));
  g.setAttribute('aW', new THREE.BufferAttribute(data.branchW, 1));
  return g;
}

// ============ 枝の太線 LineSegments(単体ページ用ラッパー) ============
// LineBasicMaterial の線幅は多くの環境で 1px 固定になるため、画面空間で
// 太さを持つ LineSegments2 を使う。森側は従来の軽量な枝描画を維持する。
export function createBranchLines(U, data, width = 1.8) {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(data.branchPositions);

  const segmentW = new Float32Array(data.branchW.length / 2);
  for (let i = 0; i < segmentW.length; i++) {
    segmentW[i] = (data.branchW[i * 2] + data.branchW[i * 2 + 1]) * 0.5;
  }
  geometry.setAttribute('instanceW', new THREE.InstancedBufferAttribute(segmentW, 1));

  const material = new Line2NodeMaterial({
    linewidth: width, transparent: true, depthWrite: false,
  });
  const w = attribute('instanceW', 'float');
  const breathe = float(0.90).add(float(0.10).mul(sin(U.uTime.mul(0.45))));
  material.colorNode = mix(U.uTrunkCol, U.uTwigCol, smoothstep(0.1, 0.9, w)).mul(breathe);
  material.opacityNode = mix(float(0.92), float(0.48), smoothstep(0.1, 0.95, w));

  return new LineSegments2(geometry, material);
}

// ============ 地面の残光 ============
export function createGround(U, size = 90) {
  const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const r = length(uv().sub(0.5));
  const ring = exp(r.mul(U.uGroundSpread.negate()));
  const core = exp(r.mul(U.uGroundSpread.mul(-2.4)));
  const breathe = float(0.88).add(float(0.12).mul(sin(U.uTime.mul(0.3))));
  m.colorNode = vec3(0.10, 0.17, 0.16).mul(ring)
    .add(vec3(0.34, 0.31, 0.19).mul(core).mul(0.42))
    .mul(breathe);
  m.opacityNode = ring.mul(0.62).mul(U.uGroundGlow);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), m);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}
