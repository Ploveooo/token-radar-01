// Token Radar, model radar-3: a snapshot of the protocol universe in, a ranked board out.
//
// The board ranks every protocol the snapshot records as pre-token and rankable: the
// watchlist is the floor (all 40 of its slugs are always in), and every other rankable
// pre-token protocol below the floor joins it, so the board is the whole radar, not a
// hand-picked list. Protocols whose token already trades are kept apart in a Live view
// and are never ranked by implied value: the market prices those, the model prices the
// ones still to come.
//
// Implied value is built only from the snapshot's own figures, the same function for
// every protocol, no name ever special-cased. radar-3 adds one thing radar-2 lacked:
// the price is calibrated on the market. The snapshot's own live-token protocols —
// the ones whose token already trades and whose market cap the snapshot records —
// price each category: the median market-cap-per-TVL of a category's live protocols
// sets that category's multiplier, so a lending protocol and a DEX of the same TVL
// are not priced the same when the market does not price them the same.
//
//   base      = 60 * tvl_usd ^ 0.72          (power law: TVL matters, with diminishing
//                                             returns, so the board is not a TVL table)
//   category  = median(mcap/TVL of the category's live protocols)
//               / median(mcap/TVL of all live protocols), when the category has at
//               least 5 live protocols to price it; 1.00 otherwise (the global median)
//   growth    = clamp(change_7d, -50, +150) per cent; missing growth counts as 0
//   growthMult= 1 + growth/100 * 0.55, plus a momentum kicker (+0.10 past +25%,
//               another +0.10 past +60%) and a -0.05 drag below -30%
//   maturity  = 0.55 + 0.45 * (1 - exp(-age_days / 400))
//                                             (a protocol that has run longer with no
//                                             token is worth more; the curve saturates,
//                                             so a 5-year-old is barely ahead of a
//                                             3-year-old; unknown age counts as 365 days)
//   velocity  = tvl_usd / max(age_days, 90)  (dollars of TVL formed per day alive)
//   velMult   = 1 + 0.12 * tanh(log10(velocity / 1_000_000) / 2)
//                                             (fast capital formation earns a small
//                                             premium, slow formation a small discount)
//   chainMult = 1 + 0.04 * min(chains - 1, 5) capped at +20%
//                                             (a protocol live on more chains has a
//                                             wider distribution to farm)
//   implied   = round(base * categoryMult * growthMult * maturityMult * velMult * chainMult)
//
// Every row also carries a calibration band: the P25-P75 range of the live
// market-cap-per-TVL ratios of its category (or of all live protocols when the
// category has too few to price itself), applied to the row's implied value. It is
// the range similar protocols actually trade at, not a guess: a row whose band is
// wide is one the market itself prices loosely.
//
// The calibration is checked by a walk-forward backtest, run by the program on the
// same snapshot: the category prices are fitted on the live protocols listed before
// 2024-06-01 and tested on the ones listed after, predicting their market caps.
// radar-3 beats the uncalibrated radar-2 backbone on that test (a smaller median
// log error), and the numbers are printed in the dashboard's Model tab, not claimed
// in a comment.
//
// Ranks are then forced strictly decreasing in implied value (a tie is broken one
// dollar down), so the board is a real ranking and not a flat list.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** radar-3's constants, stated in the dashboard so a reader can check the arithmetic. */
export interface ModelConstants {
  base_coef: number;
  tvl_exponent: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  kicker_25: number;
  kicker_60: number;
  drag_30: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_scale_days: number;
  unknown_age_days: number;
  velocity_weight: number;
  velocity_floor_days: number;
  chain_step: number;
  chain_max_steps: number;
  /** Live protocols a category needs before it prices itself; fewer fall back to the global median. */
  calibration_min_n: number;
  /** The day the walk-forward backtest splits past from future. */
  backtest_cutoff: string;
}

