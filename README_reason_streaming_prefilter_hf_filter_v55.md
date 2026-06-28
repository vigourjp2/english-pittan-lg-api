# v55 streaming prefilter + final HF display filter

## Root cause
v53/v54 made reason-display candidates stricter by checking display candidates with the same HF grammar gate used by `/check`.
That fixed wrong candidates such as `happy now should`, but the reason worker still timed out because it first spent external I/O on too many impossible fragments before reaching useful deeper candidates.

## Fix
v55 changes the reason pipeline, not the game grammar rules:

1. Build candidate operations as before.
2. Before external I/O, apply a cheap local *prefilter* that only rejects obvious fragments such as stranded modals (`happy now should`) or modal-start declarative fragments (`should Japanese now`).
3. Candidates that pass the prefilter still must pass Link Grammar + LanguageTool.
4. Display candidates still must pass the HF grammar gate.
5. The worker no longer waits to finish all light candidates before HF verification; it streams candidates and verifies light-accepted candidates in chunks.

The prefilter never accepts a sentence by itself. It only prevents obvious fragments from consuming Link Grammar/HF I/O.

## Not hardcoded
There is no special case for:
- `happy now should`
- `should Japanese now`
- `I am Japanese now`

The modal handling is category-level: modal auxiliaries cannot be stranded or start a declarative display candidate without a subject before them.

## Expected health
`/health` should show:

- `mode: link-grammar-plus-languagetool-error-gate-v55-streaming-prefiltered-reason-display-hf-filter`
- `reasonExplorePolicy: light-first-reason-plus-v55-streaming-prefilter-plus-final-hf-display-filter`
- `reasonDisplayHfFilter: true`
- `reasonLocalPrefilterEnabled: true`
