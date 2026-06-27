# 画像挿入対応 再実装メモ v17

## 方針
- 成立判定ロジックには画像処理を混ぜない。
- 盤面候補探索・API英文判定・スコア計算・使用回数処理は既存フローを維持。
- 画像表示は `scoring` が確定した後の後処理だけで実行する。

## 今回の原因
- Pixabay検索が `order=popular` かつ「最初の検索で8件取れたら打ち切り」だったため、英文の意味より人気画像に寄りやすかった。
- `I am happy` / `I am sad` / `I like apples` などで、主語・状態・目的語の必須語チェックが弱く、タグが薄い画像でも採用されていた。
- 画像キャッシュが英文単位だけだったため、別英文でも同じPixabay画像IDが連続採用されることを止められなかった。

## 今回の変更点
- HTML側バージョンを `sentence-image-diversity-v17` に更新。
- 画像キャッシュを `sentencePixabay:v7:` に更新し、過去の誤画像キャッシュを無効化。
- クライアント側に直近Pixabay画像ID記録 `sentencePixabay:recentIds:v1` を追加。
- `/sentence-image?q=...&avoid=ID,ID...` で直近画像IDをサーバーへ渡し、同じ画像の再利用を強く減点。
- サーバー側の検索クエリ生成を、英文の型ごとに強化。
  - be + 形容詞: `child with happy face cartoon illustration` など
  - like/love + 名詞: `child holding apples fruit cartoon illustration` など
  - play + 名詞: `child playing soccer ball cartoon illustration` など
- 早期打ち切りを廃止し、複数クエリの候補を横断スコアリング。
- 目的語・状態語など必須語が画像タグに無い候補を大きく減点。

## 確認文
- I am happy
- I am sad
- I like apples
- I play soccer
- I go to school

## 注意
Render側は `server.js` の再デプロイが必要。
Cloudflare/GitHub Pages側は `index-english.html` の更新とブラウザキャッシュ更新が必要。
URL末尾に `?v=17` などを付けると確認しやすい。
