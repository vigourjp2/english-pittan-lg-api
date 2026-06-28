# v83 reason candidate false-positive fix

## 原因
不成立理由の補完候補は `explainByExploration()` で「手札を前/後ろへ足す」「置換する」候補を作り、`evaluateGameTextLightForReason()` の Strict Link Grammar + LanguageTool 軽量判定を通った最初の候補を表示していた。

しかし Strict Link Grammar は構文解析器であり、学習ゲームの最終英文正誤オラクルとしては false positive が出る。`I like they` のような代名詞格が不自然な候補でも full parse できる場合があり、LanguageTool がブロックしなければ `gameOk` 扱いになり、理由表示に「手札の they を後ろに置くと英文になります」と出てしまう。

## 修正
- 理由表示用の「完成候補」は、Strict Link Grammar + LanguageTool を通ったあと、さらに外部 acceptability classifier で明確に acceptable と判定された場合だけ表示する。
- HF_TOKEN が無い、または外部分類器が利用不可の場合は、理由表示の完成候補だけ fail-closed にする。ゲーム本体の判定経路は変更しない。
- 単語別・文別のハードコードは追加していない。`they` や `like` の専用ルールは入れていない。

## 期待動作
- `I like` の不成立理由で `I like they` を完成候補として表示しない。
- 外部分類器が使える環境では `I like apples` など、外部分類器も acceptable とした候補だけ表示する。
- 外部分類器が無い環境では、誤候補を出すより「理由解析不可/保留」に倒す。