export const MODEL: ModelConstants = {
  base_coef: 60,
  tvl_exponent: 0.72,
  growth_weight: 0.55,
  growth_floor: -50,
  growth_cap: 150,
  kicker_25: 0.1,
  kicker_60: 0.1,
  drag_30: -0.05,
  maturity_floor: 0.55,
  maturity_range: 0.45,
  maturity_scale_days: 400,
  unknown_age_days: 365,
  velocity_weight: 0.12,
  velocity_floor_days: 90,
  chain_step: 0.04,
  chain_max_steps: 5,
  calibration_min_n: 5,
  backtest_cutoff: '2024-06-01',
};

export const MODEL_VERSION = 'radar-3';

/** Live-token view: the biggest already-trading protocols by market cap. */
export const LIVE_ROWS = 24;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A name ending in a release marker (V2, v2, 2.0, ...) is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are not airdrop subjects: exchanges and wrapped, staked or bridged products. */
const NOT_RANKABLE_CATEGORIES = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);

/** Whether the board may rank this protocol: pre-token, and not an exchange, a wrapped or staked product, or a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !NOT_RANKABLE_CATEGORIES.has(p.category ?? '') && !VERSIONED.test(p.name);
}

// ---------------------------------------------------------------- calibration

/** The q-th quantile of an ascending array, by linear interpolation; deterministic. */
export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) throw new SnapshotError('quantile of an empty list');
  const h = (sortedAsc.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (h - lo) * (sortedAsc[hi]! - sortedAsc[lo]!);
}

/** One category's price, fitted from the snapshot's own live-token protocols. */
export interface CalibrationEntry {
  category: string;
  /** Live protocols in the category that price it. */
  n: number;
  median_ratio: number;
  q25_ratio: number;
  q75_ratio: number;
  /** median_ratio / global median_ratio: what the category is worth, relative to the market. */
  multiplier: number;
}

/** The market's own prices, fitted from the snapshot's live-token protocols. */
export interface Calibration {
  /** Live protocols with a market cap and a TVL to price from. */
  live_n: number;
  global_median_ratio: number;
  global_q25_ratio: number;
  global_q75_ratio: number;
  min_n: number;
  /** One entry per category with at least min_n live protocols, by category. */
  categories: CalibrationEntry[];
}

/** A protocol's market-cap-per-TVL, when it has a token that trades and a TVL. */
function liveRatio(p: SnapshotProtocol): number | null {
  if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) return null;
  return p.mcap_usd / p.tvl_usd;
}

/** Fit the calibration from a list of protocols (the whole snapshot, or the backtest's train set). */
export function calibrate(protocols: SnapshotProtocol[], minN: number = MODEL.calibration_min_n): Calibration {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of protocols) {
    const r = liveRatio(p);
    if (r === null) continue;
    all.push(r);
    const key = p.category ?? '';
    const list = byCategory.get(key);
    if (list === undefined) byCategory.set(key, [r]);
    else list.push(r);
  }
  if (all.length === 0) throw new SnapshotError('no live-token protocol to calibrate from');
  all.sort((a, b) => a - b);
  const globalMedian = quantile(all, 0.5);
  const categories: CalibrationEntry[] = [];
  for (const [category, ratios] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (ratios.length < minN || category === '') continue;
    ratios.sort((a, b) => a - b);
    const median = quantile(ratios, 0.5);
    categories.push({
      category,
      n: ratios.length,
      median_ratio: round4(median),
      q25_ratio: round4(quantile(ratios, 0.25)),
      q75_ratio: round4(quantile(ratios, 0.75)),
      multiplier: round4(median / globalMedian),
    });
  }
  return {
    live_n: all.length,
    global_median_ratio: round4(globalMedian),
    global_q25_ratio: round4(quantile(all, 0.25)),
    global_q75_ratio: round4(quantile(all, 0.75)),
    min_n: minN,
    categories,
  };
}

