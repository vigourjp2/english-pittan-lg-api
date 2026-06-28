# v42.1 CoLA label fix diagnostic only

## Purpose
Fix v42 diagnostic label interpretation for `textattack/roberta-base-CoLA`.

Confirmed by manual tests:
- `I am happy` -> top `LABEL_1` -> acceptable
- `The cat is sleeping` -> top `LABEL_1` -> acceptable
- `eating am happy` -> top `LABEL_0` -> unacceptable

## Changes
- `/diagnose-acceptability` defaults to `textattack/roberta-base-CoLA` only.
- v42 bug fixed: classification output contains both `LABEL_0` and `LABEL_1`; v42 scanned all labels and always found `LABEL_0`. v42.1 decides from `top.label`.
- Mapping: `LABEL_1=acceptable`, `LABEL_0=unacceptable` for `textattack/roberta-base-CoLA`.
- `/check` is still not changed. This is diagnostic only.

## Check URLs
- `/health`
- `/diagnose-acceptability?text=I%20am%20happy`
- `/diagnose-acceptability?text=The%20cat%20is%20sleeping`
- `/diagnose-acceptability?text=eating%20am%20happy`
- `/diagnose-acceptability?text=walking%20am%20happy`
