# v50 Browser URL Context Debug

DevTools Console を使わせないための修正。

## 目的

- GET URL だけで reasonBoardCandidates / reasonHandCandidates / reasonDeckCandidates を渡せるようにする。
- /check と /check-and-translate の GET でも hand/board/deck query を読む。
- /reason-context-test を追加して、ブラウザのアドレスバーだけで理由探索コンテキスト受け渡しを確認できる。

## これは文法ハードコーディングではない

I like apples 専用ルールは入れていない。
追加したのは URL パラメータを配列に変換して reason job に渡す入力経路だけ。

## 確認URL例

```
/health
```

期待: mode が v50-browser-context-debug。

```
/reason-context-test?text=am%20happy&hand=I,we,can,like,right,apples,today&deck=I,you,we,he,she,am,are,is,like,likes,happy,apples,today
```

返却の contextReceived.reasonHandCandidates に手札が入ることを見る。
その後 next の /reason-result?id=... を開く。

```
/check?text=am%20happy&hand=I,we,can,like,right,apples,today&deck=I,you,we,he,she,am,are,is,like,likes,happy,apples,today
```

/check GET でもコンテキストを読む。
