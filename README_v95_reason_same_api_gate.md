# v95 reason suggestion same API gate / cache reset

原因:
- v94/v93 で採点側には external acceptability API gate を付けたが、理由補完探索はまだ `evaluateGameTextLightForReason()`（Strict Link Grammar + LanguageTool）だけで候補を通していた。
- その結果、採点NGになった `I am Japanese` に対して、理由探索が `I am Japanese need` のような変な補完を「英文になります」と返した。
- さらに external gate を fail-closed にしたため、HF_TOKEN未設定/枠切れ/外部API不可の場合に `I am Japanese` のような普通の初級英文までNGへ落ちる危険があった。
- ブラウザ localStorage の古いNG理由キャッシュも悪い表示を残す要因になっていた。

修正:
- 理由補完候補も採点と同じ `evaluateGameTextExact(... { strictGameGate:true, acceptabilityModelGate:true })` で検証する。
- `/reason-job-context` に `strictGameGate=1&acceptabilityModelGate=1` を渡す。
- external acceptability API は「使える時だけveto」。未設定/枠切れ/到達不可では valid beginner sentences をNGにしない fail-open に戻す。
- `LINK_GRAMMAR_CACHE_KEY` を v95 に変更し、古い `I am Japanese need` 系の理由キャッシュを読まない。

維持:
- JSで `they` や `need` などの個別英文ハードコードはしない。
- 成立1以上ならNG経路無視、成立0ならTOP1のみ理由処理。
- 曲がり候補復活、コンボ再利用修正は維持。
