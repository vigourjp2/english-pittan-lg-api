# v74 no local grammar hardcode

目的: HTML側のローカル文法ヒューリスティック/固定英文辞書/固定和訳辞書/Harper判定/手札補完probeを削除し、成立判定・理由・翻訳をAPIに集約する。

削除/無効化:
- isLikelyCompleteSentenceWords / hasOrphanTail / isHarperCandidateWords
- Harperによる候補判定
- EXACT / EXACT_JA / PHRASE_BANK / PHRASE_MAP による成立・翻訳
- evalCorePattern / grammarEvaluate / translateSequence
- 3単現sなどのローカル英文整形
- クライアント側の手札補完probe

残すもの:
- WORDS/POS は配牌・手札表示カテゴリのためのメタデータ。英文成立判定には使わない。
- board/hand/deck context の送信。理由探索はAPI側。
- 表示中NG候補1件の理由job化。文や単語の固定判定ではなく、UI表示対象の説明要求。
