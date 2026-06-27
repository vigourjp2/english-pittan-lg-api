# v36: contextual short answer classification

## What changed

- `I am` remains accepted when Strict Link Grammar fully parses it.
- It is classified as a native-like contextual short answer, not an ordinary standalone sentence.
- The Japanese display is changed from the misleading partial translation `私は` to `私はそうです`.
- The image panel is skipped for contextual short answers, because `I am` has no concrete standalone image.
- The GOOD effect can still appear, but the log/kind shows `短い返事文`.

## Acceptance gate

Acceptance is still based on Strict Link Grammar:

- `fullParse=true`
- `strictLinkGrammar=true`
- `linkages>0`
- `nullCount=0`

## Health mode

Expected `/health` mode:

```txt
link-grammar-strict-only-v36-contextual-short-answer
```

## Example

`/check-and-translate` for `I am` should return:

```json
{
  "ok": true,
  "gameOk": true,
  "sentenceType": "contextual_short_answer",
  "ja": "私はそうです",
  "acceptability": {
    "displayKind": "短い返事文",
    "utteranceType": "contextual_short_answer",
    "hfUsed": false
  }
}
```
