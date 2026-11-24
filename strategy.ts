// PullbackSnap — dip-buying strategy for the pump.fun paper-trading replay sprint.
//
// Thesis: on pump.fun most curves spike once and then bleed out. Chasing the first
// spike means buying the top. This bot does the opposite: it waits for a spike to
// prove itself, then buys the pullback. A coin only becomes a candidate once three
// things are true at the same time:
//
//   1. The pump was real — the price ran at least 40% from its early base to a
//      recent peak, and that peak is still fresh (at most 1,500 slots old).
//   2. The dip is real — the current price sits at least 25% below the peak, yet
//      still at least 5% above the base, so the run is dented, not dead.
//   3. Buyers are coming back — in the last 40 slots there were at least 5 buys
//      from at least 3 distinct wallets, at least 0.1 SOL of net inflow, the last
//      trade was a buy, and the price has already bounced at least 12% off the
//      window low. A knife still falling is never caught.
//
// That is a continuation bet, not a breakout chase: the run already happened, the
// crowd is still on the tape, and the entry is cheaper than the peak.
//
// Exits are decided before entry and never renegotiated mid-trade: a hard stop at
// -8% of cost, a take-profit at +50%, a trailing exit that only arms above the
// take-profit (+55% arm, -10% from the peak value) so it guards runs that blow
// past the target instead of cutting the few winners short of it, a dead-tape
// exit after 600 slots without a trade, and a 1,500-slot maximum hold so capital
// keeps recycling. Above all of it sits a portfolio drawdown guard: new entries
// halt at -15% from the equity peak and the whole book flattens at -30%, far
// inside the house's 50% guardrail. One fixed stake per position, no pyramiding,
// at most four open at once, total exposure capped at 1.0 SOL.
//
// The ranking bar needs round trips on at least 20 distinct coins, so a breadth
// fallback loosens the entry filter (15% run-up, 6% pullback, 0.06 SOL stake,
// 300-slot holds) whenever completed round trips stall for more than 6,000 slots
// while the 20-coin bar is still unmet.
//
// Determinism: every decision is a pure function of the batch stream. No clock
// reads, no randomness, no network, and iteration only over insertion-ordered maps
// fed by that stream — two runs on the same data produce byte-identical logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

