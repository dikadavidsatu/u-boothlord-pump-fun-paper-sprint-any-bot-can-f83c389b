// PullbackSnap — the strategy behind this entry's pump.fun paper-trading bot.
//
// The idea, designed for this entry: most fresh pump.fun curves pump once and die.
// Chasing the first spike means paying the spike. This bot waits for the spike to
// prove itself, then buys the dip. A coin only qualifies after it has run up at
// least 40% from its early base, pulled back at least 25% from its recent peak, and
// shown buyers stepping back in on the tape — recent buys from several distinct
// wallets, net SOL flowing in, the last trade a buy, and the price already bouncing
// at least 12% off its window low. Never catch a knife that is still falling.
//
// That is a continuation bet, not a breakout chase: the run already happened, the
// crowd is still there, and the price is cheaper than the peak.
//
// Exits are mechanical and fixed before any entry is considered: a hard stop under
// cost, a take-profit at a fixed multiple, a trailing exit that only arms above the
// take-profit (so it guards runs that blow past the target instead of cutting the
// few winners short of it), a dead-tape exit when the coin stops trading, and a
// maximum hold so capital keeps recycling. Above all of it sits a portfolio-level
// drawdown guard: entries halt at a 15% drawdown from the equity peak and the whole
// book flattens at 30%, far inside the house's 50% guardrail. One fixed stake per
// position, no pyramiding, at most four open at once. The ranking bar needs round
// trips on at least 20 distinct coins, so a breadth fallback loosens the entry
// filter (smaller pullback, smaller run-up, half stake, shorter holds) whenever
// completed round trips stall for a long stretch of slots.
//
// Every decision is a pure function of the batch stream: no clock reads, no
// randomness, no network, iteration only over insertion-ordered maps fed by that
// stream. Two runs on the same data produce the same action log.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Slots a curve must be old before we buy it (skip the launch chaos). */
  minAgeSlots: number;
  /** Slots after creation past which a coin is too stale to enter. */
  maxAgeSlots: number;
  /** Real SOL reserve bounds at entry. */
  minReserveSol: number;
  maxReserveSol: number;
  /** Run-up from the early base price that proves the pump, as a fraction. */
  minRunUp: number;
  /** Pullback from the recent peak that makes the dip, as a fraction. */
  minPullback: number;
  /** Price must still sit above the base by at least this fraction (the run is not dead). */
  minAboveBase: number;
  /** Window (slots) for the "buyers returning" tape check. */
  returnWindowSlots: number;
  minReturnBuys: number;
  minReturnBuyers: number;
  minReturnNetSol: number;
  /** Bounce off the window low that confirms buyers are lifting the dip, as a fraction. */
  minBounce: number;
  /** The peak must be this fresh (slots) for the run-up to still count. */
  peakFreshSlots: number;
  /** Portfolio drawdown that halts new entries, as a fraction of equity peak. */
  ddHalt: number;
  /** Portfolio drawdown that flattens every open position, as a fraction of equity peak. */
  ddFlatten: number;
  /** One fixed stake per position, in SOL. */
  stakeSol: number;
  minStakeSol: number;
  buySlipBps: number;
  /** Exit rules, as fractions of cost / peak value. */
  stopLoss: number;
  takeProfit: number;
  trailArm: number;
  trailDrop: number;
  /** Slots with no trade on a held coin before we give up on it. */
  deadTapeSlots: number;
  maxHoldSlots: number;
  /** Per-coin discipline. */
  cooldownSlots: number;
  maxEntriesPerMint: number;
  maxOpenPositions: number;
  /** Breadth fallback: engage when round trips stall. */
  breadthStallSlots: number;
  breadthTargetCoins: number;
  breadthMinRunUp: number;
  breadthMinPullback: number;
  breadthStakeSol: number;
  breadthMaxHoldSlots: number;
  /** Total cost exposure cap across open positions, in SOL. */
  maxExposureSol: number;
}

