# English Pittan v42.2 - acceptability model scan diagnostic

目的: `walking am happy` を落とせる軽量モデルを探すための診断版。

## 方針

- `/check` の本判定はまだ変えない。
- `/diagnose-acceptability` はデフォルトでは `textattack/roberta-base-CoLA` 1モデルだけ。
- `?scan=1` を付けたときだけ候補モデルを横断して確認する。
- `/diagnose-model-benchmark?scan=1` で固定5文をまとめて比較する。

## 候補モデル

環境変数 `HF_SCAN_MODELS` で変更可能。デフォルト候補:

- textattack/roberta-base-CoLA
- textattack/bert-base-uncased-CoLA
- EstherT/sentence-acceptability
- nikolasmoya/c4-binary-english-grammar-checker
- cointegrated/roberta-large-cola-krishna2020
- mrm8488/deberta-v3-small-finetuned-cola

## 確認URL

Health:

```txt
/health
```

単体診断:

```txt
/diagnose-acceptability?text=walking%20am%20happy
```

モデル指定:

```txt
/diagnose-acceptability?text=walking%20am%20happy&model=textattack/bert-base-uncased-CoLA
```

候補モデル横断:

```txt
/diagnose-acceptability?text=walking%20am%20happy&scan=1
```

ベンチマーク:

```txt
/diagnose-model-benchmark?scan=1
```

## 注意

`scan=1` と `/diagnose-model-benchmark?scan=1` はHFリクエストを多く使うため、Billing確認しながら少数回だけ使う。
