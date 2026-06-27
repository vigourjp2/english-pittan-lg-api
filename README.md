# English Pittan Link Grammar + HF Acceptability API

Render Web Service 用の英文判定API。

## 方針

ゲームHTML側では英文成立判定をしない。API側も単語ごとの個別禁止ルールを増やさない。

1. LanguageToolで軽い英文補正
2. Link Grammarを strict 条件で実行
3. Hugging Face Inference Providers / HF Inference 経由で文の受容性を判定
4. OKの文だけ翻訳

## Environment Variables

必須:

- `HF_TOKEN` : Hugging Face access token。Inference Providers権限が必要。

推奨:

- `ACCEPTABILITY_MODEL` : `EstherT/sentence-acceptability`
- `ACCEPTABILITY_THRESHOLD` : `0.72`

任意:

- `HF_PROVIDER` : default `hf-inference`
- `HF_ZERO_SHOT_FALLBACK` : default `1`
- `HF_ZERO_SHOT_MODEL` : default `facebook/bart-large-mnli`
- `LANGUAGETOOL_URL` : default `https://api.languagetool.org/v2/check`
- `MYMEMORY_EMAIL` : optional

## Endpoints

- `/health`
- `/proof?text=...`
- `/acceptability?text=...`
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
