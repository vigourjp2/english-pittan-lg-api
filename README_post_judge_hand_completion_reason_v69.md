# v69 persistent hand completion reason

- Fixes v68 still not updating after `I like` when `apples` is in hand.
- Stores the player index and hand snapshot at the failed placement moment, so `nextTurn()` does not make hand completion inspect the wrong player.
- Rebuilds board line texts directly from the current board if `lastScanRejects` is stale or empty.
- Adds a low-frequency persistent retry while a fail reason is displayed.
- No sentence-specific hardcoding. Final acceptance remains `/check-and-translate` with the dual HF gate.
