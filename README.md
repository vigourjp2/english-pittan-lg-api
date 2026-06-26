# English Pittan Link Grammar API

無料OSSの Link Grammar Parser を `link-parser` コマンド経由で呼ぶ最小API。

## ローカル確認

```bash
docker build -t english-pittan-lg .
docker run --rm -p 8787:8787 english-pittan-lg
curl -X POST http://localhost:8787/check -H 'content-type: application/json' -d '{"text":"You go to school."}'
```

## ゲーム側設定

`index-english.html` を開くURLに `lgapi` を付ける。

```text
https://game-aor.pages.dev/index-english.html?lgapi=https://YOUR-SERVICE.example.com
```

またはブラウザのコンソールで:

```js
setLinkGrammarApi('https://YOUR-SERVICE.example.com')
```

## 注意

Cloudflare Workers では C の `link-parser` を直接実行できないため、APIはコンテナ実行できる無料ホストかローカルPCに置く。
