import * as THREE from 'three';
import {
  LineBasicNodeMaterial, SpriteNodeMaterial, MeshBasicNodeMaterial,
} from 'three/webgpu';
import {
  Fn, uniform, uniformArray, attribute, instancedBufferAttribute, positionLocal, uv,
  vec2, vec3, vec4, float, int, mod, cos, sin, exp, pow, mix, smoothstep, clamp,
  max, length, step, If,
} from 'three/tsl';

// ============ 共有 uniform(全パラメータ可変) ============
export function createUniforms() {
  return {
    uTime: uniform(0),
    uYear: uniform(0),
    uFruitScale: uniform(0.4),

    // ワイブル(明滅の周期に反映。寿命そのものは CPU 側で life[] に反映)
    uK: uniform(3.0),
    uEta: uniform(21.2),

    // 樹・果実の基調色
    uTrunkCol: uniform(new THREE.Color('#FFFFFF')),
    uTwigCol: uniform(new THREE.Color('#E6EDF1')),
    uYoungCol: uniform(new THREE.Color('#2FD8C4')),
    uRipeCol: uniform(new THREE.Color('#B4E44E')),

    // 落下の調和パレット: 熟した灯の色から HSL で作る類似 4 色。
    // 各果実は aSeed.x で 1 色を選ぶ(=完全ランダムではない調和的ランダム)。
    uPal: uniformArray(
      [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()],
      'color',
    ),

    // 落下 / 霧散のタイミングと霧の色
    uFall: uniform(1.6),
    uMist: uniform(2.2),
    uMistCol: uniform(new THREE.Color('#B4E44E')),
  };
}

// ============ 枝(幹→枝先グラデーション+呼吸) ============
export function createBranchMaterial(U) {
  const m = new LineBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const vW = attribute('aW', 'float');
  const vY = positionLocal.y;
  const breathe = float(0.88).add(float(0.12).mul(sin(U.uTime.mul(0.45).add(vY.mul(0.4)))));
  m.colorNode = mix(U.uTrunkCol, U.uTwigCol, smoothstep(0.1, 0.9, vW)).mul(breathe);
  m.opacityNode = mix(float(0.95), float(0.40), smoothstep(0.1, 0.95, vW));
  return m;
}

// ============ 果実(=設備機器) ============
// 各果実に Weibull 寿命 aLife を持たせ、経過年数 uYear で
//   若い灯 → 熟した灯 → 深紅 → 落下(調和パレット色) → 霧散
// と遷移する。
export function createFruitMesh(U, data) {
  const { fruitPos, fruitLife, fruitSeed, N } = data;

  // NOTE: three r185 の instancedBufferAttribute(rawArray) は scalar/vecN で
  // setInstanced(true) を呼ばず per-vertex 属性になる。InstancedBufferAttribute を渡す。
  const aLife = instancedBufferAttribute(new THREE.InstancedBufferAttribute(fruitLife, 1), 'float');
  const aSeed = instancedBufferAttribute(new THREE.InstancedBufferAttribute(fruitSeed, 2), 'vec2');
  const aPos = instancedBufferAttribute(new THREE.InstancedBufferAttribute(fruitPos, 3), 'vec3');

  // 熟成に伴う on-tree の色(4色ピッカー由来)
  const ripenColor = Fn(([ripen]) => {
    const crimson = mix(U.uRipeCol, vec3(1.0, 0.32, 0.24), 0.65);
    const col = mix(U.uYoungCol, U.uRipeCol, smoothstep(0.35, 0.8, ripen)).toVar();
    col.assign(mix(col, crimson, smoothstep(0.85, 1.0, ripen)));
    return col;
  });

  // 頂点: 位置(落下変位)とスケールを構築(sample の gl_PointSize を world 換算)
  const vertPack = Fn(() => {
    const T = aLife;
    const remain = clamp(U.uYear.sub(T).negate().div(T), 0.0, 1.0);
    const ripen = remain.oneMinus();

    const p = aPos.toVar();
    const mist = float(0.0).toVar();
    const sizeMul = float(0.84).toVar();

    If(U.uYear.greaterThanEqual(T), () => {
      const s = U.uYear.sub(T).div(U.uFall);
      If(s.lessThan(1.0), () => {
        const e = s.mul(s);
        p.y.assign(mix(aPos.y, 0.15, e));
        p.x.addAssign(sin(s.mul(6.0).add(aSeed.x.mul(20.0))).mul(0.25).mul(s));
        p.z.addAssign(cos(s.mul(5.0).add(aSeed.y.mul(20.0))).mul(0.25).mul(s));
        sizeMul.assign(0.50);
      }).Else(() => {
        const mm = U.uYear.sub(T).sub(U.uFall).div(U.uMist);
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
    const scaleV = base.mul(float(1.0).add(mist.mul(1.1))).mul(sizeMul).mul(U.uFruitScale);
    return vec4(p, scaleV);
  });

  // フラグメント: 色とアルファ(グロー形状)を vec4(col.rgb, alpha) に詰める
  const stateFrag = Fn(() => {
    const T = aLife;
    const remain = clamp(U.uYear.sub(T).negate().div(T), 0.0, 1.0);
    const ripen = remain.oneMinus();

    const lam = pow(max(U.uYear.div(U.uEta), 0.02), U.uK.sub(1.0));
    const tw = float(0.72).add(float(0.28).mul(sin(U.uTime.mul(float(0.8).add(lam.mul(2.2))).add(aSeed.x.mul(30.0)))));

    const col = ripenColor(ripen).toVar();
    const glow = mix(float(0.45), float(1.0), smoothstep(0.5, 1.0, ripen)).mul(tw).toVar();
    const mist = float(0.0).toVar();

    If(U.uYear.greaterThanEqual(T), () => {
      const s = U.uYear.sub(T).div(U.uFall);
      If(s.lessThan(1.0), () => {
        glow.assign(0.9);
        // 落下: 調和パレットの 1 色へ(果実ごとに seed で選択)
        const idx = int(mod(aSeed.x.mul(4.0), 4.0));
        col.assign(mix(col, U.uPal.element(idx), s.mul(0.75)));
      }).Else(() => {
        const mm = U.uYear.sub(T).sub(U.uFall).div(U.uMist);
        If(mm.lessThan(1.0), () => {
          mist.assign(mm);
          glow.assign(mm.oneMinus().mul(0.7));
          // 霧も果実ごとの調和色(ライム系・広がりあり)を保ち、消える際にミスト色へ
          const midx = int(mod(aSeed.x.mul(4.0), 4.0));
          col.assign(mix(U.uPal.element(midx), U.uMistCol, smoothstep(0.15, 1.0, mm)));
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

  const geo = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.InstancedMesh(geo, material, N);
  const I = new THREE.Matrix4();
  for (let i = 0; i < N; i++) mesh.setMatrixAt(i, I);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

// ============ 枝の LineSegments ============
export function createBranchLines(U, data) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.branchPositions, 3));
  g.setAttribute('aW', new THREE.BufferAttribute(data.branchW, 1));
  return new THREE.LineSegments(g, createBranchMaterial(U));
}

// ============ 地面の残光 ============
export function createGround(U) {
  const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const r = length(uv().sub(0.5));
  const ring = exp(r.mul(-7.0));
  m.colorNode = vec3(0.05, 0.09, 0.11).mul(ring).mul(float(0.8).add(float(0.2).mul(sin(U.uTime.mul(0.3)))));
  m.opacityNode = ring.mul(0.5);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), m);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}
