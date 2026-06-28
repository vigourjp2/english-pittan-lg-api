# v59 bounded external classifier window

## Why
v58 still timed out on `Japanese now` because the reason job was spending time before HF: it checked too many generated candidates with Link Grammar/LanguageTool sequentially.

## Change
- Remove/avoid HF Chat.
- Keep `reasonLocalPrefilterEnabled:false`.
- Do not use modal/be/verb word-list hardcoding.
- Before LG/LT, rank operations only by non-grammar UI/search properties:
  - shortest edit depth (the caller runs depth 1 then depth 2)
  - hand before board before deck
  - action group
  - sentence length proximity for display stability
  - generation order
- Only the bounded display window is checked with LG/LT in parallel.
- LG/LT-passing candidates are then checked by the existing external HF classifier (`abdulmatinomotoso/English_Grammar_Checker`).

## Health markers
- mode: `link-grammar-plus-languagetool-error-gate-v59-bounded-external-classifier-window`
- reasonExplorePolicy: `bounded-light-window-plus-external-classifier-display-window-v59`
- reasonExternalShallowJudge: `hf-classifier-bounded-display-window-v59`
- reasonLocalPrefilterEnabled: `false`
- reasonLightCandidateWindowPerDepth: default `12`
