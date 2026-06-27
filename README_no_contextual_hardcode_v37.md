# v37 no contextual hardcode

- Removed phrase-specific contextual short answer classification.
- `I am` is accepted only because Strict Link Grammar returns fullParse=true/linkages>0/nullCount=0.
- No `I am` => Japanese hint override. Translation is delegated to /translate when requested.
- No HF.
- Reason exploration remains Strict Link Grammar oracle based.

Health mode: `link-grammar-strict-only-v37-no-contextual-hardcode`
