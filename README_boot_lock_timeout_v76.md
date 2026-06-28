# v76 boot/placement lock timeout fix

原因: 判定中ロック `placementJudgeBusy` は `scanFromCell()` 完了後にしか解除されない。Render/API が遅い・失敗・fetch が戻らない場合、`await scanFromCell()` で止まり続け、盤面操作が永久ロックされる。

修正:
- `/check-and-translate` fetch に AbortController timeout を追加。
- 配置ごとに 12秒の watchdog を追加。
- timeout 時は `placementJudgeSeq++` で後から返る古い判定を無効化し、`placementJudgeBusy=false` で操作ロック解除。
- 正常終了/古い結果破棄時は timer を clear。

文法ハードコード追加なし。判定はAPIのみ。
