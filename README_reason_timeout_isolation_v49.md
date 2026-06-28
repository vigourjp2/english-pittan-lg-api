# v49 reason timeout isolation

目的: v48で「理由解析待ち」「理由解析中」が詰まる問題を修正する。

## 原因
v48は理由探索を段階化したが、理由ジョブ1件・候補判定1件に対するタイムアウト隔離がなかった。
そのため、Link Grammar / LanguageTool / HF など外部I/Oのどれか1つが戻らないと、単一のreason queue全体が詰まり、後続の理由解析がすべて「待ち」のままになる。

## 修正
- 理由job全体に `REASON_JOB_TIMEOUT_MS` を追加。
- 候補1件ごとに `REASON_CANDIDATE_TIMEOUT_MS` を追加。
- 候補1件がタイムアウトしても、その候補だけを失敗扱いにして次へ進む。
- reason jobがタイムアウトしたら failure に落として後続jobを塞がない。
- stale running jobの期限切れ処理を追加。
- 探索候補数の打ち切り上限ではない。候補空間を先着順で切る修正ではない。

## 期待health
mode: link-grammar-plus-languagetool-error-gate-v49-reason-timeout-isolation
reasonExplorePolicy: staged-light-first-with-timeout-isolation-v49
reasonJobs.timeoutMs: 12000
reasonJobs.candidateTimeoutMs: 4500
