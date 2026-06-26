# English Pittan Link Grammar API

Render Web Service用の英語判定APIです。

## Endpoints

- `GET /health`
- `GET /proof?text=...`
- `GET /translate?text=...`
- `GET /check?text=...`
- `GET /check-and-translate?text=...`

## Pipeline

1. LanguageTool で文法補正・校正
2. Link Grammar Parser で構文解析
3. Sentence mode で「独立した英文」か確認
   - `apples they see` のような名詞句/関係節断片をNG
   - `I am happy today can see` のような無接続run-onをNG
   - `I am new books` のような be補語崩れをNG
4. OK文だけ翻訳APIへ送信

## Deploy

Render の Docker Web Service としてこの4ファイルをルートに置いてください。
