# v62 streaming action-bucket external classifier

目的: v60 で action bucket による候補窓確保は入ったが、窓内候補をまとめて LG/LT → HF に流した結果、再び 30 秒 timeout になった。

v62 の変更:

- HF Chat は使わない。
- ローカルの助動詞/be動詞/動詞リスト判定は使わない。
- `should Japanese now` / `happy now should` / `I am Japanese now` などの具体文 hardcode はしない。
- action/source bucket で探索順だけを作る。
- 候補をまとめて並列投入せず、1件ずつ streaming で外部判定する。
- LG/LT を通った候補だけ HF 分類器 `abdulmatinomotoso/English_Grammar_Checker` に投げる。
- HF accepted が出た瞬間に return する。
- job 全体 30 秒 timeout 前に `REASON_STREAMING_SOFT_DEADLINE_MS` で安全に候補なしを返す。

期待 health:

- mode: `link-grammar-plus-languagetool-error-gate-v62-streaming-interleaved-depth-external-classifier`
- reasonExplorePolicy: `streaming-interleaved-depth-plus-external-classifier-v62`
- reasonExternalShallowJudge: `hf-classifier-streaming-interleaved-depth-v62`
- reasonLocalPrefilterEnabled: `false`
- reasonStreamingSoftDeadlineMs: `23500`

確認URL例:

`/reason-context-test?text=Japanese%20now&hand=I,am,happy,should,like&deck=I,you,we,he,she,am,are,is,like,likes,happy,Japanese,now,should,be`
