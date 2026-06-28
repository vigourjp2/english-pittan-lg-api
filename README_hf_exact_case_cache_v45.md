# v45 HF exact-case cache fix

## 根本原因
`Walking am happy` の確認結果に `cached:true` が出ていた。
これは、HF文法判定キャッシュキーが `src.toLowerCase()` だったため、
`walking am happy` と `Walking am happy` が同じキャッシュとして扱われていた。

したがって、v43/v44のままでは「大文字にしてもNG」を新規HF判定で確認できていなかった。

## 修正
HF文法判定キャッシュキーを exact text に変更。

```js
const key = `${ACCEPTABILITY_HF_MODEL}::${src}`;
```

これは `Walking am happy` 専用の判定ではない。
APIに送る文そのものをキャッシュキーに使う、一般的なキャッシュ整合性修正。

## 確認
/health に以下が出る。

```txt
hfAcceptabilityCacheKeyPolicy: exact-text-case-sensitive-v45
```

次に以下を叩く。

```txt
/check?text=Walking%20am%20happy
```

期待：

```txt
hfAcceptability.cached: false
reasonSource: hf-grammar-classifier-gate
ok: false
gameOk: false
```

これで `walking` のキャッシュ流用ではなく、`Walking` そのものをHF判定したことになる。
