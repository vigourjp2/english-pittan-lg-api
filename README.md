# English Pittan Link Grammar API

Render Web Service用の Link Grammar 実行ラッパーです。

## 方針

- 英文成立判定は独自文法ロジックで作らない
- `/check` と `/check-and-translate` は Link Grammar Parser の strict parse をそのまま採用
- `link-parser` は `-null=0` と `-islands-ok=0` で実行
- API側は `linkages > 0` かつ `No complete linkages found` なしのときだけ `ok:true`
- LanguageTool は補正候補の適用だけに使う
- 翻訳は `ok:true` の文だけ実行

## Endpoints

- `GET /health`
- `GET|POST /proof?text=...`
- `GET|POST /translate?text=...`
- `GET|POST /check?text=...`
- `GET|POST /check-and-translate?text=...`

## Deploy

Render の Docker Web Service として、この4ファイルをリポジトリのルートに置いてください。

- `server.js`
- `package.json`
- `Dockerfile`
- `README.md`