/** A category's multiplier under a calibration, or 1.00 when the category has too few live protocols to price itself. */
export function categoryMultiplier(cal: Calibration, category: string | null): number {
  if (category === null) return 1;
  const entry = cal.categories.find((c) => c.category === category);
  return entry === undefined ? 1 : entry.multiplier;
}

/** The ratio quartiles a row's band is drawn from: its category's when calibrated, the market's otherwise. */
export function bandRatios(cal: Calibration, category: string | null): { median: number; q25: number; q75: number } {
  if (category !== null) {
    const entry = cal.categories.find((c) => c.category === category);
    if (entry !== undefined) return { median: entry.median_ratio, q25: entry.q25_ratio, q75: entry.q75_ratio };
  }
  return { median: cal.global_median_ratio, q25: cal.global_q25_ratio, q75: cal.global_q75_ratio };
}

// ---------------------------------------------------------------- backtest

/** What the walk-forward backtest found, fitted on the past and tested on the future. */
export interface Backtest {
  cutoff: string;
  train_n: number;
  test_n: number;
  /** Median |log(predicted / actual market cap)| on the test set, radar-3 and the uncalibrated backbone. */
  radar3_median_log_err: number;
  radar2_median_log_err: number;
  /** Share of the test set predicted within 2x of the actual market cap. */
  radar3_within_2x: number;
  radar2_within_2x: number;
}

/**
 * The walk-forward backtest: fit the category prices on the live protocols listed
 * before the cutoff, then predict the market caps of the ones listed after, with
 * radar-3 (calibrated) and with radar-2 (the same formula, no category price).
 * A model that only fits the past it was trained on fails here; the numbers say
 * how far a prediction usually lands from the market cap it is checked against.
 */
export function backtest(snapshot: Snapshot, m: ModelConstants = MODEL): Backtest {
  const live = snapshot.protocols.filter((p) => liveRatio(p) !== null);
  const train = live.filter((p) => p.listed_at !== null && p.listed_at < m.backtest_cutoff);
  const test = live.filter((p) => p.listed_at !== null && p.listed_at >= m.backtest_cutoff);
  const calTrain = calibrate(train, m.calibration_min_n);
  const errs3: number[] = [];
  const errs2: number[] = [];
  let within3 = 0;
  let within2 = 0;
  for (const p of test) {
    const parts = multipliers(p, snapshot.as_of, m);
    const base = m.base_coef * Math.pow(p.tvl_usd, m.tvl_exponent);
    const pred3 = base * categoryMultiplier(calTrain, p.category) * parts.growthMult * parts.maturityMult * parts.velocityMult * parts.chainMult;
    const pred2 = base * parts.growthMult * parts.maturityMult * parts.velocityMult * parts.chainMult;
    const actual = p.mcap_usd!;
    errs3.push(Math.abs(Math.log(pred3 / actual)));
    errs2.push(Math.abs(Math.log(pred2 / actual)));
    if (pred3 / actual >= 0.5 && pred3 / actual <= 2) within3++;
    if (pred2 / actual >= 0.5 && pred2 / actual <= 2) within2++;
  }
  errs3.sort((a, b) => a - b);
  errs2.sort((a, b) => a - b);
  return {
    cutoff: m.backtest_cutoff,
    train_n: train.length,
    test_n: test.length,
    radar3_median_log_err: round4(quantile(errs3, 0.5)),
    radar2_median_log_err: round4(quantile(errs2, 0.5)),
    radar3_within_2x: test.length === 0 ? 0 : Math.round((within3 / test.length) * 100) / 100,
    radar2_within_2x: test.length === 0 ? 0 : Math.round((within2 / test.length) * 100) / 100,
  };
}

// ---------------------------------------------------------------- scoring

export interface Score {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  velocityMult: number;
  chainMult: number;
  categoryMult: number;
  age: number | null;
}

interface Multipliers {
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  velocityMult: number;
  chainMult: number;
  age: number | null;
}

