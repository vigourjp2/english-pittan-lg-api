# english-pittan v99 no HF game veto

## 修正内容

今回の不具合は、`I am hungry` のような基本的な be + adjective 文が成立できていない時点で発生していた。
原因は、ゲーム成立判定に外部HF/CoLA系 acceptability 分類器を veto として混ぜていたこと。これらは短い初級英文を false reject する場合があり、Strict Link Grammar / LanguageTool 側が通せる文まで NG にしていた。

## 対応

- ゲーム成立判定から HF acceptability veto を外した。
- デフォルトでは `ACCEPTABILITY_HF_GAME_GATE_ENABLED=false`。
- `strictGameGate` / `acceptabilityModelGate` がリクエストに来ても、ゲーム成立の強制HF veto には使わない。
- 成立判定は `Strict Link Grammar + LanguageTool + POSメタデータの汎用ゲート` に統一。
- `I am hungry` / `I am happy` などの個別文ハードコードは追加していない。
- `hungry` 専用処理も追加していない。
- 時間副詞固定リストも復活させていない。

## 重要

Cloudflare Pages へ `index-english.html` だけ置いても、Render 側の `server.js` が古いままだと同じ不具合が残る。
このZIPの `server.js` も Render にデプロイすること。
