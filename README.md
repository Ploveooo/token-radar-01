# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Ploveooo/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Ploveooo/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar that ranks pre-token protocols by implied value and ships a ranked board, a sortable dashboard and a 7-step farm plan per protocol. Model radar-3: the price is calibrated on the market, not guessed — each category's multiplier comes from the median market-cap-per-TVL of that category's live-token protocols in the same snapshot, and every row carries a P25–P75 calibration band.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=b2qhqcdv&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

## What it does

- Reads a DeFiLlama snapshot (`/input/snapshot.json`, 758 protocols, 40 on the watchlist) and ranks every rankable pre-token protocol by implied value: `60 · TVL^0.72 · category · growth · maturity · velocity · chains`.
- Writes `/output/board.json` (203 rows: all 40 watchlist slugs plus 163 more pre-token protocols, ranks 1–203, implied values strictly decreasing, $409.9M down to $2.1M), `/output/data.js`, the dashboard and three screenshots, and `/output/dossier.json`.
- The dashboard (`dashboard/`, ~25 KB, no network calls) has a sortable board with a P25–P75 range column, search, category/chain filters, watchlist-only and early-only toggles, a per-protocol detail view with a model breakdown (including the category multiplier and the band) and the 7-step farm plan, a Live tab (24 live-token protocols at market cap, never ranked) and a Model tab with the calibration table and the backtest.
- Farm plans are concrete (fresh wallet, a category-specific primary action with capital and chain, a complementary second action, a weekly qualifying action, a hold period, claim-only-from-the-official-link, a farm log and an exit plan), each with cost and time; the position size scales with the protocol's implied value, and gas is priced by chain (Ethereum is dear, the rest cheap).

## The calibration (radar-3)

Fitted at run time from the snapshot's own 128 live-token protocols (market median mcap/TVL 0.2138). A category prices itself when it has at least 5 live protocols; otherwise it falls back to the market median (×1.00).

| Category | Live n | Median mcap/TVL | Multiplier |
| --- | --- | --- | --- |
| Basis Trading | 7 | 0.6544 | ×3.06 |
| Dexs | 11 | 0.3424 | ×1.60 |
| RWA | 9 | 0.2748 | ×1.29 |
| Yield | 9 | 0.1914 | ×0.90 |
| Lending | 15 | 0.1324 | ×0.62 |
| Bridge / CEX / Canonical Bridge / Liquid Staking | 6–9 | 0.0406–0.7464 | ×0.19–×3.49 (not ranked) |

The walk-forward check, also run by the program on the same snapshot: category prices fitted on the 52 live protocols listed before 2024-06-01, tested on the 43 listed after, predicting their market caps. Median log error 1.40 with the calibration against 1.49 without it; 37% of the test set lands within 2× of its actual market cap, against 35% uncalibrated. The calibration helps a little, not a lot — the market prices loosely, which is why every row carries its P25–P75 range instead of a single number.
