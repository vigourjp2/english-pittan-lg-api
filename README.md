# English Pittan API

英文判定をローカル品詞表ではなく、外部/API系の裁定に寄せた版。

## Pipeline

1. LanguageTool APIで文法校正・3単現などの明確な置換を自動適用
2. Link Grammar Parserで構文解析
3. LanguageToolの文法指摘が残っていないことを確認
4. OK文だけMyMemoryで日本語訳

## Endpoints

- `/health`
- `/proof?text=he%20like%20apples`
- `/check?text=I%20like%20you`
- `/check-and-translate?text=I%20like%20you`
- `/translate?text=I%20am%20big`

## Render

- Runtime: Docker
- Root Directory: empty
- Dockerfile Path: Dockerfile
- Instance Type: Free

## Env

- `LANGUAGETOOL_URL` optional. Use self-host LanguageTool if needed.
- `LANGUAGETOOL_ENABLED=0` disables LanguageTool.
- `MYMEMORY_EMAIL` optional.
