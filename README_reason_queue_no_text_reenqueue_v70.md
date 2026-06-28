# v70 reason queue no text re-enqueue

原因:
- v69 は pendingReasonList() が localStorage/linkGrammarCache の古い pending まで拾っていた。
- pollPendingReasons() は reason-result missing のとき /reason-job?text=... を呼び、新規 reason job を作っていた。
- さらに persistent hand completion が /check-and-translate を繰り返し叩き、NG probe ごとに reason job が増えた。

修正:
- pendingReasonList() は今回の lastScanRejects かつ reasonJobId ありだけに限定。
- poll 側から /reason-job?text=... を呼ばない。missing でも再投入しない。
- クライアント側の手札補完 probe を停止。手札候補は /check の reason context と reason job 側探索に任せる。

狙い:
- 理由解析待ちが勝手に増える不具合を止める。
- 1手につきAPIが返した reasonJobId だけを追跡する。
