# v64 custom model benchmark

目的: `happy today he must` のように現行 /check が誤って通す文を、どの外部HF分類器が落とせるかをブラウザAPIで確認する。

## 追加API

- `/diagnose-custom-benchmark?scan=1&sample=...&sample=...`
- `/diagnose-modal-benchmark?scan=1&samples=a||b||c`
- 既存 `/diagnose-model-benchmark` も `text` / `sample` / `samples` があればカスタム診断に切替。

## 方針

- /check 本判定はまだ変更しない。
- HF Chatは使わない。
- ローカルで `must` / `should` を個別拒否しない。
- まず外部分類器の比較表を出し、第2ゲートに使えるモデルを特定する。