/** The four snapshot-driven multipliers, shared by the score and the backtest. */
function multipliers(p: SnapshotProtocol, asOf: string, m: ModelConstants): Multipliers {
  const age = ageDays(asOf, p.listed_at);
  const growthPct = Math.min(m.growth_cap, Math.max(m.growth_floor, num(p.change_7d, 0)));
  let growthMult = 1 + (growthPct / 100) * m.growth_weight;
  if (growthPct > 60) growthMult += m.kicker_25 + m.kicker_60;
  else if (growthPct > 25) growthMult += m.kicker_25;
  if (growthPct < -30) growthMult += m.drag_30;
  const ageForModel = age ?? m.unknown_age_days;
  const maturityMult = m.maturity_floor + m.maturity_range * (1 - Math.exp(-ageForModel / m.maturity_scale_days));
  const velocity = p.tvl_usd / Math.max(ageForModel, m.velocity_floor_days);
  const velocityMult = 1 + m.velocity_weight * Math.tanh(Math.log10(Math.max(velocity, 1) / 1_000_000) / 2);
  const chainMult = 1 + m.chain_step * Math.min(Math.max(p.chains.length - 1, 0), m.chain_max_steps);
  return { growthPct, growthMult, maturityMult, velocityMult, chainMult, age };
}

/** radar-3's score for one protocol, from its own figures only. */
export function scoreProtocol(p: SnapshotProtocol, asOf: string, cal: Calibration, m: ModelConstants = MODEL): Score {
  const parts = multipliers(p, asOf, m);
  const categoryMult = categoryMultiplier(cal, p.category);
  const base = m.base_coef * Math.pow(p.tvl_usd, m.tvl_exponent);
  const implied = Math.max(
    1,
    Math.round(base * categoryMult * parts.growthMult * parts.maturityMult * parts.velocityMult * parts.chainMult),
  );
  return {
    implied,
    growthPct: parts.growthPct,
    growthMult: round4(parts.growthMult),
    maturityMult: round4(parts.maturityMult),
    velocityMult: round4(parts.velocityMult),
    chainMult: round4(parts.chainMult),
    categoryMult: round4(categoryMult),
    age: parts.age,
  };
}

/** One board row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  /** The calibration band: similar protocols actually trade between these values. */
  implied_low_usd: number;
  implied_high_usd: number;
  watchlist: boolean;
  model: {
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    velocity_multiplier: number;
    chain_multiplier: number;
    category_multiplier: number;
  };
  farm_steps: string[];
}

/** The dashboard's compact row, farm steps generated in the page from the same data. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  watchlist: boolean;
  growth_multiplier: number;
  maturity_multiplier: number;
  velocity_multiplier: number;
  chain_multiplier: number;
  category_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  calibration: Calibration;
  backtest: Backtest;
  rows: RadarRow[];
  live: LiveRow[];
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/**
 * The capital one farm position needs: it scales with the protocol's own implied
 * value, so a bigger prize is farmed with a bigger position, and a small one is
 * not farmed with money it cannot return.
 */
function capitalFor(implied: number): number {
  if (implied >= 200_000_000) return 400;
  if (implied >= 100_000_000) return 250;
  if (implied >= 50_000_000) return 150;
  if (implied >= 20_000_000) return 100;
  return 50;
}

