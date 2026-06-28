# v63 depth timeslice debug fixed

v62の reason job failure `t is not defined` を修正。

## 原因
v62で rawReason に `finalHfCandidateTexts` / `finalHfRejectedTexts` / `finalHfAcceptedTexts` を出すために、HF最終確認関数内で `t` を記録しようとしたが、その関数スコープに `t` が存在しなかった。

## 修正
`verifyAcceptedLight(item, light)` 内で、候補文を `candidateText` として明示的に作る。

```js
const candidateText = normalizeText(light?.text || item?.sentence || '').replace(/[.!?]+$/,'');
```

以後、HF確認・候補ログ・accepted/rejected/suppressedログはすべて `candidateText` を使用する。

## 方針維持
- HF Chat は使わない
- ローカル文法ハードコードは使わない
- should / Japanese / I am Japanese now 等の固定分岐は入れない
- depth timeslice + action bucket + 外部HF分類器方針を維持

## health期待値
mode: `link-grammar-plus-languagetool-error-gate-v63-depth-timeslice-debug-fixed`
reasonExplorePolicy: `depth-timeslice-action-bucket-plus-external-classifier-v63-debug-fixed`
reasonExternalShallowJudge: `hf-classifier-depth-timeslice-v63-debug-fixed`
reasonLocalPrefilterEnabled: `false`
