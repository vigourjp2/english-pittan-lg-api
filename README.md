# English Word Puzzle Fixed

修正内容:
- API判定の失敗結果を localStorage に保存しないよう修正。
- 判定キャッシュキーを `englishPittan.linkGrammarCache.v6.successOnly` に変更し、古い false キャッシュを踏まないように変更。
- 手札の表示ラベルを固定スロット名ではなく、実単語の品詞ラベルに変更。例: Japanese は `名詞/形容詞`。
- `/check-and-translate-batch` は継続利用。ゲームURLは `?lgapi=https://english-pittan-lg-api.onrender.com` を付けて使う。

ゲームURL例:
https://game-aor.pages.dev/index-english.html?lgapi=https://english-pittan-lg-api.onrender.com&v=20260627c


## v33
StrictLG API only for scoring; exploration cleanup; no stale image panel.


## v44 frontend case fix

Fixes game-side false NG where card `I` was lowercased to `i` before API judgement. API text now preserves card casing; cache key bumped to v44.
