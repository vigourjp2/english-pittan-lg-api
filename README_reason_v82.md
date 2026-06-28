# v82 reason single displayed job / no permanent analyzing

## 原因
不成立理由の表示処理では、盤面スキャン中の全NG候補には `reasonMode:none` を付けて reason job を作らない方針だった。しかし `buildFailInfo()` が再描画・polling のたびに `placementId` を作り直し、`requestDisplayedRejectReason()` が次のNG候補を順番に `/reason-job-context` へ投入していた。

その結果、1配置につき代表1件だけ解析するつもりが、複数候補が順番に job 化され、最後の候補だけ `理由解析中...` で残っているように見えた。

また、`isReasonPending()` が `reasonJobId` のない候補も `text` だけで pending 扱いできる実装だったため、`/reason-result?text=...` が古い job に吸着するリスクがあった。

## 修正
- 1配置につき `/reason-job-context` に投げる表示用 reason job を代表1件だけに固定。
- `buildFailInfo()` 再描画時も同じ配置なら `placementId` を維持。
- `isReasonPending()` は `reasonJobId` がある job だけ polling 対象に変更。
- 代表候補以外は `API判定NG（代表候補のみ理由解析）` と表示し、永久に「解析中」に見せない。
- `unavailable/failure/missing/timeout` の表示を終端状態として明確化。
- 「はじめる」押下後に `/health` をブラウザから確認し、ログに API 状態を出す。

## 方針
文法ハードコード追加なし。成立判定は Strict Link Grammar API のみ。
