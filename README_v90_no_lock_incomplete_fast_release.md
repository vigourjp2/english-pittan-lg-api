# v90 no-lock incomplete fast release

原因: v88/v89 の「未完成なら手札1〜2枚で完成するか」を探す補完APIを、配置処理の操作ロック中に待っていた。特に 3語以上の断片で `findContinuationCandidate()` が batch API を待ち、`placementJudgeBusy=true` が残って、手札を選んでも空きマスが selectable にならない。

修正:
- 操作ロック中に行うのは成立判定だけ。
- 成立0の場合、1〜3語の代表断片は API補完探索を待たず即「採点前」にしてロック解除。
- 長いNGだけTOP1理由解析へ進める。
- `broadcast/render/setMsg` より前に `placementJudgeBusy=false` と timer clear を実行し、後続例外でロックが残らないようにした。

方針: 追加文法ハードコードではなく、ロック中の無駄な補完探索を削除する状態管理修正。
