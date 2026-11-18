// Token Radar, model radar-2: a snapshot of the protocol universe in, a ranked board out.
//
// The board ranks every protocol the snapshot records as pre-token and rankable: the
// watchlist is the floor (all 40 of its slugs are always in), and every other rankable
// pre-token protocol below the floor joins it, so the board is the whole radar, not a
// hand-picked list. Protocols whose token already trades are kept apart in a Live view
// and are never ranked by implied value: the market prices those, the model prices the
// ones still to come.
//
// Implied value is built only from the snapshot's own figures, the same function for
// every protocol, no name ever special-cased:
//
//   base      = 60 * tvl_usd ^ 0.72          (power law: TVL matters, with diminishing
//                                             returns, so the board is not a TVL table)
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
//   implied   = round(base * growthMult * maturityMult * velMult * chainMult)
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

/** radar-2's constants, stated in the dashboard so a reader can check the arithmetic. */
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
};

export const MODEL_VERSION = 'radar-2';

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

export interface Score {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  velocityMult: number;
  chainMult: number;
  age: number | null;
}

/** radar-2's score for one protocol, from its own figures only. */
export function scoreProtocol(p: SnapshotProtocol, asOf: string, m: ModelConstants = MODEL): Score {
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
  const base = m.base_coef * Math.pow(p.tvl_usd, m.tvl_exponent);
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * velocityMult * chainMult));
  return { implied, growthPct, growthMult: round4(growthMult), maturityMult: round4(maturityMult), velocityMult: round4(velocityMult), chainMult: round4(chainMult), age };
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
  watchlist: boolean;
  model: {
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    velocity_multiplier: number;
    chain_multiplier: number;
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
  watchlist: boolean;
  growth_multiplier: number;
  maturity_multiplier: number;
  velocity_multiplier: number;
  chain_multiplier: number;
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
  rows: RadarRow[];
  live: LiveRow[];
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 20_000_000) return 100;
  return 50;
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
 * it takes. Derived from the protocol's own record (category, chains, TVL, age), never
 * from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = capital >= 150 ? 8 : 4;
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline, never in a chat or a screenshot.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    { text: primaryAction(p, capital, chain), cost: `$${capital} of capital and about $${gas} of gas`, time: '15 minutes to set up' },
    { text: secondAction(p, capital, chain), cost: `about $${Math.max(2, Math.round(gas / 2))} of gas`, time: '10 minutes, a week after the first step' },
    {
      text: weeklyAction(p),
      cost: 'about $2 of gas a week',
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
export function buildBoard(snapshot: Snapshot, m: ModelConstants = MODEL): BoardRow[] {
  const watch = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => isRankable(p) || watch.has(p.slug));
  const scored = chosen.map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of, m) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  // Force a real ranking: no two rows share an implied value.
  let prev = Number.POSITIVE_INFINITY;
  return scored.map((x, i) => {
    let implied = x.s.implied;
    if (implied >= prev) implied = Math.max(1, prev - 1);
    prev = implied;
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
      watchlist: watch.has(x.p.slug),
      model: {
        growth_pct: x.s.growthPct,
        growth_multiplier: x.s.growthMult,
        maturity_multiplier: x.s.maturityMult,
        velocity_multiplier: x.s.velocityMult,
        chain_multiplier: x.s.chainMult,
      },
      farm_steps: farmSteps(x.p, x.s.age).map(stepText),
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
    watchlist: row.watchlist,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    velocity_multiplier: row.model.velocity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, m: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, m);
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
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
  }
  return null;
}

/** The dashboard's dataset as one script: `window.RADAR = {...};` — no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
