# v52 frontend reason context payload fix

## Root cause
v51 API was working: browser URL tests showed hand/deck context was accepted and reason exploration returned "I am happy" quickly.

The remaining bug was frontend-side. Some game judgement paths called `linkGrammarEvaluate()` and sent only:

```json
{"text":"...","words":[...]}
```

That means the API could create a reason job, but `reasonHandCandidates`, `reasonBoardCandidates`, and `reasonDeckCandidates` were empty for that job. The server then had no materials to suggest completions.

## Fix
`linkGrammarEvaluate()` now attaches the same `reasonCandidateContext()` payload as the main scan path:

- `reasonBoardCandidates`
- `reasonHandCandidates`
- `reasonDeckCandidates`

The API text is still case-preserved; `I` is not lowercased.

## Not hardcoding
No special case for `am happy`, `I am happy`, `I like`, or `I like apples` was added. This only fixes frontend-to-API context delivery.

## Cache
The frontend Link Grammar cache key was bumped to `englishPittan.linkGrammarCache.v52.frontendReasonContext` so old pending/empty-context reject cache is not reused.