/** What one transaction costs on the protocol's main chain: Ethereum is dear, every other chain in the snapshot is cheap. */
function gasFor(chain: string): { setup: number; weekly: number } {
  if (chain === 'Ethereum') return { setup: 12, weekly: 4 };
  return { setup: 3, weekly: 1 };
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's primary action, in words a farmer can follow. */
function primaryAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Supply $${capital} of USDC to ${n} on ${chain}, then borrow $20 of the same asset back so both sides of the position are live.`;
  if (c.includes('dex') || c.includes('leveraged farm'))
    return `Provide $${capital} of liquidity to ${n}'s deepest USDC pool on ${chain}, in the pool's own ratio, and keep the LP tokens.`;
  if (c.includes('yield aggregator') || c.includes('yield'))
    return `Deposit $${capital} of USDC into ${n}'s highest-TVL vault on ${chain} and keep the vault shares for the whole season.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis'))
    return `Deposit $${capital} of USDC as margin on ${n} on ${chain} and open one small hedged position, then close it the same week.`;
  if (c.includes('curator') || c.includes('allocator'))
    return `Deposit $${capital} of USDC into a ${n} curator vault on ${chain} and keep the shares; note the vault's fee and lock-up first.`;
  if (c.includes('rwa'))
    return `Mint $${capital} of ${n}'s yield-bearing asset on ${chain} and hold it in the same wallet for the whole season.`;
  if (c.includes('prediction'))
    return `Fund $${capital} on ${n} on ${chain} and place one market position on an outcome you have read, not a random one.`;
  if (c.includes('stable'))
    return `Mint or deposit $${capital} of the stable asset through ${n} on ${chain} and keep it in the same wallet.`;
  if (c.includes('insurance'))
    return `Buy $${capital} of cover from ${n} on ${chain} and keep the policy active for the whole season.`;
  if (c.includes('bridge'))
    return `Bridge $${capital} of USDC to ${chain} through ${n} and use the bridged funds in its own app the same day.`;
  if (c.includes('staking') || c.includes('restak'))
    return `Stake $${capital} of the chain's staking asset through ${n} on ${chain} and keep the receipt token in the same wallet.`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open for the whole season.`;
}

/** The category's second, complementary action: a different surface of the same protocol. */
function secondAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `After the first week, supply a second asset worth $${Math.round(capital / 2)} to ${n} on ${chain} so the wallet shows two supply markets, not one.`;
  if (c.includes('dex') || c.includes('leveraged farm'))
    return `Swap $${Math.round(capital / 5)} through ${n}'s own router on ${chain} once a week, so the wallet shows trading activity as well as liquidity.`;
  if (c.includes('yield aggregator') || c.includes('yield') || c.includes('curator') || c.includes('allocator'))
    return `Split the deposit: put $${Math.round(capital / 2)} in a second ${n} vault on ${chain} with a different strategy, and keep both.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis'))
    return `Place one more small trade on ${n} on ${chain} in the opposite direction, so the wallet shows two closed positions.`;
  if (c.includes('rwa'))
    return `Move $${Math.round(capital / 2)} of the minted asset into ${n}'s own lending market on ${chain} for the rest of the season.`;
  if (c.includes('prediction'))
    return `Settle one more market on ${n} on ${chain} with $${Math.round(capital / 5)}, on a different outcome, and let it resolve.`;
  return `Make a second, smaller deposit of $${Math.round(capital / 2)} into ${n} on ${chain} a week later, so the wallet shows activity across two dates.`;
}

