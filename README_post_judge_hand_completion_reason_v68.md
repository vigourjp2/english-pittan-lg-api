# v68 post-judge hand completion reason

原因: v67では refreshFailReasonWithHandCandidates() が placementJudgeBusy 中に即returnしていた。配置直後の setTimeout(80ms) がロック中に発火すると、盤面 I like + 手札 apples の補完API確認が走らなかった。

修正: 補完理由APIは placementJudgeBusy 中でも実行可にし、さらに判定ロック解除後に 0/250/800/1600ms で再試行する。判定自体は /check-and-translate の gameOk:true のみ採用。
