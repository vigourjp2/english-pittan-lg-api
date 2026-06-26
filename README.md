# English Pittan Link Grammar + CoLA API

Render Web Service 用の英文判定APIです。

## 方針

英文判定は自前の単語別ハードコーディングでは行いません。

1. LanguageTool で表記・基本文法補正
2. Link Grammar `link-parser` を strict 条件で実行
3. Hugging Face の CoLA grammatical acceptability model で文の受容性を判定
4. OK の文だけ翻訳

## Environment Variables

必須ではありませんが、Hugging Face は無料アカウントの token を入れる方が安定します。

- `HF_TOKEN` : Hugging Face access token
- `ACCEPTABILITY_MODEL` : default `textattack/roberta-base-CoLA`
- `ACCEPTABILITY_THRESHOLD` : default `0.72`
- `LANGUAGETOOL_URL` : default `https://api.languagetool.org/v2/check`
- `MYMEMORY_EMAIL` : optional

## Endpoints

- `/health`
- `/proof?text=...`
- `/check?text=...`
- `/check-and-translate?text=...`
- `/translate?text=...`

## Test

```txt
/check-and-translate?text=I%20like%20you
/check-and-translate?text=I%20am%20happy%20today%20look
/check-and-translate?text=apples%20they%20see
/check-and-translate?text=they%20see%20apples
```
