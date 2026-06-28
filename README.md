# v48 staged reason exploration / light-first candidate judgement

## Root cause
v47 removed candidate/time budgets, but it evaluated reason-exploration candidates with the full game checker. Since v43 the full checker includes the HF grammar classifier. As a result, one unfinished board could generate many candidates and each candidate could trigger Link Grammar + LanguageTool + HF. The reason job could stay in `running` / `理由解析中...` for a long time.

This was not a browser API failure. It was a server-side reason-exploration design bug: full HF judgement was being used too early and too often inside exploration.

## Fix
v48 changes reason exploration to a staged pipeline:

1. Generate the finite shortest-distance candidate set.
2. For every candidate, first run only the light local gate: Strict Link Grammar + LanguageTool.
3. If the light gate rejects the candidate, do not call HF for that candidate.
4. Only candidates that pass the light gate get the final full game gate, including HF grammar classifier.
5. Return the shortest accepted path if found.

## What this is not
This is not an `I like apples` hardcoded rule.

No code like this was added:

```js
if (text === 'I like' && hand.includes('apples')) return 'I like apples';
if (sentence === 'I like apples') ok = true;
```

The fix is generic: reason exploration uses the same candidate generation, but it stops spending HF calls on candidates that already fail the cheap Link Grammar / LanguageTool stage.

## Expected health
`/health` should show:

- `mode: link-grammar-plus-languagetool-error-gate-v48-staged-reason-exploration`
- `reasonExplorePolicy: staged-light-first-final-hf-only-on-promising-candidates-v48`

## Expected behavior
For board `I like` with hand containing `apples`, the reason job should finish and, if the candidate passes the final gate, return:

`I like apples`

For bad candidates such as `I like am`, v48 should reject them before spending HF where possible.


## v50 Browser URL Context Debug
DevTools Console不要化。GET URLの hand/board/deck を reason job context として受け取る。文法ルール追加ではない。
