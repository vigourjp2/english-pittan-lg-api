# v20 reason queue restore / no hardcoded grammar reason

## 目的
「理由解析中…」を、元の設計どおり reason job としてキュー投入し、サーバー側で順に処理し、完了したものから画面に順次反映する。

## 修正点

### index-english.html
- `LINK_GRAMMAR_CACHE_KEY` を `v20.reasonQueueRestore` に変更し、古い pending/失敗キャッシュを切る。
- `reasonJobId` / `reasonStatus` を持つ不成立候補を polling 対象に戻した。
- `/reason-result?id=...` を定期確認し、`success` になったら `reasonExplain` を候補へ反映する。
- `missing` の場合は `/reason-job?text=...` で再投入する。
- `pending/running/queued/retry` の間だけ `理由解析中…` と表示する。
- `success` で説明文に差し替える。
- `failure/unavailable/missing/error` は無限 polling しない。
- 成立済み経路がある場合の「別候補NG」表示の文脈を、polling更新時にも維持する。
- polling取得件数を 2件から6件に増やし、複数候補があるときも順次更新されやすくした。

### server.js
- `reasonJobs` Map と `processReasonQueue()` による順次処理を維持。
- 不成立時は `enqueueReasonJob()` で job 化し、`reasonStatus` / `reasonJobId` を返す。
- 単語別ハードコーディングの文法理由は入れていない。
- `mode` を `link-grammar-reason-job-v20-queued-polling-no-hardcoded-reason` に更新。

## 反映手順
1. GitHub Pages側の `index-english.html` を差し替え。
2. Render側の `server.js` を差し替え。
3. Renderを再デプロイ。
4. ゲームURLに `?v=20` を付けて開く。
5. 必要ならゲーム内のAPIキャッシュクリア、またはブラウザのサイトデータ削除。

## 確認ポイント
- 不成立直後は `理由解析中…` が出る。
- reason job が成功したら、その候補だけ説明文へ差し替わる。
- 作り物の「like の後ろに目的語」等のハードコーディング理由は出ない。
