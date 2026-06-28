# v56 external batch shallow reason display filter

## 目的
v55 のローカル文法リスト前処理（助動詞/be/動詞っぽい単語リスト）を撤去し、理由表示候補の浅い可否判断を外部HF分類器へ batch で投げる。

## 変更点
- ローカルの subject / modal / be / common verb / obvious non-verb リストによる候補破棄を廃止。
- 理由探索はまず Link Grammar + LanguageTool の軽量判定を使う。
- 軽量判定を通った表示候補だけ、HF分類器 `abdulmatinomotoso/English_Grammar_Checker` に配列 inputs で batch 投入する。
- HFで acceptable=false の候補は理由表示に出さない。
- 1候補ずつHFへ投げるのではなく、batch で外部判定へ投げてI/O詰まりを抑える。

## ハードコードしないこと
- `if (word === "should") reject` はしない。
- `if (sentence === "happy now should") reject` はしない。
- `if (sentence === "I am Japanese now") accept` はしない。

## health 期待値
- `mode`: `link-grammar-plus-languagetool-error-gate-v56-external-batch-shallow-reason-display-filter`
- `reasonExplorePolicy`: `light-first-reason-plus-external-hf-batch-shallow-display-filter-v56`
- `reasonExternalShallowJudge`: `hf-batch-classifier-v56`
- `reasonLocalPrefilterEnabled`: `false`
