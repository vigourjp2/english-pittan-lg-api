# English Pittan API/frontend v51

v51 fixes the v50 timeout where reason-context-test accepted hand candidates but the reason job failed after 12000ms.

The reason job no longer calls the HF acceptability network for every candidate. It uses Strict Link Grammar + LanguageTool as a fast reason oracle, while the normal game `/check` route still uses the full HF gate.

See `README_fast_reason_light_oracle_v51.md`.
