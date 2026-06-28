# v53 reason display HF filter

## Root cause
v51 fixed reason job timeouts by removing HF network calls from reason exploration. That made the worker fast, but it also allowed candidates that only passed Strict Link Grammar + LanguageTool to be displayed. Link Grammar sometimes accepts unnatural/invalid word orders such as `happy now should` and `should Japanese now`; the production `/check` endpoint later rejects them with the HF grammar classifier.

## Fix
v53 keeps the cheap first stage, but adds a final display filter:

1. Build finite one-step/two-step candidate sentences from the current board/hand/deck context.
2. Run Strict Link Grammar + LanguageTool as a light oracle.
3. Only for candidates that pass the light oracle, run the same HF grammar classifier gate used by `/check`.
4. Display only candidates that pass the final HF display filter.
5. If HF is slow/unavailable for a candidate, suppress that candidate rather than showing a false positive.

This is not a special case for `should`, `happy now should`, `I am happy`, or `I like apples`. It aligns reason suggestions with the real game acceptance gate.

## Expected health

`/health` should include:

- `mode: link-grammar-plus-languagetool-error-gate-v53-reason-display-hf-filter`
- `reasonExplorePolicy: light-first-reason-plus-final-hf-display-filter-v53`
- `reasonDisplayHfFilter: true`
- `reasonFinalHfTimeoutMs: 7000` by default

## Browser API checks

Production gate rejects bad should candidates:

- `/check?text=happy%20now%20should` -> `gameOk:false`
- `/check?text=should%20Japanese%20now` -> `gameOk:false`

Reason context should not display candidates rejected by that same HF grammar gate.
