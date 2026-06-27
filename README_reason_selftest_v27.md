# v27 reason selftest / no-token no-retry

- HF_TOKEN 未設定時は理由解析 job をリトライせず `unavailable` にする。
- 401/403/404/invalid token/model not found 等の非リトライ系も即 `unavailable`。
- `/reason-selftest?text=I%20am` を追加し、理由解析サービス単体を手動確認できる。
- `/health` mode: `link-grammar-reason-job-v27-reason-selftest-no-token-no-retry`。
- フロントキャッシュキー v27。
