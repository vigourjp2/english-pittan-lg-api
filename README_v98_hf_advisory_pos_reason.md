# v98 fix: no sentence hardcode, HF advisory, POS metadata reason gate

## Fixed issue
When the placed candidate was a normal beginner sentence such as `I am hungry today`, the external acceptability model could false-reject it. The UI then displayed a reason-exploration suggestion like `eating I am hungry today`, which is not a playable complete English sentence candidate.

## Root cause
1. HF acceptability rejection was used as a hard veto even after Link Grammar + LanguageTool had accepted the sentence.
2. Reason exploration verified candidate suggestions without client card POS metadata, so POS-based game gates could not reject malformed generated candidates.

## Changes
- HF acceptability reject is now advisory after Link Grammar + LanguageTool acceptance.
- No sentence-specific or word-specific rescue rules were added.
- Reason exploration receives `reasonWordMetaMap` from the existing `WORDS` card dictionary.
- Candidate verification now passes candidate `wordMeta` into the same game API gate.
- POS metadata gate rejects:
  - duplicated `advTime` cards
  - leading `ving/ing` fragment placed before an independent finite clause, e.g. generated suggestion shape `ving + subject + finite verb ...`
- Browser cache key bumped to `englishPittan.linkGrammarCache.v98.hfAdvisoryPosMetadataReason`.

## Checks
- `node --check server.js` passed.
- Extracted script from `index-english.html` and `node --check` passed.