// Tuned on the kit's dev dataset with tools/backtest.ts. The first cut (25% run-up, 12%
// pullback, 3 returning buys, 15% stop / 35% take-profit, trailing from +15%) lost 1.48 SOL
// over 206 round trips at a 15.2% drawdown: dip-buying on pump.fun mostly catches falling
// knives, and the trailing exit cut the few winners short of take-profit. Selectivity fixed
// most of it — a 40% run-up, a 25% pullback, a 12% bounce off the window low, 5 returning
// buys from 3 distinct wallets with 0.1 SOL net inflow, and a 100-slot seasoning — and an
// 8% stop with a 50% take-profit and the trail parked above the target (+55%, so it only
// guards runs that blow past it) turned the sample positive: +0.048 SOL over 92 round trips
// across 77 coins, 14.1% wins, 2.8% max drawdown. The neighbours are flat (stop 10% / TP
// 50%: +0.069; stop 6% / TP 50%: +0.001; TP 60%: -0.105), so this is a broad region, not
// the sample's single best cell — the grading window is different data, and the final
// window is only 6 hours, so the breadth fallback engages after 6,000 stalled slots to keep
// the 20-coin round-trip bar in reach (that insurance costs ~0.04 SOL on the dev sample:
// +0.048 with it, +0.085 without).
export const DEFAULT_PARAMS: Params = {
  minAgeSlots: 100,
  maxAgeSlots: 6000,
  minReserveSol: 2,
  maxReserveSol: 60,
  minRunUp: 0.4,
  minPullback: 0.25,
  minAboveBase: 0.05,
  returnWindowSlots: 40,
  minReturnBuys: 5,
  minReturnBuyers: 3,
  minReturnNetSol: 0.1,
  minBounce: 0.12,
  peakFreshSlots: 1500,
  ddHalt: 0.15,
  ddFlatten: 0.3,
  stakeSol: 0.12,
  minStakeSol: 0.05,
  buySlipBps: 2000,
  stopLoss: 0.08,
  takeProfit: 0.5,
  trailArm: 0.55,
  trailDrop: 0.1,
  deadTapeSlots: 600,
  maxHoldSlots: 1500,
  cooldownSlots: 900,
  maxEntriesPerMint: 2,
  maxOpenPositions: 4,
  breadthStallSlots: 6000,
  breadthTargetCoins: 20,
  breadthMinRunUp: 0.15,
  breadthMinPullback: 0.06,
  breadthStakeSol: 0.06,
  breadthMaxHoldSlots: 300,
  maxExposureSol: 1.0,
};

const LAMPORTS = 1e9;
/** Curve + creator fee share taken on a sell (95 + 30 bps), used to mark positions. */
const CURVE_FEE = 0.0125;
/** How many slots of tape history to keep per coin (older trades cannot affect any rule). */
const KEEP_SLOTS = 7000;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  createdSlot: number | null;
  basePrice: number;
  peakPrice: number;
  peakSlot: number;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
  lastTradeSlot: number;
}

interface Held {
  openedSlot: number;
  peakValueSol: number;
  breadth: boolean;
  exiting: boolean;
  filled: boolean;
}

interface WindowStats {
  buys: number;
  buyers: number;
  netSol: number;
  lowPrice: number;
}

/**
 * Fail fast on a nonsense parameter set instead of trading on it. Every number must
 * be finite, every fraction inside (0, 1) where it is one, and every ordering the
 * strategy assumes (stop below take-profit, trail above take-profit, halt below
 * flatten, breadth stake below the normal stake) must hold. The default set passes;
 * an override that breaks an invariant throws before the first batch is answered.
 */
