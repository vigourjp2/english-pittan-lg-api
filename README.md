# English Pittan Link Grammar API

RenderなどのDocker Web Serviceで動かす英文判定API。

## エンドポイント

- `/health` 起動確認
- `/check?text=You%20go%20to%20school.` Link Grammar + ゲーム用妥当性チェック
- `/translate?text=I%20am%20big.` MyMemoryで日本語訳
- `/check-and-translate?text=I%20am%20big.` 判定OKなら訳も返す

## 重要な修正

- Harperを成立判定に使わない
- `I like big` のような「他動詞 + 形容詞単体目的語」を汎用NG
- 日本語訳は単語置換ではなく翻訳APIへ委譲

## Render設定

- Runtime: Docker
- Branch: main
- Root Directory: 空欄
- Dockerfile Path: Dockerfile
- Instance Type: Free
