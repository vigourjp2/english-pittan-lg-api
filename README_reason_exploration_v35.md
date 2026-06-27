# v35 judge-lock UI fix

目的: I am 等の未完成候補を置いた直後に、画面が「成立した」ように見えるUIを修正。

- 成立判定は従来どおり Strict Link Grammar API の結果のみ。
- JS/APIの文法ハードコーディング追加なし。
- 判定中メッセージを「成立候補」から「Strict Link Grammarで判定中」に変更。
- 判定中は空マスを黄色の selectable 表示にしない。
- 判定中は手札選択を無効化し、操作ロック中と表示。
- 新規配置開始時に前回画像パネルを閉じる挙動は維持。

確認:
- `I am` を置いた直後、GOOD/成立表示にならない。
- 判定中の空マスが黄色で選択可能に見えない。
- 判定完了後、Strict Link GrammarがNGなら不成立理由へ進む。
- `/health` mode: `link-grammar-strict-only-v35-judge-lock-ui-no-hardcode`
