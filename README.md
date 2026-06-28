# English Pittan v46

理由探索の探索順序を修正。

通常判定は v43/v45 系のまま。
不成立理由探索で、手札カードを後ろに足す候補を先に試すようにした。

目的は `I like` のような途中文で、手札の名詞を足せば成立するケースを、探索上限/時間切れ前に発見すること。

ハードコーディングではなく、候補探索順序の汎用修正。

確認:
- `/health` に `reasonExplorePolicy: hand-right-completion-priority-v46`
- 盤面 `I like` + 手札 `apples` で `I like apples` が理由候補に出る
