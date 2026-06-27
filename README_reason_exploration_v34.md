# v34 Strict Link Grammar Oracle Exploration / No Hardcoding

## 方針

- 成立判定は Strict Link Grammar の完全 parse のみ。
- 理由は「探索で実際に成立した経路」だけを表示。
- JS/API側で `I` / `am` / `is` / `like` 等の文法別 if 文を持たない。
- API判定前に自動大文字化・3単現s補正・語の置換をしない。
- 探索候補もカードの実値をそのまま Link Grammar に投げる。

## 確認

- `/health` の mode: `link-grammar-strict-only-v34-oracle-exploration-no-hardcode`
- `I am happy` は `/check?text=I%20am%20happy` で `ok:true / gameOk:true`
- `am happy` や `happy am` は、Link Grammarが本当に通した場合だけ候補として出る。

## 注意

この版は理由文そのものを文法テンプレで作らず、探索結果を説明する。
