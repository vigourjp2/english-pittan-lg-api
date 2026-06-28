# v66 board + hand candidate extraction

- API v65 dual HF gate is kept.
- Frontend board candidate extraction now enumerates all contiguous horizontal and vertical board segments, so vertical sentences such as `I / like / apples` are sent as `I like apples`, not only `like apples`.
- Reason context now includes current hand, selected hand card, and the just-played word before the fixed-slot hand is replenished.
- Selecting a hand card after a failed candidate triggers a lightweight API preview: previous NG candidate + selected hand word before/after. This allows hints like `I like` + hand `apples` => `I like apples` without local grammar hardcoding.
- No sentence-specific hardcoding: scoring and preview still use `/check-and-translate`.
