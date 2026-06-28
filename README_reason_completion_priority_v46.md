# v46 reason exploration completion priority fix

## 原因
不成立理由探索の探索順序が悪かった。
旧順序は「add-left を候補カード全件」→「add-right」だったため、`I like` のような途中文で、手札に `apples` があっても `I like apples` を試す前に探索上限/時間切れに到達していた。

これは `I like apples` 専用のハードコードではない。候補カード全体に対する探索順序の問題。

## 修正
理由探索の一手追加フェーズを以下に変更。

1. hand add-right
2. board add-right
3. hand add-left
4. board add-left

APIに送る英文はカード表示そのまま。成立判定は従来通り Strict Link Grammar + LanguageTool + HF Grammar Gate。

## 期待
盤面 `I like`、手札 `apples` の場合、汎用探索が `I like apples` を候補として先に試し、成立候補として返す。

## ハードコードしていないこと
- `I like apples` を直接OKにする処理はない
- `like` の目的語ルールは書いていない
- `apples` 専用分岐はない
