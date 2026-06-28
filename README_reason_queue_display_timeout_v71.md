# v71 reason queue display / timeout fix

原因: v70後も画面に出ていた丸数字は、フロントが作ったジョブ数ではなく、APIサーバ全体の queueIndex。これを「理由解析待ち③」のように表示していたため、待ち数が勝手に増えるように見えていた。

対応:
- queueIndexを画面表示から外す
- poll対象は今回の reasonJobId だけに維持
- 12秒以上完了しない reason poll はクライアント側で保留扱いにして止める
- missing時の再enqueueは禁止継続

API本体は変更なし。v65 dual HF gateを前提。
