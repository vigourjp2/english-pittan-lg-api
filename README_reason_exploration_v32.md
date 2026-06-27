# v32: Strict Link Grammar 探索理由

## 方針
- 成立判定は Strict Link Grammar の完全 parse のみ。
- HF / 外部AI / 月間クレジット依存は使わない。
- 不成立理由は、手書き文法テンプレではなく、実際に候補カードを足す・置換・削除・並べ替えして Strict Link Grammar が成立する最短経路を探索して作る。

## 表示例
- `I am` + 手札/候補 `happy` が成立する場合: `手札の「happy」を後ろに置くと英文になります。候補: I am happy`
- `I is happy` で置換成立する場合: `「is」を候補カードの「am」に変えると英文になります。候補: I am happy`
- 順序変更で成立する場合: `カードの順番を変えると英文になります。候補: I am happy`

## API確認
- `/health` の mode: `link-grammar-strict-only-v32-exploration-reasons`
- `/reason-explain?text=I%20am` は候補カードなしなので限定結果。ゲーム画面からの `/check-and-translate` では手札/デッキ候補を渡す。
