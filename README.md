# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Ploveooo/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Ploveooo/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar that ranks pre-token protocols by implied value (TVL, 7-day growth, age, capital velocity and chain spread) and ships a ranked board, a sortable dashboard and a 7-step farm plan per protocol.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=b2qhqcdv&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

## What it does

- Reads a DeFiLlama snapshot (`/input/snapshot.json`, 758 protocols, 40 on the watchlist) and ranks every rankable pre-token protocol by implied value: `60 · TVL^0.72 · growth · maturity · velocity · chains`.
- Writes `/output/board.json` (203 rows: all 40 watchlist slugs plus 163 more pre-token protocols, ranks 1–203, implied values strictly decreasing), `/output/data.js`, the dashboard and three screenshots, and `/output/dossier.json`.
- The dashboard (`dashboard/`, 21 KB, no network calls) has a sortable board, search, category/chain filters, watchlist-only and early-only toggles, a per-protocol detail view with a model-breakdown chart and the 7-step farm plan, a Live tab (24 live-token protocols at market cap, never ranked) and a Model tab stating the formula.
- Farm plans are concrete (fresh wallet, a category-specific primary action with capital and chain, a complementary second action, a weekly qualifying action, a hold period, claim-only-from-the-official-link, a farm log and an exit plan), each with cost and time.