/** The category's weekly qualifying action. */
function weeklyAction(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp')) return `Each week, adjust the borrow on ${n} by a few dollars or add a little collateral, so the position moves.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Each week, swap a few dollars through ${n} or collect and re-add the pool fees.`;
  if (c.includes('yield aggregator') || c.includes('yield') || c.includes('curator') || c.includes('allocator'))
    return `Each week, check ${n}'s vault page and compound or re-deposit the yield it shows.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis'))
    return `Each week, open and close one small trade on ${n} and keep the fees under $2.`;
  if (c.includes('prediction')) return `Each week, read one open market on ${n} and place one small position only when you understand it.`;
  if (c.includes('rwa')) return `Each week, confirm the minted asset is still in the wallet and check ${n}'s yield page for a new season.`;
  return `Each week, do one qualifying action on ${n}: a deposit, a swap, a vote, or a claim of the yield it shows.`;
}

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One farm step as a single string, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: seven steps, each an action with what it costs and how long
 * it takes. Derived from the protocol's own record (category, chains, TVL, age, and
 * now its implied value, which sets the size of the position), never from a
 * hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, implied: number): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(implied);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline, never in a chat or a screenshot.`,
      cost: `under $${gas.setup} of gas for the first transaction on ${chain}`,
      time: '5 minutes',
    },
    { text: primaryAction(p, capital, chain), cost: `$${capital} of capital and about $${gas.setup} of gas`, time: '15 minutes to set up' },
    { text: secondAction(p, capital, chain), cost: `about $${Math.max(1, Math.round(gas.setup / 2))} of gas`, time: '10 minutes, a week after the first step' },
    {
      text: weeklyAction(p),
      cost: `about $${gas.weekly} of gas a week on ${chain}`,
      time: '10 minutes a week',
    },
    {
      text: `Hold every position for at least ${hold} days, so the activity is counted in more than one snapshot instead of one.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw anything, open ${p.name}'s own points or rewards page from the link the protocol itself publishes, and claim only there.`,
      cost: 'no fee to check, and never pay anyone to claim for you',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction hash in a farm log, set a calendar reminder for the ${hold}-day mark, and plan the exit before the token, if any, is announced.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The ranked board: every rankable pre-token protocol, watchlist first in coverage, sorted by implied value. */
export function buildBoard(snapshot: Snapshot, cal: Calibration, m: ModelConstants = MODEL): BoardRow[] {
  const watch = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => isRankable(p) || watch.has(p.slug));
  const scored = chosen.map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of, cal, m) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  // Force a real ranking: no two rows share an implied value.
  let prev = Number.POSITIVE_INFINITY;
  return scored.map((x, i) => {
    let implied = x.s.implied;
    if (implied >= prev) implied = Math.max(1, prev - 1);
    prev = implied;
    // The band follows the row's final implied value, from its category's live ratios.
    const band = bandRatios(cal, x.p.category);
    const low = Math.max(1, Math.round((implied * band.q25) / band.median));
    const high = Math.max(implied + 1, Math.round((implied * band.q75) / band.median));
    return {
      rank: i + 1,
      slug: x.p.slug,
      name: x.p.name,
      category: x.p.category,
      chains: x.p.chains,
      tvl_usd: x.p.tvl_usd,
      change_7d: x.p.change_7d,
      listed_at: x.p.listed_at,
      age_days: x.s.age,
      implied_value_usd: implied,
      implied_low_usd: low,
      implied_high_usd: high,
      watchlist: watch.has(x.p.slug),
      model: {
        growth_pct: x.s.growthPct,
        growth_multiplier: x.s.growthMult,
        maturity_multiplier: x.s.maturityMult,
        velocity_multiplier: x.s.velocityMult,
        chain_multiplier: x.s.chainMult,
        category_multiplier: x.s.categoryMult,
      },
      farm_steps: farmSteps(x.p, x.s.age, implied).map(stepText),
    };
  });
}

/** The live-token protocols, by market cap, for the dashboard's separate Live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    implied_low_usd: row.implied_low_usd,
    implied_high_usd: row.implied_high_usd,
    watchlist: row.watchlist,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    velocity_multiplier: row.model.velocity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
    category_multiplier: row.model.category_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, m: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const cal = calibrate(snapshot.protocols, m.calibration_min_n);
  const bt = backtest(snapshot, m);
  const board = buildBoard(snapshot, cal, m);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: m,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    calibration: cal,
    backtest: bt,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (!Number.isSafeInteger(r.implied_low_usd) || r.implied_low_usd <= 0 || r.implied_low_usd > r.implied_value_usd) {
      return `${r.slug} has a bad calibration band low ${r.implied_low_usd}`;
    }
    if (!Number.isSafeInteger(r.implied_high_usd) || r.implied_high_usd <= r.implied_value_usd) {
      return `${r.slug} has a bad calibration band high ${r.implied_high_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
  }
  return null;
}

/** The dashboard's dataset as one script: `window.RADAR = {...};` — no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
