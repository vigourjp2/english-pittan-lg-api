# v54 parallel reason display HF filter

## Root cause
v53 fixed wrong `should` suggestions by applying the same HF grammar gate used by `/check` before displaying reason suggestions.
However, v53 verified light candidates one by one. If several Link Grammar-accepted but HF-rejected candidates appeared first, the reason job could spend the whole 30 seconds waiting on sequential HF checks and time out.

## Fix
v54 keeps the same correctness rule: suggestions shown to the user must pass Link Grammar + LanguageTool + HF grammar gate.
But final HF verification for display candidates is now performed in parallel chunks.

This is not a candidate-count shortcut and not a sentence-specific rule. The candidate set is still generated generically; the change is only the I/O scheduling of the final HF display filter.

## Expected health
- mode: link-grammar-plus-languagetool-error-gate-v54-parallel-reason-display-hf-filter
- reasonExplorePolicy: light-first-reason-plus-parallel-final-hf-display-filter-v54
- reasonDisplayHfFilter: true
- reasonFinalHfParallel: 6

## Regression checks
- `happy now should` should be rejected by `/check` and should not be displayed as a reason suggestion.
- `should Japanese now` should be rejected by `/check` and should not be displayed as a reason suggestion.
- `am happy` with hand `I` should still suggest `I am happy`.
- `Japanese now` with hand/deck context should finish instead of timing out.