export function validateParams(p: Params): void {
  const bad: string[] = [];
  const num = (name: string, v: number, lo: number, hi: number) => {
    if (!Number.isFinite(v) || v < lo || v > hi) bad.push(`${name}=${v} (want ${lo}..${hi})`);
  };
  const frac = (name: string, v: number) => num(name, v, 0, 1);
  num('minAgeSlots', p.minAgeSlots, 0, 1e9);
  num('maxAgeSlots', p.maxAgeSlots, p.minAgeSlots, 1e9);
  num('minReserveSol', p.minReserveSol, 0, 1e9);
  num('maxReserveSol', p.maxReserveSol, p.minReserveSol, 1e9);
  frac('minRunUp', p.minRunUp);
  frac('minPullback', p.minPullback);
  frac('minAboveBase', p.minAboveBase);
  num('returnWindowSlots', p.returnWindowSlots, 1, 1e6);
  num('minReturnBuys', p.minReturnBuys, 1, 1e6);
  num('minReturnBuyers', p.minReturnBuyers, 1, 1e6);
  num('minReturnNetSol', p.minReturnNetSol, 0, 1e9);
  frac('minBounce', p.minBounce);
  num('peakFreshSlots', p.peakFreshSlots, 1, 1e9);
  frac('ddHalt', p.ddHalt);
  frac('ddFlatten', p.ddFlatten);
  if (p.ddHalt >= p.ddFlatten) bad.push(`ddHalt (${p.ddHalt}) must be below ddFlatten (${p.ddFlatten})`);
  num('stakeSol', p.stakeSol, 0, 1e9);
  num('minStakeSol', p.minStakeSol, 0, p.stakeSol);
  num('buySlipBps', p.buySlipBps, 0, 10_000);
  frac('stopLoss', p.stopLoss);
  frac('takeProfit', p.takeProfit);
  frac('trailArm', p.trailArm);
  frac('trailDrop', p.trailDrop);
  if (p.trailArm <= p.takeProfit) bad.push(`trailArm (${p.trailArm}) must sit above takeProfit (${p.takeProfit})`);
  num('deadTapeSlots', p.deadTapeSlots, 1, 1e9);
  num('maxHoldSlots', p.maxHoldSlots, 1, 1e9);
  num('cooldownSlots', p.cooldownSlots, 0, 1e9);
  num('maxEntriesPerMint', p.maxEntriesPerMint, 1, 1e6);
  num('maxOpenPositions', p.maxOpenPositions, 1, 1e6);
  num('breadthStallSlots', p.breadthStallSlots, 1, 1e9);
  num('breadthTargetCoins', p.breadthTargetCoins, 1, 1e6);
  frac('breadthMinRunUp', p.breadthMinRunUp);
  frac('breadthMinPullback', p.breadthMinPullback);
  num('breadthStakeSol', p.breadthStakeSol, 0, p.stakeSol);
  num('breadthMaxHoldSlots', p.breadthMaxHoldSlots, 1, p.maxHoldSlots);
  num('maxExposureSol', p.maxExposureSol, p.stakeSol, 1e9);
  if (bad.length > 0) throw new Error(`invalid strategy params: ${bad.join('; ')}`);
}

