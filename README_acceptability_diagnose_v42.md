# v42 Acceptability Diagnose Only

目的:
- v41で LanguageTool error gate は `he am happy` を止められることを確認済み。
- しかし `eating am happy` は Link Grammar も LanguageTool も通す。
- そこで、いきなり本判定に入れず、CoLA/acceptability系モデルが止められるか診断するための版。

重要:
- カード文字列は補正しない。
- LanguageToolのreplacementは適用しない。
- `/check` は v41系の判定のまま。
- HF/acceptabilityモデルは `/diagnose-acceptability` の診断だけで使う。
- 速度、クレジット、判定精度を確認してから本採用する。

追加URL:
- `/diagnose-acceptability?text=eating%20am%20happy`
- `/diagnose-acceptability?text=he%20am%20happy`
- `/diagnose-acceptability?text=I%20am%20happy`
- `/diagnose-acceptability?text=he%20is%20happy`

モデル指定:
- `/diagnose-acceptability?text=eating%20am%20happy&model=textattack/roberta-base-CoLA`

確認ポイント:
- `hfDiagnostic.rejectedCount`
- `hfDiagnostic.judgements[].acceptable`
- `finalGatePreview.ok`
- `finalGatePreview.note` は diagnostic only を示す
