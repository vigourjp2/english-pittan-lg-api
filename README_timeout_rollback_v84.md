# v84 placement timeout rollback fix

## 原因
v76 の watchdog は、`scanFromCell()` が 12 秒以内に戻らないと `placementJudgeBusy=false` にして操作ロックだけ解除していた。
しかし、配置直後にすでに以下を仮変更していた。

- `state.board[cellIndex]` に配置カードを追加
- `p.hand[selectedHandIndex]` を次カードへ補充
- `selectedHandIndex` は残ったまま

そのためタイムアウト後、未採点カードが盤面に残り、手札も消費済みに見え、さらに選択中カードが残るため空きマス全部が selectable の黄色枠になった。
これはAPI遅延時にゲーム状態が壊れる不具合。

## 修正
- 配置前に盤面・手札・ターン・スコアのスナップショットを保存。
- watchdog timeout 時に仮配置をロールバック。
- timeout 後に古い API 結果が返っても、盤面・点数・ターンへ反映しない。
- timeout 時は選択状態も解除し、黄色い配置候補の全面表示を止める。

## 方針
英文判定ロジックやローカル文法ハードコードは追加していない。
修正対象は、API遅延時のUI/状態管理のみ。
