# 寿命の樹 — The Weibull Tree (TSL)

設備機器の劣化予測（Weibull 分布）を、L-system で生成した樹に実らせた「果実＝設備」で
表現するインタラクティブ・ビジュアライゼーション。各果実に Weibull 寿命を割り当て、
経過年数に応じて **若い灯 → 熟した灯 → 深紅 → 落下 → 霧散** と遷移する。

three.js の **TSL（Three Shading Language / WebGPU node materials）** で実装。
WebGPU 非対応環境では **自動的に WebGL2 にフォールバック**する。

元となったデザイン仕様は `sample/weibull_tree.html`（初代）と
`sample/weibull_tree (1).html`（更新版・現行が準拠）。素の WebGL(r128)+GLSL 版。
本リポジトリはこれを three r0.185 + TSL へ移植し、機能拡張したもの。

---

## セットアップ / 実行

```bash
npm install
npm run dev       # 開発サーバ (Vite)
npm run build     # dist/ に本番ビルド
npm run preview   # ビルド結果のプレビュー
```

ブラウザは WebGPU 対応推奨（Chrome など）。非対応でも WebGL2 で動作する。

### URL ハッシュ（デバッグ / ディープリンク）
- `#y=22` … 初期経過年数を指定
- `#theme=jade` … 起動時にテーマ適用
- 併用可: `#theme=prism&y=17`

---

## 技術スタック

| 項目 | 内容 |
|------|------|
| 3D | three.js `^0.185`（`three/webgpu`, `three/tsl`） |
| レンダラ | `WebGPURenderer`（WebGPU→WebGL2 自動フォールバック） |
| ビルド | Vite `^8`（設定ファイルなし・デフォルト。エントリは `index.html`） |
| 言語 | Vanilla JS（ESM, `"type":"module"`）。フレームワーク不使用 |

---

## ファイル構成

```
index.html        UI（右=操作盤 / 下=再生ドック）とスタイル。エントリ
src/main.js       レンダラ初期化・UI 配線・パレット/テーマ・カメラ・描画ループ
src/materials.js  TSL マテリアル（枝 / 果実 / 地面）と共有 uniform 定義
src/tree.js       L-system の樹構築 + Weibull 寿命の付与（純データ生成、GPU 非依存）
sample/           元デザイン（素の WebGL+GLSL 版）。参照用
```

### データフロー
`tree.js: buildTreeData(seed,count,{k,eta,depth})`
→ `{branchPositions, branchW, fruitPos, fruitLife, fruitSeed, N}`
→ `materials.js` が枝 `LineSegments` / 果実 `InstancedMesh(SpriteNodeMaterial)` / 地面を生成
→ `main.js` が uniform を毎フレーム更新して描画。

---

## ドメインロジック

- **Weibull 寿命**: `life = η · (-ln(1-u))^(1/k)`（`u`∈(0,1) は seed 由来の一様乱数）。
  `tree.js` で CPU 計算し、果実ごとの `aLife` 属性として GPU へ。
  → **k, η を変えると寿命分布が変わるため再構築（rebuild）が必要**。
- **果実の状態遷移**（`materials.js` の `createFruitMesh` 内、シェーダ）:
  - on-tree: `uYoungCol → uRipeCol`（熟度 `ripen` で補間）→ 深紅
  - 落下 `uYear ≥ aLife`: `uFall` 年かけて落下、色は落下パレットへ寄せる
  - 霧散: さらに `uMist` 年かけて拡散・消滅、色は霧色（`uMistCol`）へフェード
- 果実＝1台の設備。生存数 `alive` は `life[i] > yearVal` を CPU で集計して表示。

---

## パラメータ（すべて可変・UI から操作）

**下部ドック**: 再生/一時停止・はじめから・経過年数スライダー（無操作で自動フェード）。
**右パネル「操作盤」**（`›` で開閉、`操作 ‹` ハンドルで再表示）:

- 表示: 灯の大きさ `uFruitScale` / 回転速度 `rotSpeed` / 自動回転 ON-OFF
- 樹形: 灯の数 `count` / 枝の密度 `depth`(9–14) / 樹形 No. `seed` + 🎲（いずれも再構築）
- パレット: テーマ選択ボタン群 + 4 色ピッカー（幹/枝先/若い灯/熟した灯）
- 詳細パラメータ（`▾` で開閉）:
  - Weibull: 形状 `k` / 尺度 `η`（再構築）
  - Timing: 落下 `uFall` / 霧散 `uMist` / 霧の色 `uMistCol`（即時）
  - Palette: 色相の広がり / 明暗差 / 彩度（同系統モード時のみ有効）

