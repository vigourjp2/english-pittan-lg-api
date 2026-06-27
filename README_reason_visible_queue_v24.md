# v24 理由解析キュー可視化・新規一手優先

## 修正方針
- 理由解析ワーカーは1本固定。同時に複数のHF理由解析を投げない。
- 現在実行中の1件だけを「理由解析中…」と表示。
- 実行待ちの候補は、サーバー側のキュー順に「理由解析待ち①」「理由解析待ち②」…と表示。
- 新しい一手で発生したNG経路は、古いpending/retry jobより前に並べる。
- 実行中の古いjobを強制中断はできないが、そのjobが成功/失敗/再試行待ちになった直後、次の1件を選び直すため、新しい一手が割り込む。
- 無限リトライを廃止し、既定4回でfailureに落とす。古い失敗jobがキュー先頭に戻り続ける詰まりを防ぐ。

## サーバー側
- `REASON_JOB_MAX_ATTEMPTS` 既定値を `4` に変更。
- `reasonQueueRevision` を追加。
- `/reason-result` の返却に `queueRole`, `queueIndex`, `queueLabel`, `runningText` を追加。
- `/reason-queue` を追加し、現在実行中jobと待ちjob一覧を確認可能にした。
- `processReasonQueue()` は1件完了ごとに全jobを再ソートして次のjobを選ぶ。

## クライアント側
- キャッシュキーをv24へ更新。
- `理由解析中…` は `queueRole=running` の1件だけ。
- `queueRole=waiting` は `理由解析待ち①` 形式で表示。
- polling対象数は `REASON_POLL_MAX_ITEMS=8`。同時並列ではなく順番に確認する。

## 反映
- `index-english.html` をGitHub Pages側へ差し替え。
- `server.js` をRender側へ差し替え。
- Render再デプロイ後、`index-english.html?v=24` で確認。
