# v41 LanguageTool Error Gate / No Autocorrect

目的:
- カード文字列は絶対に補正しない。
- Strict Link Grammar が fullParse しても、LanguageTool の重大な grammar error が出たら NG にする。
- LanguageTool は replacement を適用しない。エラー検出だけに使う。
- 理由探索候補も同じゲートを通す。
- `/diagnose?text=...` で Link Grammar と LanguageTool の結果を分離して確認できる。

確認URL:
- `/health` -> mode: `link-grammar-plus-languagetool-error-gate-v41-no-autocorrect`
- `/diagnose?text=he%20am%20happy`
- `/diagnose?text=eating%20am%20happy`
- `/check?text=he%20am%20happy`
- `/check?text=I%20am%20happy`

禁止事項:
- `he am happy` を `he is happy` に補正して OK にすること。
- 単語別の `if (he && am)` で判定すること。

判定:
- Link Grammar OK
- かつ LanguageTool blocking grammar rule なし
- ならゲーム上 OK
