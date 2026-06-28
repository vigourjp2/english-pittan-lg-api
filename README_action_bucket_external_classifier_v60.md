# v60 action bucket external classifier window

## 目的
v59でタイムアウトは解消したが、候補窓が上位N件固定だったため、特定の生成順/actionに窓を食われ、`I am Japanese now` / `I like Japanese now` のような補完候補がLG/LT/HFに到達しないケースが残った。

## 方針
- HF Chatは使わない。
- ローカルの助動詞・be動詞・動詞リスト判定は使わない。
- 文そのもののOK/NGは、引き続き外部判定に寄せる。
- 候補窓だけを action/source バケット別に確保する。

## v60の処理
1. 候補生成
2. action/source別に候補窓を確保
   - hand:add-left
   - hand:add-right
   - hand:add-two-left
   - hand:add-two-right
   - replace / reorder / delete など
3. 候補窓だけ LG/LT へ投入
4. LG/LTを通った候補だけ `abdulmatinomotoso/English_Grammar_Checker` へ投入
5. HF acceptable=true だけ理由候補として表示

## ハードコーディングでない点
以下は入れていない。

```js
if (word === "should") reject;
if (sentence === "happy now should") reject;
if (sentence === "should Japanese now") reject;
if (sentence === "I am Japanese now") accept;
```

v60のバケットは、文法判定ではなく「どの候補から外部判定に回すか」の探索順制御だけ。

## health期待値
- mode: `link-grammar-plus-languagetool-error-gate-v60-action-bucket-external-classifier-window`
- reasonExplorePolicy: `action-bucket-light-window-plus-external-classifier-display-window-v60`
- reasonExternalShallowJudge: `hf-classifier-action-bucket-display-window-v60`
- reasonLocalPrefilterEnabled: `false`
- reasonActionBucketQuota: default `4`
- reasonLightCandidateWindowPerDepth: default `24`
