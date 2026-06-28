# v73 no-bulk reason + representative explanation

- v72で止めた「盤面スキャン中のNG候補ごとのreason job作成」は維持。
- ただし画面に出す代表NG候補まで `詳細理由未取得` のままになる問題を修正。
- 表示対象の代表NG候補だけ、1本だけ `/reason-job-context` に投げる。
- contextとして board/hand/deck を渡すので、`I like` + hand `apples` のような補完探索はAPI側reason jobで行う。
- 文や単語の個別ハードコードはなし。
