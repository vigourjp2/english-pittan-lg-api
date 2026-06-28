# v93 API acceptability gate + stale UI clear

目的:
- `I am speaking they` / `like speaking they` のように Link Grammar が parse してしまうだけの文を、ゲーム成立として採点しない。
- JS の個別文/単語ハードコードではなく、サーバーAPI側で外部 acceptability classifier を game gate にする。
- 新しい配置開始時に古い COMBO/画像/経路ハイライトを必ず閉じ、採点前表示と古い成立UIが同時に出る矛盾を消す。

変更:
- frontend batch payload に `strictGameGate:true` / `acceptabilityModelGate:true` を追加。
- server `evaluateGameTextExact(text, options)` を追加し、強制 strict gate 指定時は HF acceptability API gate を通す。
- `ACCEPTABILITY_HF_GAME_GATE_ENABLED` default を true に変更。
- `ACCEPTABILITY_HF_FAIL_CLOSED` default を true に変更。
  - HF_TOKENなし/外部判定不可なら、怪しい文をGOODにせず fail-closed。
- batchは `translate:false` を尊重して翻訳を呼ばない。
- batch concurrency default 8。
- frontend `clearResultOverlays()` を追加し、新規配置開始/採点前/NGで stale COMBO/画像を消す。

注意:
- Render 環境変数 `HF_TOKEN` が必要。ない場合、外部acceptability gateがfail-closedになり、怪しい成立は採点されない。
- 文法の個別JSハードコードは追加していない。