/** All tunable numbers for the strategy, in one place so a parameter sweep is trivial. */
export interface Params {
  /** Slots a curve must be old before we buy it (skip the launch chaos). */
  minAgeSlots: number;
  /** Slots after creation past which a coin is too stale to enter. */
  maxAgeSlots: number;
  /** Real SOL reserve bounds a coin must satisfy at entry. */
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
  /** Portfolio drawdown that halts new entries, as a fraction of the equity peak. */
  ddHalt: number;
  /** Portfolio drawdown that flattens every open position, as a fraction of the equity peak. */
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

// Tuning history, measured on the kit's dev dataset with tools/backtest.ts. The
// first cut (25% run-up, 12% pullback, 3 returning buys, 15% stop / 35%
// take-profit, trailing from +15%) lost 1.48 SOL over 206 round trips at a 15.2%
// drawdown: dip-buying on pump.fun mostly catches falling knives, and the
// trailing exit cut the few winners short of take-profit. Selectivity fixed most
// of it — a 40% run-up, a 25% pullback, a 12% bounce off the window low, 5
// returning buys from 3 distinct wallets with 0.1 SOL net inflow, and a 100-slot
// seasoning — and an 8% stop with a 50% take-profit and the trail parked above the
// target (+55%, so it only guards runs that blow past it) turned the sample
// positive: +0.048 SOL over 92 round trips across 77 coins, 14.1% wins, 2.8% max
// drawdown. The neighbours are flat (stop 10% / TP 50%: +0.069; stop 6% / TP 50%:
// +0.001; TP 60%: -0.105), so this is a broad region, not the sample's single
// best cell — the grading window is different data, and the final window is only
// 6 hours, so the breadth fallback engages after 6,000 stalled slots to keep the
// 20-coin round-trip bar in reach (that insurance costs ~0.04 SOL on the dev
// sample: +0.048 with it, +0.085 without).
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

/** Lamports in one SOL. */
const LAMPORTS_PER_SOL = 1e9;
/** Curve + creator fee share taken on a sell (95 + 30 bps), used when marking positions. */
const SELL_FEE_SHARE = 0.0125;
/** How many slots of tape history to keep per coin (older trades cannot affect any rule). */
const TAPE_KEEP_SLOTS = 7000;
/** Starting capital in SOL — the equity peak the drawdown guard measures against. */
const STARTING_CAPITAL_SOL = 10;
/** Sentinel slot for "never happened". */
const NEVER = -1_000_000_000;

/** One trade as the strategy remembers it: enough to run every entry rule. */
interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

/** Everything the strategy remembers about one mint's tape. */
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

/** Bookkeeping for one open position, beyond what the harness state already holds. */
interface HeldPosition {
  openedSlot: number;
  peakValueSol: number;
  breadth: boolean;
  exiting: boolean;
  filled: boolean;
}

/** Summary of the recent tape inside the "buyers returning" window. */
interface ReturnWindow {
  buys: number;
  buyers: number;
  netSol: number;
  lowPrice: number;
}

/** A fresh, empty tape for a mint seen for the first time. */
function emptyTape(): Tape {
  return {
    createdSlot: null,
    basePrice: 0,
    peakPrice: 0,
    peakSlot: NEVER,
    trades: [],
    entries: 0,
    lastExitSlot: NEVER,
    lastTradeSlot: NEVER,
  };
}

/**
 * Fail fast on a nonsense parameter set instead of trading on it. Every number
 * must be finite, every fraction must sit inside (0, 1) where it is one, and
 * every ordering the strategy assumes must hold: stop below take-profit, trail
 * above take-profit, halt below flatten, breadth stake below the normal stake.
 * The default set passes; an override that breaks an invariant throws before the
 * first batch is answered.
 */
export function validateParams(p: Params): void {
  const problems: string[] = [];
  const checkRange = (name: string, value: number, lo: number, hi: number): void => {
    if (!Number.isFinite(value) || value < lo || value > hi) {
      problems.push(`${name}=${value} (want ${lo}..${hi})`);
    }
  };
  const checkFraction = (name: string, value: number): void => checkRange(name, value, 0, 1);

  checkRange('minAgeSlots', p.minAgeSlots, 0, 1e9);
  checkRange('maxAgeSlots', p.maxAgeSlots, p.minAgeSlots, 1e9);
  checkRange('minReserveSol', p.minReserveSol, 0, 1e9);
  checkRange('maxReserveSol', p.maxReserveSol, p.minReserveSol, 1e9);
  checkFraction('minRunUp', p.minRunUp);
  checkFraction('minPullback', p.minPullback);
  checkFraction('minAboveBase', p.minAboveBase);
  checkRange('returnWindowSlots', p.returnWindowSlots, 1, 1e6);
  checkRange('minReturnBuys', p.minReturnBuys, 1, 1e6);
  checkRange('minReturnBuyers', p.minReturnBuyers, 1, 1e6);
  checkRange('minReturnNetSol', p.minReturnNetSol, 0, 1e9);
  checkFraction('minBounce', p.minBounce);
  checkRange('peakFreshSlots', p.peakFreshSlots, 1, 1e9);
  checkFraction('ddHalt', p.ddHalt);
  checkFraction('ddFlatten', p.ddFlatten);
  if (p.ddHalt >= p.ddFlatten) {
    problems.push(`ddHalt (${p.ddHalt}) must be below ddFlatten (${p.ddFlatten})`);
  }
  checkRange('stakeSol', p.stakeSol, 0, 1e9);
  checkRange('minStakeSol', p.minStakeSol, 0, p.stakeSol);
  checkRange('buySlipBps', p.buySlipBps, 0, 10_000);
  checkFraction('stopLoss', p.stopLoss);
  checkFraction('takeProfit', p.takeProfit);
  checkFraction('trailArm', p.trailArm);
  checkFraction('trailDrop', p.trailDrop);
  if (p.trailArm <= p.takeProfit) {
    problems.push(`trailArm (${p.trailArm}) must sit above takeProfit (${p.takeProfit})`);
  }
  checkRange('deadTapeSlots', p.deadTapeSlots, 1, 1e9);
  checkRange('maxHoldSlots', p.maxHoldSlots, 1, 1e9);
  checkRange('cooldownSlots', p.cooldownSlots, 0, 1e9);
  checkRange('maxEntriesPerMint', p.maxEntriesPerMint, 1, 1e6);
  checkRange('maxOpenPositions', p.maxOpenPositions, 1, 1e6);
  checkRange('breadthStallSlots', p.breadthStallSlots, 1, 1e9);
  checkRange('breadthTargetCoins', p.breadthTargetCoins, 1, 1e6);
  checkFraction('breadthMinRunUp', p.breadthMinRunUp);
  checkFraction('breadthMinPullback', p.breadthMinPullback);
  checkRange('breadthStakeSol', p.breadthStakeSol, 0, p.stakeSol);
  checkRange('breadthMaxHoldSlots', p.breadthMaxHoldSlots, 1, p.maxHoldSlots);
  checkRange('maxExposureSol', p.maxExposureSol, p.stakeSol, 1e9);

  if (problems.length > 0) {
    throw new Error(`invalid strategy params: ${problems.join('; ')}`);
  }
}

export function createBot(p: Params = DEFAULT_PARAMS) {
  validateParams(p);

  // --- Mutable bookkeeping -------------------------------------------------
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, HeldPosition>();
  const roundTripped = new Set<Pubkey>();
  const boughtMints = new Set<Pubkey>();
  let firstSlot = -1;
  let lastTripSlot = -1;
  /** Portfolio equity peak (SOL) for the drawdown guard; starts at the capital. */
  let peakEquitySol = STARTING_CAPITAL_SOL;

  /** Fetch a mint's tape, creating it on first sight. */
  const tapeOf = (mint: Pubkey): Tape => {
    let tape = tapes.get(mint);
    if (tape === undefined) {
      tape = emptyTape();
      tapes.set(mint, tape);
    }
    return tape;
  };

  /**
   * What a position is worth right now, in SOL, after curve + creator fees and
   * one tx fee: tokens sold back through the constant-product curve at the latest
   * reserves (the batch's mark when there is one, else the curve's own reserves).
   * The same marking feeds both the equity guard and the per-position exit tests,
   * so the two can never disagree about a position's value. Returns null for a
   * completed curve, which has no tradeable value left.
   */
  const valueOfPosition = (
    state: BotState,
    marks: Map<Pubkey, { virtual_quote_reserves: string; virtual_token_reserves: string }>,
    mint: Pubkey,
    tokenAmount: bigint,
  ): number | null => {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return null;
    const mark = marks.get(mint);
    const virtualQuote = mark ? Number(mark.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
    const virtualTokens = mark ? Number(mark.virtual_token_reserves) : Number(curve.virtual_token_reserves);
    const tokens = Number(tokenAmount);
    const txFeeSol = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;
    // Constant-product sale: tokens * vq / (vt + tokens), minus fees and the tx fee.
    return ((tokens * virtualQuote) / (virtualTokens + tokens) / LAMPORTS_PER_SOL) * (1 - SELL_FEE_SHARE) - txFeeSol;
  };

  /**
   * One pass over the recent tape: how many buys, from how many distinct
   * wallets, the net SOL flow, and the lowest price printed in the window. The
   * window is walked backwards and stops at its edge, since trades arrive in
   * slot order.
   */
  const summarizeReturnWindow = (tape: Tape, now: number): ReturnWindow => {
    const windowStart = now - p.returnWindowSlots;
    let buys = 0;
    let net = 0;
    let low = Infinity;
    const buyers = new Set<string>();
    for (let i = tape.trades.length - 1; i >= 0; i--) {
      const trade = tape.trades[i]!;
      if (trade.slot <= windowStart) break;
      if (trade.price < low) low = trade.price;
      if (trade.buy) {
        buys++;
        buyers.add(trade.user);
        net += trade.sol;
      } else {
        net -= trade.sol;
      }
    }
    return { buys, buyers: buyers.size, netSol: net, lowPrice: low };
  };

  /**
   * The dip test: seasoned coin, proven run-up, real pullback, buyers returning,
   * price already bouncing off the window low. `relaxed` selects the breadth
   * fallback's looser thresholds.
   */
  const passesEntryFilter = (tape: Tape, now: number, reserveSol: number, relaxed: boolean): boolean => {
    if (reserveSol < p.minReserveSol || reserveSol > p.maxReserveSol) return false;
    if (tape.createdSlot === null) return false;
    const age = now - tape.createdSlot;
    if (age < p.minAgeSlots || age > p.maxAgeSlots) return false;
    if (tape.basePrice <= 0 || tape.peakPrice <= 0) return false;
    const lastTrade = tape.trades[tape.trades.length - 1];
    if (lastTrade === undefined || !lastTrade.buy) return false;
    const price = lastTrade.price;
    const runUp = tape.peakPrice / tape.basePrice - 1;
    const pullback = 1 - price / tape.peakPrice;
    const minRun = relaxed ? p.breadthMinRunUp : p.minRunUp;
    const minPull = relaxed ? p.breadthMinPullback : p.minPullback;
    if (runUp < minRun || pullback < minPull) return false;
    if (price < tape.basePrice * (1 + p.minAboveBase)) return false;
    // The peak must still be fresh: a run-up from long ago is not a live setup.
    const peakAge = now - tape.peakSlot;
    if (peakAge > p.peakFreshSlots) return false;
    // Buyers returning: the recent tape must be buy-heavy with several distinct wallets.
    const window = summarizeReturnWindow(tape, now);
    if (window.buys < p.minReturnBuys || window.buyers < p.minReturnBuyers) return false;
    if (window.netSol < p.minReturnNetSol) return false;
    // Bounce: the price must already be lifting off the window low, not still falling.
    if (window.lowPrice === Infinity || price < window.lowPrice * (1 + p.minBounce)) return false;
    return true;
  };

  /**
   * Fold one batch's fills into the round-trip book. Harness closes (client_id
   * starting with `_`) are not ours and must not count as round trips.
   */
  const recordFills = (batch: Batch, now: number): void => {
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.client_id.startsWith('_')) continue;
      if (fill.side === 'buy' && Number(fill.quote_lamports) >= 10_000_000) {
        boughtMints.add(fill.mint);
      }
      if (fill.side === 'sell' && boughtMints.has(fill.mint) && !roundTripped.has(fill.mint)) {
        roundTripped.add(fill.mint);
        lastTripSlot = now;
      }
    }
  };

