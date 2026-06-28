# v67 auto hand completion reason

- Fixes frontend reason display when board has an incomplete candidate like `I like` and the completing word exists in hand, but no hand card is selected.
- Uses all current hand words as completion candidates for the latest API-NG board candidate.
- Does not hardcode sentences or words. It probes `base + handWord` and `handWord + base`, then accepts only `/check-and-translate` `gameOk:true`.
- Keeps v65 dual HF gate and v66 board straight-line extraction.


## v68追記
配置直後の判定ロック中に手札補完理由がreturnして何も走らない問題を修正。判定ロック解除後にも複数回リトライします。
