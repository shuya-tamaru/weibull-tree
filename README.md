# weibull-tree

Three.js (TSL) で描く、ワイブル分布を主題にしたビジュアル作品集。

## 🌐 デモ (GitHub Pages)

- **寿命の樹** — https://shuya-tamaru.github.io/weibull-tree/
- **設備の森** — https://shuya-tamaru.github.io/weibull-tree/garden.html

## 開発

```bash
npm install
npm run dev      # 開発サーバー
npm run build    # dist/ に本番ビルド
npm run preview  # ビルド結果をプレビュー
```

## デプロイ

`main` ブランチへの push で GitHub Actions が自動ビルドし、GitHub Pages へ公開します
（`.github/workflows/deploy.yml`）。
