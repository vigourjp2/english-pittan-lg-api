# 画像挿入対応 再実装メモ

## 方針
- 成立判定ロジックには画像処理を混ぜない。
- 盤面候補探索・API英文判定・スコア計算・使用回数処理は既存フローを維持。
- 画像表示は `scoring` が確定した後の後処理だけで実行する。

## 今回の変更点
- `showSentenceGeneratedImage(scoring)` を成立後の演出位置にだけ配置。
- 画像キャッシュを `sentencePixabay:v6:` に更新し、過去の誤画像キャッシュを無効化。
- 文法判定キャッシュを `englishPittan.linkGrammarCache.v16.cleanImageIsolated` に更新し、過去のNGキャッシュを無効化。
- `sentence-image` API は Render 側 server.js の `/sentence-image?q=...` を利用。

## 確認文
- I am happy
- I am sad
- I like apples
- I play soccer

## 判定
`I like apples` が API判定NG候補 のみで表示される場合は、Cloudflare Pages 側のHTMLが古い、またはブラウザキャッシュが古い。URL末尾の `v=` を変更する。
