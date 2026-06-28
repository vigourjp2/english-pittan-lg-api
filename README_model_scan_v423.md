# v42.3 model scan second pass

目的:
- v42.2で `textattack/roberta-base-CoLA` 以外の多くが provider 非対応だったため、候補を再選定。
- `walking am happy` を落とせる軽量 text-classification 系モデルを探す。
- `/check` は変更しない。診断専用。

変更:
- health mode: `link-grammar-plus-languagetool-error-gate-v42.3-model-scan-second-pass-diagnose`
- `HF_SCAN_MODELS` を第2候補群へ変更。
- `nikolasmoya/c4-binary-english-grammar-checker` を text-generation ではなく classification として再試験。
- 追加候補:
  - `abdulmatinomotoso/English_Grammar_Checker`
  - `agentlans/snowflake-arctic-xs-grammar-classifier`
  - `pszemraj/electra-small-discriminator-CoLA`

確認URL:
- `/health`
- `/diagnose-acceptability?text=walking%20am%20happy&scan=1`
- `/diagnose-model-benchmark?scan=1`

注意:
- `scan=1` は候補モデル分だけHFリクエストを使う。
- 採用判断は、正常文をOK、異常文をNGにできるかで行う。
- 本番ゲート採用はまだ行わない。
