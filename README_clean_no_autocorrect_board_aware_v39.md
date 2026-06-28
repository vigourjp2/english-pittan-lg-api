# v39 Clean No-Autocorrect / Board-Aware Exploration

## 方針
- 成立判定前に LanguageTool / proofreadEnglish で英文を補正しない。
- `he am happy` は `he is happy` に直さず、そのまま Strict Link Grammar に投げる。
- `proof.normalized` は成立判定では常に `false`、`appliedCorrections` は空。
- 理由探索は単語別文法 if 文ではなく、実際の候補文を Strict Link Grammar に投げて通った経路だけを返す。

## 修正点
1. `/check` と `/check-and-translate` から自動補正を撤去。
2. 理由ジョブに `reasonBoardCandidates` を追加。
3. フロントから現在盤面のカードを `reasonBoardCandidates` としてAPIへ送信。
4. 理由探索の優先順を「盤面上の他カード → 手札 → 山札」に変更。
5. 理由探索に `REASON_EXPLORE_MAX_CHECKS` と `REASON_EXPLORE_MAX_MS` の上限を設定し、長時間 `理由解析中...` に居座りにくくした。

## 確認URL

```text
/health
```

期待値:

```text
mode: link-grammar-strict-only-v39-clean-no-autocorrect-board-aware
reasonProvider: strict-link-grammar-oracle-exploration-clean-no-autocorrect-board-aware
```

```text
/check?text=he%20am%20happy
```

期待値:

```json
{
  "originalText": "he am happy",
  "text": "he am happy",
  "normalized": false,
  "appliedCorrections": [],
  "ok": false,
  "gameOk": false
}
```

`text: "he is happy"` や `PERS_PRONOUN_AGREEMENT` が出たら、まだ古いserver.jsです。
