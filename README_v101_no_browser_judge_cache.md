# v101 no browser judge cache

## 修正目的
v100 の「キャッシュキー変更」は対症療法なので撤回。
英文成立判定まわりのブラウザ localStorage 判定キャッシュを廃止し、毎回ブラウザAPIへ確認する。

## 変更点
- `LINK_GRAMMAR_CACHE_KEY` を廃止。
- `localStorage` から `englishPittan.linkGrammarCache.*` を読み込まない。
- 成立結果を localStorage に保存しない。
- NG結果/理由解析結果を localStorage に保存しない。
- 既存の古い `englishPittan.linkGrammarCache.*` は起動時/新規ゲーム時/開始時に掃除するだけ。
- 画面表示中の理由解析状態は `lastScanRejects` のみで保持する。
- API URL保存用 `englishPittan.linkGrammarApi`、翻訳キャッシュ、画像キャッシュ、名前保存は対象外。英文成立判定キャッシュだけ廃止。

## 期待動作
- `I am hungry` は毎回 `/check-and-translate` または `/check-and-translate-batch` の現在結果で判定される。
- 古いNGキャッシュで成立文が潰れる経路が消える。
- キャッシュキー更新による逃げをやめ、判定キャッシュ自体を使わない。
