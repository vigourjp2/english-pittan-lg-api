# English Puzzle API v43 - HF Grammar Classifier Gate

## Purpose
v43 promotes the verified lightweight grammar classifier into the real `/check` gate.

The gate order is:

1. exact card text only, no autocorrection
2. Strict Link Grammar full parse
3. LanguageTool error detection only, no replacement application
4. HF grammar classifier only when 1-3 pass

## Production HF model

Default model:

```txt
abdulmatinomotoso/English_Grammar_Checker
```

Verified by v42.3 diagnostics:

```txt
I am happy              -> LABEL_1 / acceptable
The cat is sleeping     -> LABEL_1 / acceptable
eating am happy         -> LABEL_0 / unacceptable
walking am happy        -> LABEL_0 / unacceptable
he am happy             -> LanguageTool blocking + LABEL_0
```

## Safety limits

Environment variables:

```txt
ACCEPTABILITY_HF_ENABLED=true
ACCEPTABILITY_HF_MODEL=abdulmatinomotoso/English_Grammar_Checker
ACCEPTABILITY_HF_DAILY_MAX=80
ACCEPTABILITY_HF_FAIL_CLOSED=false
ACCEPTABILITY_HF_CACHE_MAX=2000
```

The HF classifier is called only when Strict Link Grammar and LanguageTool already pass.
Results are cached per exact sentence + model.
When HF is unavailable or the daily limit is reached, the default is fail-open so the game does not break.
Set `ACCEPTABILITY_HF_FAIL_CLOSED=true` only if you want to reject sentences whenever HF cannot be checked.

## Confirmation URLs

```txt
/health
/check?text=I%20am%20happy
/check?text=The%20cat%20is%20sleeping
/check?text=eating%20am%20happy
/check?text=walking%20am%20happy
/check?text=he%20am%20happy
/diagnose?text=walking%20am%20happy
/diagnose-acceptability?text=walking%20am%20happy&model=abdulmatinomotoso/English_Grammar_Checker
```

Expected:

```txt
I am happy              -> ok true
The cat is sleeping     -> ok true
eating am happy         -> ok false, reasonSource hf-grammar-classifier-gate
walking am happy        -> ok false, reasonSource hf-grammar-classifier-gate
he am happy             -> ok false, reasonSource languagetool-error-gate
```
