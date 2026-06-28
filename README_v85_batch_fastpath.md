# v85 batch fastpath

原因: フロントが盤面候補を1件ずつ `/check-and-translate` に直列送信していた。1候補最大7.5秒なのに配置watchdogが12秒だったため、候補が複数あるだけで正常系でもタイムアウトし、ゲーム状態が崩れた。

修正:
- `evaluateCandidatesByApi()` を `/check-and-translate-batch` 一括送信へ変更。
- batch送信では `reasonMode:none` / `reasonDisabled:true` / `translate:false` を指定し、配置中は成立判定だけに集中。
- 翻訳は成立後の `hydrateJapaneseForMatches()` に任せる。
- サーバーbatchは `translate:false` を尊重し、不要な翻訳API呼び出しを省略。
- batch並列数の既定を 4 -> 8 に変更。
- 配置watchdogは異常時用に 30秒へ延長。

文法ハードコード追加なし。判定の正本は外部APIの Strict Link Grammar + LanguageTool。
