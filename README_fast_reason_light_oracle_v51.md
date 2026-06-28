# v51 fast reason light oracle

## Root cause
v50 accepted browser query context, but reason jobs still timed out when a context contained hand/deck candidates.
The timeout happened because reason exploration called the full final judgement for each promising candidate, and the final judgement can call the HF acceptability model. Candidate-by-candidate HF network calls are too slow for a background reason job.

## Fix
Reason exploration now uses Strict Link Grammar + LanguageTool as a fast light oracle and intentionally does not call HF network during reason exploration.
The normal `/check` game judgement still uses HF as before.

This is not a candidate-count budget and not a sentence-specific hardcode. It is a separation of:

- `/check`: final game gate, HF enabled
- reason exploration: fast explanation candidate search, HF network skipped

## Also changed
When a successful reason candidate is found at the current shortest depth, the job returns immediately instead of continuing to evaluate unrelated candidates.
This is not a search cap; it avoids doing more external I/O after an explanation has already been found.

## Health expected
`/health` should show:

- `mode: link-grammar-plus-languagetool-error-gate-v51-fast-reason-light-oracle`
- `reasonExplorePolicy: fast-light-oracle-for-reason-hf-not-called-in-reason-v51`
- `reasonHfNetworkDisabled: true`
- `reasonJobs.timeoutMs: 30000`
- `reasonJobs.candidateTimeoutMs: 2500`

## Browser test
Open:

`/reason-context-test?text=am%20happy&hand=I,we,can,like,right,apples,today&deck=I,you,we,he,she,am,are,is,like,likes,happy,apples,today`

Then open the returned `/reason-result?id=...`.

Expected: success with suggestion such as `I am happy`, not timeout.
