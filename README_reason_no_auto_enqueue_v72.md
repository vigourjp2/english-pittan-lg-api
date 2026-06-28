# v72 reason no auto enqueue

原因調査結果に基づく修正。

- `/check-and-translate` は不成立時に自動で reason job を作っていた。
- フロントの盤面スキャンは複数候補を `/check-and-translate` に投げるため、NG候補ごとに reason job が増えていた。
- v72では盤面スキャン時の `/check-and-translate` に `reasonMode:'none'` / `reasonDisabled:true` を付与。
- サーバ側も `reasonMode=none` なら `enqueueReasonJob()` を呼ばない。

これにより、通常の成立判定スキャンだけでは理由キューが増えない。
