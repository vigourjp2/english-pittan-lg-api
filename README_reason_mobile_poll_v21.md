# v21: 理由解析中がスマホで止まって見える問題の修正

## 現象
スマホで画面を定期的にタップしている時だけ、`理由解析中…` から理由表示へ進むように見える。

## 原因
サーバー側の reason job キューは動いていても、スマホ側の画面更新はブラウザ内 JavaScript の polling に依存していた。
Android/Chrome/省電力/WebView では、操作が止まる・画面が暗くなる・タブが非アクティブ寄りになると、`setTimeout` ベースの polling が大きく遅延または停止することがある。
そのため、理由生成は完了しているのに、クライアントが `/reason-result` を取りに行かず、表示だけが `理由解析中…` のまま残って見える。
タップするとブラウザが起きて保留 timer が動くため、そのタイミングで理由表示に変わっていた。

## 修正内容
- pending 理由一覧を `pendingReasonList()` に集約
- polling を単発 `setTimeout` だけでなく heartbeat `setInterval` でも継続
- polling 多重実行を `reasonPollInFlight` で防止
- `/reason-result` と `/reason-job` は `cache:'no-store'` で取得
- `visibilitychange / pageshow / focus / online / pointerdown / touchstart` で即時 polling 再開
- pending がある間は対応ブラウザで Screen Wake Lock を要求し、画面スリープによる停止を抑制
- pending がなくなったら heartbeat と wake lock を解除
- キャッシュキーを `v21` に変更

## 注意
画面を完全に消す、OSがブラウザを完全停止する、通信が切れる場合は、ブラウザ側だけではリアルタイム更新できない。
ただし復帰時に即 polling するため、完了済み理由はすぐ表示される。
