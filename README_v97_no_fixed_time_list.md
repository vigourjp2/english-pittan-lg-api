# v97 fix: remove fixed time-adverb hardcoding

## 問題
v96 では server.js に以下のような時間副詞の固定リストを置いていた。

```js
const GAME_TIME_ADVERBS = new Set([...]);
```

これはカード辞書とサーバー判定で二重管理になり、単語追加時に漏れ・ズレが起きるため削除した。

## 対応
- server.js から `GAME_TIME_ADVERBS` を完全削除。
- サーバーは単語名リストを持たない。
- フロントが既存カード辞書 `WORDS` の `pos` を `wordMeta` としてAPIへ送る。
- サーバーは `wordMeta[].pos.includes('advTime')` だけを見る。
- つまり、判定対象の単語名はサーバーに直書きしない。
- `I am happy today` のように advTime が1枚だけなら通す。
- advTime カードが2枚以上重なった候補は、カード属性ベースでゲーム候補から落とす。

## 変更ファイル
- index-english.html
  - `APP_VERSION` を `v97-pos-metadata-no-fixed-time-list` に変更。
  - `wordMetaForApi(words)` を追加。
  - `/check-and-translate` と `/check-and-translate-batch` に `wordMeta` を送信。
- server.js
  - `GAME_TIME_ADVERBS` 固定リスト削除。
  - `normalizeWordMetaList()` 追加。
  - `applyGameSemanticGate(text, acceptability, options)` は `wordMeta` の `pos` のみ参照。

## 検証
- `node --check server.js` OK。
- `index-english.html` 内 script 抽出後、`node --check` OK。
- `grep GAME_TIME_ADVERBS server.js index-english.html` で該当なし。
