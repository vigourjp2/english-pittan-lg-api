# v94 combo reuse fix

原因: `selectScoringMatches()` が長い成立経路を採用した後、そのセル集合に含まれる短い成立経路を捨てていた。これにより同じ盤面カードを複数の成立経路で使うコンボが減り、「一回使ったカードを使えない」仕様に見えていた。

修正:
- 盤面カードの `useCount` は表示・所有/スコア用で、候補抽出からは除外しない方針を維持。
- `selectScoringMatches()` の subset pruning を撤去。
- API が `gameOk:true` と返した distinct な「セル列 + 英文」はすべて採点対象。
- 重複完全一致だけ除去。

注意:
- v93 の API acceptability gate は維持。成立判定そのものはAPI側で絞る。
- NG経路は成立1以上なら無視、成立0ならTOP1のみの方針を維持。
