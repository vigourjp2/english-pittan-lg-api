# v62 depth-timeslice external classifier reason exploration

## 目的
v61で timeout failure は解消したが、depth1 の streaming 判定で soft deadline 近くまで消費し、depth2 の候補（例: `I am Japanese now`）まで十分に到達しなかった。

## 方針
- HF Chat は使わない。
- ローカル文法ハードコード（助動詞/be/動詞リスト判定）は使わない。
- `should Japanese now` / `happy now should` / `I am Japanese now` のような特定文の accept/reject は入れない。
- depth1 に time slice / check budget を設定し、depth2 補完へ必ず進める。
- 表示候補は Link Grammar + LanguageTool + `abdulmatinomotoso/English_Grammar_Checker` を通ったものだけにする。

## 追加デバッグ
rawReason に以下を出す。
- finalHfCandidateTexts
- finalHfAcceptedTexts
- finalHfRejectedTexts
- finalHfSuppressedTexts
- lightAcceptedTexts
- orderedCandidatePreview
- depth1TimeBudgetHit
- streamingSoftDeadlineHit

これにより、理由探索がどの候補をHFへ投げたかをブラウザAPIだけで確認できる。
