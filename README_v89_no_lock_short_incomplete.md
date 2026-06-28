# v89 no-lock short incomplete

原因: v88 は成立0件のあと、`I` や `I like` のような短い作りかけでも補完候補 API batch を待ってから「採点前」にしていた。その間 `placementJudgeBusy=true` のままなので、画面は「判定中…操作ロック中」となり、プレイヤーは何もできないように見えた。

修正:
- `findContinuationCandidate()` で 1〜2語の作りかけは API 補完探索を待たず、即 `partial-short-no-block` として採点前扱いにする。
- すでに `scanFromCell()` で成立0は確認済みなので、短い断片は罰点化しない。
- これにより `I` / `I like` 配置後はすぐ操作ロック解除される。

方針:
- 成立判定は引き続き API 正本。
- これは英文OK判定ではなく、短い未完成断片を即罰点にしないためのゲーム進行制御。
