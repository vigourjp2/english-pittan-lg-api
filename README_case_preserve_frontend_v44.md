# v44 case-preserve frontend fix

## Root cause
Frontend converted placed card words with lowerWords() before building API text.
So board cards `I am happy` were sent to the API as `i am happy`.
Strict Link Grammar rejects lowercase `i`, causing a false NG in the game while direct API `/check?text=I%20am%20happy` succeeds.

## Fix
- Preserve original card casing when creating `text` for `/check-and-translate` and `/check`.
- Use lowercase only for cache keys and local POS checks.
- Bump frontend cache key to `englishPittan.linkGrammarCache.v44.casePreserve` to avoid old lowercase reject cache.
- No API grammar logic change. v43 HF grammar gate remains as-is.

## Expected
- Board `I` + `am` + `happy` sends `I am happy`, not `i am happy`.
- Board candidate display should no longer show `i am happy`.
- `I am happy` should become 成立.
