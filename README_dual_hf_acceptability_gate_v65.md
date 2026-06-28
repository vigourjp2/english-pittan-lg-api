# v65 dual HF acceptability gate

Purpose: fix cases where the primary HF grammar classifier accepts modal-inversion fragments such as `happy today he must`.

What changed:
- `/check` still uses Strict Link Grammar and LanguageTool first.
- Primary HF classifier remains `abdulmatinomotoso/English_Grammar_Checker`.
- If the primary classifier accepts, a secondary external classifier is used as a veto:
  - default: `textattack/roberta-base-CoLA`
  - default reject threshold: confidence >= `0.70`
- If either classifier rejects with a usable verdict, `gameOk:false`.
- If the secondary model is unavailable, the gate fails open rather than breaking the game.

Not hardcoded:
- No sentence-specific check for `happy today he must`.
- No word-specific rejection for `must` or `should`.
- The decision is based on an additional external HF classifier result.

Benchmark basis:
- OK: `I am happy today`, `I must be happy today`, `I am Japanese now`, `I like Japanese now`.
- NG: `happy today he must`, `happy now should`, `should Japanese now`, `walking am happy`, `eating am happy`, `he am happy`.

Env knobs:
- `ACCEPTABILITY_HF_SECONDARY_ENABLED=true|false`
- `ACCEPTABILITY_HF_SECONDARY_MODEL=textattack/roberta-base-CoLA`
- `ACCEPTABILITY_HF_SECONDARY_REJECT_MIN_CONF=0.70`
