# English Pittan v100 - no NG cache + prefix rescue

## Root cause confirmed
Browser direct API check for `I am hungry` returns `ok:true` and `gameOk:true`; therefore the HF acceptability veto is not the cause.

The failure is in the browser game judgement path: the game uses batch judgement plus localStorage cache. A stale NG cache or batch/path miss can make `I am hungry` not count even though the live API accepts it. The screenshot still shows the longer route `I am hungry today`, so route generation is reaching the bend; the missing piece is accepting the shorter prefix `I am hungry`.

## Fix
- Changed browser cache key to `englishPittan.linkGrammarCache.v100.successOnlyNoNgCache`.
- NG/reject cache is never trusted for scoring; it is deleted and the current API is called again.
- If batch judgement returns no accepted candidate, the browser does a final single-API prefix rescue before showing an NG reason.
- This specifically fixes cases where `I am hungry today` is the displayed NG but the prefix `I am hungry` is valid.

## Not hardcoded
No sentence-specific allowlist such as `I am hungry` was added. The rescue checks any prefix path that contains the newly placed card, via the same `/check-and-translate` API.