  /**
   * Fold one batch's events into the tapes, and report which mints traded in
   * this batch (entries only consider coins traded in the current batch).
   */
  const recordEvents = (batch: Batch): Set<Pubkey> => {
    const tradedNow = new Set<Pubkey>();
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        tapeOf(event.mint).createdSlot = event.slot;
      } else if (event.event === 'TradeEvent') {
        const tape = tapeOf(event.mint);
        const price = Number(event.virtual_quote_reserves) / Math.max(1, Number(event.virtual_token_reserves));
        if (tape.basePrice <= 0) {
          tape.basePrice = price;
        } else if (price < tape.basePrice && tape.trades.length < 4) {
          // Early dips still refine the base while the tape is young.
          tape.basePrice = price;
        }
        if (price > tape.peakPrice) {
          tape.peakPrice = price;
          tape.peakSlot = event.slot;
        }
        tape.trades.push({
          slot: event.slot,
          buy: event.is_buy,
          sol: Number(event.sol_amount) / LAMPORTS_PER_SOL,
          user: event.user,
          price,
        });
        tape.lastTradeSlot = event.slot;
        tradedNow.add(event.mint);
      }
    }
    return tradedNow;
  };

  /** Drop tape history older than the longest window any rule can still read. */
  const pruneOldTrades = (tradedNow: Set<Pubkey>, now: number): void => {
    for (const mint of tradedNow) {
      const tape = tapes.get(mint)!;
      let cut = 0;
      while (cut < tape.trades.length && tape.trades[cut]!.slot <= now - TAPE_KEEP_SLOTS) cut++;
      if (cut > 0) tape.trades.splice(0, cut);
    }
  };

  /** Which mints have an order still in flight, and which of those are sells. */
  const pendingMints = (state: BotState): { all: Set<Pubkey>; sells: Set<Pubkey> } => {
    const all = new Set<Pubkey>();
    const sells = new Set<Pubkey>();
    for (const pending of state.pending.values()) {
      all.add(pending.order.mint);
      if (pending.order.side === 'sell') sells.add(pending.order.mint);
    }
    return { all, sells };
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      if (firstSlot < 0) firstSlot = now;

      recordFills(batch, now);
      const tradedNow = recordEvents(batch);
      pruneOldTrades(tradedNow, now);

      const marks = new Map(batch.marks.map((mark) => [mark.mint, mark] as const));
      const pending = pendingMints(state);
      const orders: OrderInput[] = [];
      const orderCap = state.hello.caps.max_orders_per_batch;
      const txFeeSol = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;

      // Breadth fallback: if round trips stall while the 20-coin bar is unmet,
      // loosen the entry filter until trips resume.
      const slotsSinceTrip = lastTripSlot < 0 ? now - firstSlot : now - lastTripSlot;
      const breadthMode = roundTripped.size < p.breadthTargetCoins && slotsSinceTrip > p.breadthStallSlots;

      // Portfolio drawdown guard: equity is cash plus the marked value of open
      // positions. A 15% drawdown from the equity peak halts new entries; a 30%
      // drawdown flattens the whole book. The house guardrail is 50%, so this
      // keeps a wide safety margin.
      let equitySol = Number(state.cash) / LAMPORTS_PER_SOL;
      for (const [mint, position] of state.positions) {
        const valueSol = valueOfPosition(state, marks, mint, position.token_amount);
        if (valueSol !== null) equitySol += valueSol;
      }
      if (equitySol > peakEquitySol) peakEquitySol = equitySol;
      const flattenAll = equitySol < peakEquitySol * (1 - p.ddFlatten);
      const haltEntries = flattenAll || equitySol < peakEquitySol * (1 - p.ddHalt);

      // --- Exits first ------------------------------------------------------
      // Every held position is re-marked and tested against the mechanical rules.
      for (const [mint, heldPos] of held) {
        const position = state.positions.get(mint);
        if (position === undefined) {
          // Our position is gone: drop the tracker unless a fill for it is still
          // in flight.
          if (!pending.all.has(mint)) {
            held.delete(mint);
            const tape = tapeOf(mint);
            if (heldPos.filled) tape.lastExitSlot = now;
            else tape.entries--;
          }
          continue;
        }
        heldPos.filled = true;
        const valueSol = valueOfPosition(state, marks, mint, position.token_amount);
        if (valueSol === null) continue;
        const costSol = Number(position.cost_lamports) / LAMPORTS_PER_SOL;
        if (valueSol > heldPos.peakValueSol) heldPos.peakValueSol = valueSol;

        let shouldExit = heldPos.exiting;
        if (!shouldExit && flattenAll) shouldExit = true;
        if (!shouldExit && valueSol < costSol * (1 - p.stopLoss)) shouldExit = true;
        if (!shouldExit && valueSol > costSol * (1 + p.takeProfit)) shouldExit = true;
        if (
          !shouldExit &&
          heldPos.peakValueSol >= costSol * (1 + p.trailArm) &&
          valueSol < heldPos.peakValueSol * (1 - p.trailDrop)
        ) {
          shouldExit = true;
        }
        if (!shouldExit && now - tapeOf(mint).lastTradeSlot > p.deadTapeSlots) shouldExit = true;
        const holdLimit = heldPos.breadth ? p.breadthMaxHoldSlots : p.maxHoldSlots;
        if (!shouldExit && now - heldPos.openedSlot > holdLimit) shouldExit = true;
        if (!shouldExit) continue;

        heldPos.exiting = true;
        if (pending.sells.has(mint)) continue;
        if (orders.length >= orderCap) break;
        orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
      }

      // --- Entries ----------------------------------------------------------
      // One fixed stake per fresh position, only on coins traded in this batch.
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS_PER_SOL;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposureSol = 0;
      for (const mint of held.keys()) {
        const position = state.positions.get(mint);
        if (position !== undefined) exposureSol += Number(position.cost_lamports) / LAMPORTS_PER_SOL;
      }
      for (const mint of tradedNow) {
        if (haltEntries) break;
        if (orders.length >= orderCap) break;
        if (slotsLeft <= 0 || held.size >= p.maxOpenPositions) break;
        if (held.has(mint) || pending.all.has(mint) || state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const tape = tapes.get(mint)!;
        if (tape.entries >= p.maxEntriesPerMint || now - tape.lastExitSlot < p.cooldownSlots) continue;
        const reserveSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
        if (!passesEntryFilter(tape, now, reserveSol, breadthMode)) continue;
        const stake = breadthMode ? p.breadthStakeSol : p.stakeSol;
        const buyCapSol = Number(state.maxBuyLamports(mint)) / LAMPORTS_PER_SOL;
        let amount = Math.min(stake, buyCapSol, p.maxExposureSol - exposureSol);
        if (amount > freeSol - txFeeSol) amount = freeSol - txFeeSol;
        if (amount < p.minStakeSol) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS_PER_SOL)),
          max_slippage_bps: p.buySlipBps,
        });
        held.set(mint, { openedSlot: now, peakValueSol: 0, breadth: breadthMode, exiting: false, filled: false });
        tape.entries++;
        freeSol -= amount + txFeeSol;
        exposureSol += amount;
        slotsLeft--;
      }
      return orders;
    },
  };
}
