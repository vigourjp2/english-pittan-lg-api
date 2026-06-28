# v47 exhaustive reason exploration / no search budget

## Root cause
v46 changed the order of reason exploration so `add-right` was tried earlier. That fixed one visible case, but it was still a priority tweak. The real bug was that reason exploration used arbitrary `maxChecks`, `maxMs`, and `maxSuggestions`, so valid completions could be missed depending on ordering.

## Fix
v47 removes the search-budget style behavior from reason exploration.

- no `REASON_EXPLORE_MAX_CHECKS` cutoff
- no `REASON_EXPLORE_MAX_MS` cutoff
- no suggestion-count cutoff during exploration
- generate all finite 1-step candidates from board/hand/deck context
- evaluate the whole 1-step level
- only if no 1-step result exists, evaluate finite 2-step hand additions
- preserve exact card casing when building candidate sentences
- keep judgement delegated to the normal game oracle: Strict Link Grammar + LanguageTool + HF grammar classifier

This is not a hardcoded `I like apples` rule. The test case is only a regression check that the generic finite exploration can find a normal object completion when the card exists in hand.

## Expected health
`/health` should show:

- `mode: link-grammar-plus-languagetool-error-gate-v47-exhaustive-reason-exploration`
- `reasonExplorePolicy: exhaustive-shortest-distance-no-search-budget-v47`

## Expected behavior
If board is `I like` and hand contains `apples`, the reason job should find:

`I like apples`

because all 1-card hand additions are evaluated, not because the phrase is special-cased.