---

## 落下パレットの2モード

落下・霧散する果実の色は、以下 2 方式を切り替えて使う（`main.js`）。

1. **同系統モード（`customPal=false`）**: 「熟した灯」色から HSL で類似 4 色を生成
   （`PAL_DEFS` のオフセット × 色相の広がり/明暗差/彩度スライダー）。
   → 熟した灯ピッカーや Palette スライダーを操作すると自動でこのモードへ戻る。
2. **カラフルモード（`customPal=true`）**: テーマが `pal:[c0..c3]` を持つ場合、
   4 色相を**明示指定**（同系統に縛られない多色）。`uPal`（`uniformArray('color')`）に直接投入。

`uPal` は `updateType=RENDER` で毎フレーム再アップロードされるため、
`U.uPal.array[i]` の `THREE.Color` を書き換えるだけで反映される。

### テーマ一覧（`PALETTES` in `main.js`）
- おすすめ配色: `ember`(黄昏/同系統) `prism`(極彩/多色) `neon`(ネオン/多色) `galaxy`(銀河/多色)
- 季節: `hanami`(桜/多色) `shinryoku`(新緑/多色)
- 和のパレット: `sakura`(夜桜) `hotaru`(蛍火) `shigyo`(紫暁) ※同系統

各テーマは `cTrunk/cTwig/cYoung/cRipe`（＋任意で `cMist`, `pal`）を持つ。

---

## カメラ

`main.js` 末尾で自動周回（水平回転＋微妙な上下揺らぎ）。定数として焼き込み済み:

```js
const LOOK  = new THREE.Vector3(0.90, 6.84, -0.02); // 注視点
const CAM_R = 23.22;  // xz 周回半径（ズーム相当）
const CAM_Y = 3.60;   // カメラ高さ
```

これらは開発中に一時導入した OrbitControls で手動決定し、値を書き戻したもの
（OrbitControls ツールは撤去済み）。**再調整が必要なら** `three/addons/controls/OrbitControls.js`
を一時的に足し、`camera.position`/`controls.target` を書き出して定数へ反映する運用でよい。

---

## 移植上の注意（次の担当者向けハマりどころ）

- **three r0.185 のバグ**: `instancedBufferAttribute(生の TypedArray, 'vec3')` は
  scalar/vec2/vec3 で `setInstanced(true)` を呼ばず **per-instance にならない**
  （全インスタンスが原点に重なる）。→ **必ず `THREE.InstancedBufferAttribute` を渡す**こと。
  `materials.js` の該当箇所参照。
- **果実の描画**: `SpriteNodeMaterial` + `InstancedMesh`。ビルボードは material が担い、
  位置は `positionNode`(=`instancedBufferAttribute`) が担うため `instanceMatrix` は単位行列。
  `frustumCulled=false`（バウンディングが原点集約になり誤カリングするため）。
- **TSL の `Fn`**: 本体は**ノードを返す**必要がある（プレーンオブジェクト不可）。
  複数値は `vec4(...)` にパックして `.xyz`/`.w` で取り出している。
- **色管理**: パレットの数値パラメータ由来は Color の sRGB 変換を避ける意図がある。
  現状は HSL/明示 hex を Color で扱いつつ、加算合成の発光として使用。
- **再構築が要るパラメータ**: seed / count / depth / k / η（`rebuild()`）。
  それ以外（色・大きさ・タイミング・回転）は uniform 即時反映。

### 動作確認の小技（ヘッドレス）
GPU 無し環境でも SwiftShader で WebGL2 フォールバックを走らせて描画確認できる:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --use-gl=angle --use-angle=swiftshader \
  --enable-unsafe-webgpu --enable-features=Vulkan,WebGPU \
  --window-size=1400,900 --virtual-time-budget=3800 \
  --screenshot=out.png "http://localhost:5173/#theme=hanami&y=15"
```

---

## 次のセッションへ（今後の予定）

このページ（寿命の樹）は**完成・保持**。今後は**別ページで別プロジェクト**を同リポジトリに展開予定。

- 現状は Vite の単一エントリ（`index.html`）。ページを増やす場合は
  **Vite のマルチページ構成**（`vite.config.js` の `build.rollupOptions.input` に
  各 `*.html` を列挙／またはサブディレクトリに分割）を検討。
- 既存の `src/` は本プロジェクト専用。新プロジェクトは
  `src/<project>/` 等に分離し、共有したいユーティリティのみ切り出すと衝突が少ない。
- **この寿命の樹ページの挙動・見た目は変更しない前提**で拡張すること。
