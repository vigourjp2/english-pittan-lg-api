# v28 HF credits exhausted handling

## 原因
ブラウザ確認で `/reason-result` の `error` に以下が出たため、HF_TOKEN は存在するが Hugging Face Inference Providers の月間 included credits / pre-paid credits が尽きている状態と判断する。

`You have depleted your monthly included credits to continue using Inference Providers...`

これは再試行しても成功しない非リトライ系エラー。

## 修正
- `depleted your monthly included credits`
- `monthly included credits`
- `pre-paid credits`
- `insufficient credits`
- `credits exhausted`
- `quota exceeded`
- `payment required`

を非リトライ扱いに追加。

該当時は retry せず `unavailable` に落とし、画面では「理由解析サービス未設定/利用不可」として表示する。

## 確認
`/health` の mode が `link-grammar-reason-job-v28-hf-credit-exhausted-no-retry` になっていること。
`/reason-selftest?text=I%20am` でエラー内容を確認すること。
