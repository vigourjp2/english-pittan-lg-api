# v38 context-aware reason jobs

原因: 理由探索jobの作成時に、画面から渡した `reasonHandCandidates` / `reasonDeckCandidates` を捨てていた。
そのため、手札に `it`, `listening`, `apples` などが見えていても、API側の理由探索は候補なしに近い状態で走り、`1通りを試しました` になっていた。

対応:

- 文だけではなく、その時点の候補カード文脈をreason job keyに含める。
- job作成時に候補カード配列をdiagnosticsへ保持する。
- 既存の古い成功結果を、候補カードが違う現在盤面に再利用しない。
- 単語別の文法ハードコーディングは追加しない。成立可否はStrict Link Grammarだけ。

期待:

- `I like` の手札に `it`, `listening`, `apples` があれば、`I like it` / `I like listening` / `I like apples` などを実際にStrict Link Grammarへ投げる。
- `現在の候補カードで、1通り` のような不自然な表示は、候補が本当に1つしか無い場合以外は出ない。

Health mode:

```txt
link-grammar-strict-only-v38-context-aware-reason-jobs
```
