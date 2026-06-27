# v30: Strict Link Grammar を成立判定の唯一ゲートに戻す

## ブラウザ確認で確定した原因
`/check?text=I%20am%20happy` の結果は、Strict Link Grammar 側では成功していた。

- `fullParse: true`
- `strictLinkGrammar: true`
- `linkages: 1`
- `nullCount: 0`
- `code: 0`

それなのに `ok:false / gameOk:false` になっていた原因は、後段の HF acceptability が `402 credits depleted` で失敗し、その失敗を成立判定に混ぜていたこと。

## 修正
- `/check` の `ok/gameOk` は Strict Link Grammar の結果だけで決める
- HF / acceptability / credit / quota は成立判定に一切関与しない
- `fullParse=true && strictLinkGrammar=true && linkages>0 && nullCount=0 && code=0` なら成立
- 理由解析は不成立候補にだけ使う
- `/link-test?text=I%20am%20happy` を追加し、Link Grammar単体の結果をブラウザ確認できるようにした

## 確認URL
- `/health`
- `/link-test?text=I%20am%20happy`
- `/check?text=I%20am%20happy`

## 期待
`/check?text=I%20am%20happy` は `ok:true, gameOk:true` になる。
