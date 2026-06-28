# English Pittan API/UI v53

v53 is based on v52 and fixes reason suggestion quality.

Main change: reason exploration remains light-first, but candidates are no longer displayed after only Strict Link Grammar + LanguageTool. Before a suggestion is shown, it is checked by the same HF grammar classifier gate used by the production `/check` endpoint.

This prevents false suggestions such as `happy now should` and `should Japanese now`, which Link Grammar can parse but the real game gate rejects.

See `README_reason_display_hf_filter_v53.md`.
