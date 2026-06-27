# 英単語パズルゲーム 画像挿入対応 再統合版

## 方針
- 成立判定ロジックと画像表示ロジックを分離。
- 画像表示は `scoring` 確定後にだけ実行。
- 候補探索・API英文判定・スコア計算・使用回数処理には画像処理を混ぜない。

## 修正点
- `index-english.html`
  - Pixabay画像パネル表示を成立後処理として維持。
  - 閉じるボタンのスマホタップ対応を維持。
  - 画像キャッシュキーを `sentencePixabay:v5` に更新し、過去のズレ画像キャッシュを無効化。
  - 画像キャッシュは英文単位。日本語訳の揺れで別画像扱いにしない。
- `server.js`
  - `/sentence-image?q=...` を維持。
  - be動詞+形容詞文を動詞扱いしない。
    - `I am sad` -> `child sad face illustration`
    - `I am happy` -> `child happy face illustration`
  - Pixabay候補スコアを改善。
    - 人物が必要なクエリなのに動物・背景・アイコン寄りの画像を減点。
    - 低品質・AI生成・背景/壁紙系を減点。

## Render環境変数
`PIXABAY_API_KEY` が必要。

## 確認URL
- Health: `https://english-pittan-lg-api.onrender.com/health`
- Image API: `https://english-pittan-lg-api.onrender.com/sentence-image?q=I%20am%20sad`
- Game: `https://game-aor.pages.dev/index-english.html?lgapi=https://english-pittan-lg-api.onrender.com&v=cleanimage1`
