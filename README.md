# English Pittan Link Grammar API

RenderなどのDocker Web Serviceで動かす英文判定API。

## エンドポイント

- `/health` 起動確認
- `/check?text=You%20go%20to%20school.` Link Grammar + LanguageTool + ゲーム用妥当性チェック
- `/proof?text=I%20am%20happy%20today%20can%20see.` LanguageTool校正APIの結果確認
- `/translate?text=I%20am%20big.` MyMemoryで日本語訳
- `/check-and-translate?text=I%20am%20big.` 判定OKなら訳も返す

## 重要な修正

- Harperを成立判定に使わない
- Link GrammarのOKだけで通さず、LanguageToolの文法チェックも通す
- `I am happy today can see` のような無接続の述語連結は汎用ガードでNG
- `I like big` のような「他動詞 + 形容詞単体目的語」を汎用NG
- 日本語訳は単語置換ではなく翻訳APIへ委譲
- 主語が三人称単数現在のときは `like -> likes`, `go -> goes`, `have -> has` などに正規化

## 環境変数

- `MYMEMORY_EMAIL` 任意。MyMemoryの無料上限緩和用メール
- `LANGUAGETOOL_ENABLED` `0` にするとLanguageToolチェックを停止
- `LANGUAGETOOL_URL` 任意。自前LanguageToolサーバを使う場合

## Render設定

- Runtime: Docker
- Branch: main
- Root Directory: 空欄
- Dockerfile Path: Dockerfile
- Instance Type: Free
