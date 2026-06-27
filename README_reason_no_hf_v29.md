# v29: 理由解析からHF/外部AIを撤去

## 目的
Hugging Face Inference Providers の月間クレジット・上限・課金枠に依存しないようにする。

## 方針
- 英文成立判定: Strict Link Grammar の完全parse結果だけで決定
- 不成立理由: HF/chat/completionsを呼ばず、Link Grammarの成否・候補語数・診断情報だけからローカル生成
- 理由解析キュー: 既存どおり1本ワーカー、表示上は「理由解析中」「理由解析待ち①...」を維持
- HF_TOKENが未設定でも理由解析は動く
- HFのクレジット切れ・上限・API停止で詰まらない

## 変更点
- `explainRejectedSentence()` を `localReasonFromDiagnostics()` に差し替え
- `checkSentence()` は `judgeAcceptability()` のHF判定を使わず、`localAcceptabilityFromLinkParser()` を使用
- `/health` に以下を追加
  - `reasonProvider: local-link-grammar`
  - `quotaFree: true`
  - `hfDisabledForReason: true`
- フロントのキャッシュキーを v29 に更新

## 注意
AIで細かい文法理由を生成する方式ではないため、理由は「Link Grammarで完全な結びつきが作れない」というローカル診断ベースになる。
ただし、上限・課金・外部AI停止で一生失敗する問題は起きない。