export function createBot(p: Params = DEFAULT_PARAMS) {
  validateParams(p);

  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const roundTripped = new Set<Pubkey>();
  const boughtMints = new Set<Pubkey>();
  let firstSlot = -1;
  let lastTripSlot = -1;
  /** Portfolio equity peak (SOL) for the drawdown guard; starts at the 10 SOL capital. */
  let peakEquitySol = 10;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        createdSlot: null,
        basePrice: 0,
        peakPrice: 0,
        peakSlot: -1_000_000_000,
        trades: [],
        entries: 0,
        lastExitSlot: -1_000_000_000,
        lastTradeSlot: -1_000_000_000,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /**
   * What a position is worth right now, in SOL, after curve + creator fees and one
   * tx fee: tokens sold back through the constant-product curve at the latest
   * reserves (the batch's mark when there is one, else the curve's own reserves).
   * The same marking feeds both the equity guard and the per-position exit tests,
   * so the two can never disagree about a position's value.
   */
  const markValueSol = (
    state: BotState,
    marks: Map<Pubkey, { virtual_quote_reserves: string; virtual_token_reserves: string }>,
    mint: Pubkey,
    tokenAmount: bigint,
  ): number | null => {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return null;
    const mk = marks.get(mint);
    const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
    const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
    const tokens = Number(tokenAmount);
    const txSol = Number(state.txFeeLamports()) / LAMPORTS;
    return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - txSol;
  };

  /**
   * One pass over the recent tape: how many buys, from how many distinct wallets,
   * the net SOL flow, and the lowest price printed in the window. The window is
   * walked backwards and stops at its edge, since trades arrive in slot order.
   */
  const windowStats = (t: Tape, now: number): WindowStats => {
    const from = now - p.returnWindowSlots;
    let buys = 0;
    let net = 0;
    let low = Infinity;
    const buyers = new Set<string>();
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= from) break;
      if (tr.price < low) low = tr.price;
      if (tr.buy) {
        buys++;
        buyers.add(tr.user);
        net += tr.sol;
      } else {
        net -= tr.sol;
      }
    }
    return { buys, buyers: buyers.size, netSol: net, lowPrice: low };
  };

  /** The dip test: run-up proven, pullback real, buyers returning. */
  const entryOk = (t: Tape, now: number, reserveSol: number, relaxed: boolean): boolean => {
    if (reserveSol < p.minReserveSol || reserveSol > p.maxReserveSol) return false;
    if (t.createdSlot === null) return false;
    const age = now - t.createdSlot;
    if (age < p.minAgeSlots || age > p.maxAgeSlots) return false;
    if (t.basePrice <= 0 || t.peakPrice <= 0) return false;
    const last = t.trades[t.trades.length - 1];
    if (last === undefined || !last.buy) return false;
    const price = last.price;
    const runUp = t.peakPrice / t.basePrice - 1;
    const pullback = 1 - price / t.peakPrice;
    const minRun = relaxed ? p.breadthMinRunUp : p.minRunUp;
    const minPull = relaxed ? p.breadthMinPullback : p.minPullback;
    if (runUp < minRun || pullback < minPull) return false;
    if (price < t.basePrice * (1 + p.minAboveBase)) return false;
    if (now - t.peakSlot > p.peakFreshSlots) return false;
    // Buyers returning: the recent tape must be buy-heavy with several distinct wallets.
    const w = windowStats(t, now);
    if (w.buys < p.minReturnBuys || w.buyers < p.minReturnBuyers) return false;
    if (w.netSol < p.minReturnNetSol) return false;
    // Bounce: the price must already be lifting off the window low, not still falling.
    if (w.lowPrice === Infinity || price < w.lowPrice * (1 + p.minBounce)) return false;
    return true;
  };

  /** Fold one batch's fills into the round-trip book. Harness closes (client_id `_…`) are not ours. */
  const noteFills = (batch: Batch, now: number): void => {
    for (const f of batch.fills) {
      if (f.status !== 'filled' || f.client_id.startsWith('_')) continue;
      if (f.side === 'buy' && Number(f.quote_lamports) >= 10_000_000) boughtMints.add(f.mint);
      if (f.side === 'sell' && boughtMints.has(f.mint) && !roundTripped.has(f.mint)) {
        roundTripped.add(f.mint);
        lastTripSlot = now;
      }
    }
  };

  /** Fold one batch's events into the tapes, and report which mints traded. */
  const noteEvents = (batch: Batch): Set<Pubkey> => {
    const tradedNow = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const price = Number(e.virtual_quote_reserves) / Math.max(1, Number(e.virtual_token_reserves));
        if (t.basePrice <= 0) t.basePrice = price;
        else if (price < t.basePrice && t.trades.length < 4) t.basePrice = price;
        if (price > t.peakPrice) {
          t.peakPrice = price;
          t.peakSlot = e.slot;
        }
        t.trades.push({ slot: e.slot, buy: e.is_buy, sol: Number(e.sol_amount) / LAMPORTS, user: e.user, price });
        t.lastTradeSlot = e.slot;
        tradedNow.add(e.mint);
      }
    }
    return tradedNow;
  };

  /** Drop tape history older than the longest window any rule can still read. */
  const pruneTapes = (tradedNow: Set<Pubkey>, now: number): void => {
    for (const mint of tradedNow) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - KEEP_SLOTS) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      if (firstSlot < 0) firstSlot = now;

      noteFills(batch, now);
      const tradedNow = noteEvents(batch);
      pruneTapes(tradedNow, now);

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingMints = new Set<Pubkey>();
      const sellPending = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        pendingMints.add(po.order.mint);
        if (po.order.side === 'sell') sellPending.add(po.order.mint);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      // Breadth fallback: if round trips stall while the 20-coin bar is unmet, loosen entries.
      const sinceTrip = lastTripSlot < 0 ? now - firstSlot : now - lastTripSlot;
      const breadthMode = roundTripped.size < p.breadthTargetCoins && sinceTrip > p.breadthStallSlots;

      // Portfolio drawdown guard: equity is cash plus the marked value of open positions.
      // A 15% drawdown from the equity peak halts new entries; a 30% drawdown flattens the
      // whole book. The house guardrail is 50%, so this keeps a wide safety margin.
      let equitySol = Number(state.cash) / LAMPORTS;
      for (const [mint, pos] of state.positions) {
        const valueSol = markValueSol(state, marks, mint, pos.token_amount);
        if (valueSol !== null) equitySol += valueSol;
      }
      if (equitySol > peakEquitySol) peakEquitySol = equitySol;
      const flattenAll = equitySol < peakEquitySol * (1 - p.ddFlatten);
      const haltEntries = flattenAll || equitySol < peakEquitySol * (1 - p.ddHalt);

      // Exits first: every held position is re-marked and tested against the mechanical rules.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          // Our position is gone: drop the tracker unless a fill for it is still in flight.
          if (!pendingMints.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExitSlot = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        const valueSol = markValueSol(state, marks, mint, pos.token_amount);
        if (valueSol === null) continue;
        const costSol = Number(pos.cost_lamports) / LAMPORTS;
        if (valueSol > h.peakValueSol) h.peakValueSol = valueSol;
        let exit = h.exiting;
        if (!exit && flattenAll) exit = true;
        if (!exit && valueSol < costSol * (1 - p.stopLoss)) exit = true;
        if (!exit && valueSol > costSol * (1 + p.takeProfit)) exit = true;
        if (!exit && h.peakValueSol >= costSol * (1 + p.trailArm) && valueSol < h.peakValueSol * (1 - p.trailDrop)) exit = true;
        if (!exit && now - tapeOf(mint).lastTradeSlot > p.deadTapeSlots) exit = true;
        const holdLimit = h.breadth ? p.breadthMaxHoldSlots : p.maxHoldSlots;
        if (!exit && now - h.openedSlot > holdLimit) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (sellPending.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Entries: one fixed stake per fresh position, only on coins traded in this batch.
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposureSol = 0;
      for (const mint of held.keys()) {
        const pos = state.positions.get(mint);
        if (pos !== undefined) exposureSol += Number(pos.cost_lamports) / LAMPORTS;
      }
      for (const mint of tradedNow) {
        if (haltEntries) break;
        if (orders.length >= cap) break;
        if (slotsLeft <= 0 || held.size >= p.maxOpenPositions) break;
        if (held.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntriesPerMint || now - t.lastExitSlot < p.cooldownSlots) continue;
        const reserveSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entryOk(t, now, reserveSol, breadthMode)) continue;
        const stake = breadthMode ? p.breadthStakeSol : p.stakeSol;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(stake, capSol, p.maxExposureSol - exposureSol);
        if (amount > freeSol - txSol) amount = freeSol - txSol;
        if (amount < p.minStakeSol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        held.set(mint, { openedSlot: now, peakValueSol: 0, breadth: breadthMode, exiting: false, filled: false });
        t.entries++;
        freeSol -= amount + txSol;
        exposureSol += amount;
        slotsLeft--;
      }
      return orders;
    },
  };
}
