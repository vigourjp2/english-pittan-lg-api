# v58 external classifier display window

## 目的
v57 の HF Chat 方式は使わない。HF Chat はクレジット/リミット/JSON崩れの不安があるため、理由探索には採用しない。

v55 のローカル文法リスト前処理も使わない。`should` や `be` や動詞らしさを手元リストで判定しない。

## 方式
1. 候補生成は従来どおり。
2. Link Grammar + LanguageTool で軽い外部寄り判定を通す。
3. 表示候補だけ、実績のある HF 分類器 `abdulmatinomotoso/English_Grammar_Checker` に投げる。
4. HF で acceptable=true の候補だけ理由表示する。
5. HF が遅い/失敗した候補は非表示にして、変な候補を出さない。

## v56/v57 との差分
- v56 の配列 batch は使わない。モデル/Router側で詰まる可能性が高かったため。
- v57 の HF Chat は使わない。リミット/JSON不安定性があるため。
- ローカル文法ハードコードは使わない。
- 各 depth で外部分類器に出す表示候補窓を設け、外部I/Oを隔離する。

## health 期待値
- mode: `link-grammar-plus-languagetool-error-gate-v58-external-classifier-display-window`
- reasonExplorePolicy: `light-first-reason-plus-external-classifier-display-window-v58`
- reasonExternalShallowJudge: `hf-classifier-display-window-v58`
- reasonLocalPrefilterEnabled: false
- hfChatUsed: false
