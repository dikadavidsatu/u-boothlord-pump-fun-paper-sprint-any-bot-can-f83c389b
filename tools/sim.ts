// Local replay of the pump.fun bonding-curve market, written for this entry's
// backtest. It models the same market the house harness models, in my own compact
// form:
//
//   - a constant-product curve on virtual reserves;
//   - 95 bps protocol + 30 bps creator fees on each side (per-trade overrides
//     from the landing trade when it carries them);
//   - a 5,000 + 100,000 lamport tx fee per order;
//   - 2-slot fill latency;
//   - the 1%-of-real-reserve per-batch buy cap;
//   - at most 5 open positions;
//   - a deterministic 2% failed-tx draw seeded from the run seed (sha256 of
//     seed/seq/index — my own draw, no clock, no randomness).
//
// The bot itself never imports this file; only tools/backtest.ts uses it offline.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { BotState, type Batch, type Bot, type Fill, type Hello, type Mark, type Order } from '../vendor/makefun-bot.ts';

/** Basis points in 100%. */
const BPS = 10_000n;

export interface Dataset {
  sha256: string;
  endSlot: number;
  batches: { slot: number; events: any[] }[];
}

/**
 * Load the kit's dev dataset: gunzip the three event parts, keep only the mints
 * in the sampled universe (sha256(mint) % modulus == residue, SOL quote mint,
 * no mayhem, no cashback, not excluded), and group the surviving events into
 * per-slot batches in arrival order.
 */
export function loadDataset(kit: string): Dataset {
  const kitJson = JSON.parse(readFileSync(`${kit}/kit.json`, 'utf8'));
  const manifest = JSON.parse(readFileSync(`${kit}/dataset/manifest.json`, 'utf8'));
  const { modulus, residue } = manifest.universe.sample;
  const excluded = new Set<string>(manifest.excluded_mints ?? []);
  const members = new Set<string>();
  const events: any[] = [];
  let lastSlot = 0;
  for (const part of ['part-00000', 'part-00001', 'part-00002']) {
    const raw = gunzipSync(readFileSync(`${kit}/dataset/events/${part}.ndjson.gz`)).toString('utf8');
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      const event = JSON.parse(line);
      lastSlot = event.slot;
      if (event.event === 'CreateEvent' && !members.has(event.mint)) {
        const hash = BigInt('0x' + createHash('sha256').update(event.mint, 'utf8').digest('hex'));
        const inSample =
          event.quote_mint === '11111111111111111111111111111111' &&
          !event.is_mayhem_mode &&
          !event.is_cashback_enabled &&
          !excluded.has(event.mint) &&
          hash % BigInt(modulus) === BigInt(residue);
        if (inSample) members.add(event.mint);
      }
      if (members.has(event.mint)) events.push(event);
    }
  }
  const batches: { slot: number; events: any[] }[] = [];
  for (const event of events) {
    const tail = batches[batches.length - 1];
    if (tail !== undefined && tail.slot === event.slot) tail.events.push(event);
    else batches.push({ slot: event.slot, events: [event] });
  }
  return { sha256: kitJson.dataset_sha256, endSlot: manifest.window?.end_slot ?? lastSlot, batches };
}

/** The hello the local replay hands the bot: 10 SOL capital, the house caps and fees. */
export function makeHello(seed: string): Hello {
  return {
    type: 'hello',
    protocol: 'agent-fun/replay/v2',
    seed,
    universe: {
      program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      quote: 'SOL',
      mayhem: 'excluded',
      exclude_cashback: true,
      sample: { hash: 'sha256', modulus: 16, residue: 15 },
    },
    capital: { lamports: '10000000000' },
    caps: {
      max_open_positions: 5,
      max_order_bps_of_real_reserve: 100,
      max_orders_per_batch: 16,
      shorts: false,
      leverage: false,
    },
    latency_slots: 2,
    fees: {
      protocol_bps_fallback: 95,
      creator_bps_fallback: 30,
      base_fee_lamports: '5000',
      priority_fee_lamports: '100000',
      failed_tx_bps: 200,
    },
  };
}

/** One bonding curve's live reserves, plus the last trade seen on it. */
interface Curve {
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
  complete: boolean;
  lastTrade: any | null;
}

/** An order the bot sent, waiting for its fill slot. */
interface PendingOrder {
  order: Order;
  seq: number;
  index: number;
  decidedSlot: number;
  fillSlot: number;
  reject: string | null;
  decisionVq: bigint;
  decisionVt: bigint;
  decisionRq: bigint;
}

/** One completed round trip on one mint, from open fill to close fill. */
export interface Trip {
  mint: string;
  open: number;
  close: number;
  pnl: bigint;
}

/** Everything the backtest reports about one run. */
export interface SimResult {
  netPnl: bigint;
  fills: number;
  mints: number;
  rejected: number;
  failed: number;
  maxDrawdown: number;
  trips: Trip[];
  rejectReasons: Record<string, number>;
}

/** Integer division rounding up — fees always round against the trader. */
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
/** A bps fee on an amount, rounded up. */
const feeOf = (amount: bigint, bps: bigint): bigint => ceilDiv(amount * bps, BPS);

/**
 * Run the bot over the dataset through the vendored BotState shim and return
 * the PnL, fills, trips and drawdown. Fully deterministic: the only
 * "randomness" is the seeded failed-tx draw, and every iteration order is
 * sorted or insertion-ordered.
 */
export function simulate(ds: Dataset, hello: Hello, bot: Bot): SimResult {
  const txFee = BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports);
  const latency = hello.latency_slots;
  const curves = new Map<string, Curve>();
  const pending: PendingOrder[] = [];
  const usedIds = new Set<string>();
  const positions = new Map<string, { tokens: bigint; cost: bigint }>();
  const startCash = BigInt(hello.capital.lamports);
  let cash = startCash;
  let undelivered: Fill[] = [];
  let seq = 0;
  let closeCounter = 0;
  let fills = 0;
  let rejected = 0;
  let failed = 0;
  const rejectReasons: Record<string, number> = {};
  const filledMints = new Set<string>();
  const perMintPnl = new Map<string, bigint>();
  const openTrips = new Map<string, { pnl: bigint; open: number }>();
  const trips: Trip[] = [];
  let peakEquity = startCash;
  let maxDrawdown = 0;
  // Per-batch buy cap accounting: reset whenever the batch sequence advances.
  const spentThisBatch = { seq: -1, byMint: new Map<string, bigint>() };

  // --- Deterministic helpers ------------------------------------------------

  /** The 2% failed-tx draw: sha256(seed:seq:index), first two bytes mod 10,000. */
  const isFailedTx = (batchSeq: number, orderIndex: number): boolean => {
    const digest = createHash('sha256').update(`${hello.seed}:${batchSeq}:${orderIndex}`).digest();
    return (digest.readUInt16BE(0) % 10_000) < hello.fees.failed_tx_bps;
  };

  /** Fees for a curve: the landing trade's bps when it carries them, else the fallbacks. */
  const feesForCurve = (landing: any | null): { protocol: bigint; creator: bigint } => ({
    protocol:
      landing !== null && BigInt(landing.fee_basis_points) > 0n
        ? BigInt(landing.fee_basis_points)
        : BigInt(hello.fees.protocol_bps_fallback),
    creator:
      landing !== null && BigInt(landing.creator_fee_basis_points) > 0n
        ? BigInt(landing.creator_fee_basis_points)
        : BigInt(hello.fees.creator_bps_fallback),
  });

  // Constant-product quotes on virtual reserves.
  const tokensForSpend = (spendNet: bigint, curve: Curve): bigint =>
    spendNet <= 1n ? 0n : ((spendNet - 1n) * curve.vt) / (curve.vq + spendNet - 1n);
  const quoteForTokens = (tokens: bigint, curve: Curve): bigint => (tokens * curve.vq) / (curve.vt + tokens);
  /** A sale's proceeds after protocol + creator fees. */
  const proceedsAfterFees = (quote: bigint, fees: { protocol: bigint; creator: bigint }): bigint =>
    quote - feeOf(quote, fees.protocol) - feeOf(quote, fees.creator);

  /**
   * What a position would net if sold now: quote through the curve, capped at
   * the real reserves, minus curve + creator fees and the tx fee. `abandon` is
   * true when the sale would not even cover its own tx fee.
   */
  const closeValue = (mint: string, tokens: bigint): { net: bigint; abandon: boolean } => {
    const curve = curves.get(mint)!;
    const fees = feesForCurve(curve.lastTrade);
    const quote = quoteForTokens(tokens, curve);
    const capped = quote > curve.rq ? curve.rq : quote;
    const proceeds = proceedsAfterFees(capped, fees);
    return { net: proceeds - txFee, abandon: proceeds - txFee <= 0n };
  };

  /** Current equity: cash plus the close value of every open position. */
  const equityNow = (): bigint => {
    let equity = cash;
    for (const [mint, position] of positions) {
      const value = closeValue(mint, position.tokens);
      if (!value.abandon) equity += value.net;
    }
    return equity;
  };

  /** Fold a fresh equity reading into the peak / max-drawdown trackers. */
  const trackEquity = (equity: bigint): void => {
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = Number(peakEquity - equity) / Number(peakEquity);
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  };

  /** Attribute a cash flow to a mint's running PnL (and to its open trip, if any). */
  const recordFlow = (mint: string, delta: bigint): void => {
    perMintPnl.set(mint, (perMintPnl.get(mint) ?? 0n) + delta);
    const open = openTrips.get(mint);
    if (open) open.pnl += delta;
  };

  /** Close out a mint's open trip record at a slot. */
  const finishTrip = (mint: string, slot: number): void => {
    const open = openTrips.get(mint);
    if (!open) return;
    trips.push({ mint, open: open.open, close: slot, pnl: open.pnl });
    openTrips.delete(mint);
  };

  /** Emit a fill (filled / rejected / failed) for a pending order. */
  const emitFill = (p: PendingOrder, status: Fill['status'], reason: string | null, quote: bigint, tokens: bigint): void => {
    if (status === 'rejected') {
      rejected++;
      rejectReasons[reason!] = (rejectReasons[reason!] ?? 0) + 1;
    }
    if (status === 'failed') failed++;
    if (status === 'filled') {
      fills++;
      filledMints.add(p.order.mint);
    }
    undelivered.push({
      client_id: p.order.client_id,
      mint: p.order.mint,
      side: p.order.side,
      status,
      reason: reason as Fill['reason'],
      decided_slot: p.decidedSlot,
      slot: p.fillSlot,
      quote_lamports: quote.toString(),
      token_amount: tokens.toString(),
      fee_lamports: '0',
      tx_fee_lamports: status === 'rejected' ? '0' : txFee.toString(),
      fee_fallback: false,
    });
  };

  /** Number of open positions with tokens (a zero-token row is not a position). */
  const openPositionCount = (): number => {
    let count = 0;
    for (const position of positions.values()) if (position.tokens > 0n) count++;
    return count;
  };

  // --- Order resolution -----------------------------------------------------

  /** Resolve one pending order at its fill slot: fills, rejects, or failed-tx. */
  const resolveOrder = (p: PendingOrder): void => {
    if (p.reject !== null) return emitFill(p, 'rejected', p.reject, 0n, 0n);
    const curve = curves.get(p.order.mint)!;
    if (curve.complete) return emitFill(p, 'rejected', 'token_complete', 0n, 0n);
    const fees = feesForCurve(curve.lastTrade);
    const slippage = BigInt(p.order.max_slippage_bps);

    if (p.order.side === 'sell') {
      const position = positions.get(p.order.mint);
      const tokens = BigInt(p.order.token_amount);
      if (position === undefined || position.tokens < tokens) {
        return emitFill(p, 'rejected', 'insufficient_tokens', 0n, 0n);
      }
      const quote = quoteForTokens(tokens, curve);
      if (quote > curve.rq) return emitFill(p, 'rejected', 'max_order_size', 0n, 0n);
      const proceeds = proceedsAfterFees(quote, fees);
      if (proceeds <= 0n) return emitFill(p, 'rejected', 'zero_amount', 0n, 0n);
      // Slippage is measured against the quote at decision time.
      const expectedQuote = quoteForTokens(tokens, {
        vq: p.decisionVq,
        vt: p.decisionVt,
        rq: 0n,
        rt: 0n,
        complete: false,
        lastTrade: null,
      });
      const expectedProceeds = proceedsAfterFees(expectedQuote, fees);
      if (proceeds * BPS < expectedProceeds * (BPS - slippage)) {
        return emitFill(p, 'rejected', 'max_slippage', 0n, 0n);
      }
      if (cash < txFee) return emitFill(p, 'rejected', 'insufficient_cash', 0n, 0n);
      if (isFailedTx(p.seq, p.index)) {
        cash -= txFee;
        recordFlow(p.order.mint, -txFee);
        return emitFill(p, 'failed', null, 0n, 0n);
      }
      cash += proceeds - txFee;
      recordFlow(p.order.mint, proceeds - txFee);
      const removedCost = position.tokens === tokens ? position.cost : (position.cost * tokens) / position.tokens;
      position.tokens -= tokens;
      position.cost -= removedCost;
      // Selling moves the curve: quote out, tokens in.
      curve.vq -= quote;
      curve.rq -= quote;
      curve.vt += tokens;
      curve.rt += tokens;
      if (position.tokens === 0n) {
        positions.delete(p.order.mint);
        finishTrip(p.order.mint, p.fillSlot);
      }
      return emitFill(p, 'filled', null, proceeds, tokens);
    }

    // Buy side.
    const spend = BigInt(p.order.quote_lamports);
    const held = positions.get(p.order.mint);
    if ((held === undefined || held.tokens === 0n) && openPositionCount() >= hello.caps.max_open_positions) {
      return emitFill(p, 'rejected', 'max_open_positions', 0n, 0n);
    }
    if (spentThisBatch.seq !== p.seq) {
      spentThisBatch.seq = p.seq;
      spentThisBatch.byMint.clear();
    }
    const batchTotal = (spentThisBatch.byMint.get(p.order.mint) ?? 0n) + spend;
    if (batchTotal * BPS > p.decisionRq * BigInt(hello.caps.max_order_bps_of_real_reserve)) {
      return emitFill(p, 'rejected', 'max_order_size', 0n, 0n);
    }
    spentThisBatch.byMint.set(p.order.mint, batchTotal);
    // Exact-in buy: strip curve fees, then constant-product tokens out.
    const net0 = (spend * BPS) / (BPS + fees.protocol + fees.creator);
    const protocolFee = feeOf(net0, fees.protocol);
    const creatorFee = feeOf(net0, fees.creator);
    const over = net0 + protocolFee + creatorFee > spend ? net0 + protocolFee + creatorFee - spend : 0n;
    const spendNet = net0 - over;
    let tokens = tokensForSpend(spendNet, curve);
    let paid = spendNet + protocolFee + creatorFee;
    if (tokens > curve.rt) {
      // Not enough real tokens left: take them all and reprice the spend.
      tokens = curve.rt;
      if (tokens === 0n) return emitFill(p, 'rejected', 'zero_amount', 0n, 0n);
      const repriced = (tokens * curve.vq) / (curve.vt - tokens) + 1n;
      paid = repriced + feeOf(repriced, fees.protocol) + feeOf(repriced, fees.creator);
    }
    if (tokens === 0n) return emitFill(p, 'rejected', 'zero_amount', 0n, 0n);
    const expectedTokens = tokensForSpend(spendNet, {
      vq: p.decisionVq,
      vt: p.decisionVt,
      rq: 0n,
      rt: 0n,
      complete: false,
      lastTrade: null,
    });
    if (tokens * BPS < expectedTokens * (BPS - slippage)) {
      return emitFill(p, 'rejected', 'max_slippage', 0n, 0n);
    }
    if (cash < spend + txFee) return emitFill(p, 'rejected', 'insufficient_cash', 0n, 0n);
    if (isFailedTx(p.seq, p.index)) {
      cash -= txFee;
      recordFlow(p.order.mint, -txFee);
      return emitFill(p, 'failed', null, 0n, 0n);
    }
    cash -= paid + txFee;
    let position = held;
    const opening = position === undefined || position.tokens === 0n;
    if (position === undefined) {
      position = { tokens: 0n, cost: 0n };
      positions.set(p.order.mint, position);
    }
    if (opening) openTrips.set(p.order.mint, { pnl: 0n, open: p.fillSlot });
    recordFlow(p.order.mint, -(paid + txFee));
    position.tokens += tokens;
    position.cost += paid;
    curve.vq += spendNet;
    curve.rq += spendNet;
    curve.vt -= tokens;
    curve.rt -= tokens;
    return emitFill(p, 'filled', null, paid, tokens);
  };

  /**
   * Force-close a position at a slot (curve completed, or the replay ended):
   * sell through the curve like a normal exit, or write it off when the sale
   * would not cover its own tx fee. The fill carries a harness-style `_` id so
   * the bot's round-trip book does not count it as its own sell.
   */
  const forceClose = (mint: string, why: string, slot: number): void => {
    const position = positions.get(mint)!;
    const curve = curves.get(mint)!;
    const value = closeValue(mint, position.tokens);
    const n = closeCounter++;
    const kind = value.abandon ? 'writeoff' : why;
    if (!value.abandon) {
      cash += value.net;
      recordFlow(mint, value.net);
      const quote = quoteForTokens(position.tokens, curve);
      curve.vq -= quote;
      curve.rq -= quote;
      curve.vt += position.tokens;
      curve.rt += position.tokens;
    }
    undelivered.push({
      client_id: `_${kind}_${n}`,
      mint,
      side: 'sell',
      status: 'filled',
      reason: null,
      decided_slot: slot,
      slot,
      quote_lamports: value.abandon ? '0' : (value.net + txFee).toString(),
      token_amount: position.tokens.toString(),
      fee_lamports: '0',
      tx_fee_lamports: value.abandon ? '0' : txFee.toString(),
      fee_fallback: false,
    });
    positions.delete(mint);
    finishTrip(mint, slot);
  };

  // --- Batch plumbing -------------------------------------------------------

  /** The account snapshot the harness hands the bot each batch. */
  const accountSnapshot = (): { cash_lamports: string; positions: { mint: string; token_amount: string; cost_lamports: string }[] } => ({
    cash_lamports: cash.toString(),
    positions: [...positions.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([mint, position]) => ({
        mint,
        token_amount: position.tokens.toString(),
        cost_lamports: position.cost.toString(),
      })),
  });

  /** Marks for every held mint plus every mint with an order in flight, sorted. */
  const currentMarks = (): Mark[] => {
    const wanted = new Set<string>(positions.keys());
    for (const p of pending) if (curves.has(p.order.mint)) wanted.add(p.order.mint);
    return [...wanted].sort().map((mint) => {
      const curve = curves.get(mint)!;
      return {
        mint,
        slot: 0,
        virtual_token_reserves: curve.vt.toString(),
        virtual_quote_reserves: curve.vq.toString(),
        real_token_reserves: curve.rt.toString(),
        real_quote_reserves: curve.rq.toString(),
      };
    });
  };

  // --- Main loop ------------------------------------------------------------

  const state = new BotState(hello);
  bot.onHello?.(state);
  for (const batchData of ds.batches) {
    const slot = batchData.slot;
    // Resolve anything whose fill slot is strictly before this batch.
    while (pending.length > 0 && pending[0]!.fillSlot < slot) resolveOrder(pending.shift()!);
    const completed: string[] = [];
    for (const event of batchData.events) {
      if (event.event === 'CreateEvent') {
        curves.set(event.mint, {
          vq: BigInt(event.virtual_quote_reserves),
          vt: BigInt(event.virtual_token_reserves),
          rq: 0n,
          rt: BigInt(event.real_token_reserves),
          complete: false,
          lastTrade: null,
        });
      } else if (event.event === 'TradeEvent') {
        const curve = curves.get(event.mint)!;
        curve.vq = BigInt(event.virtual_quote_reserves);
        curve.vt = BigInt(event.virtual_token_reserves);
        curve.rq = BigInt(event.real_quote_reserves);
        curve.rt = BigInt(event.real_token_reserves);
        curve.lastTrade = event;
      } else {
        curves.get(event.mint)!.complete = true;
        completed.push(event.mint);
      }
    }
    for (const mint of completed) if (positions.has(mint)) forceClose(mint, 'complete', slot);
    // Then resolve anything filling exactly at this slot, before the bot answers.
    while (pending.length > 0 && pending[0]!.fillSlot === slot) resolveOrder(pending.shift()!);

    const batch: Batch = {
      type: 'batch',
      seq,
      slot,
      events: batchData.events,
      marks: currentMarks(),
      fills: undelivered,
      account: accountSnapshot(),
    };
    undelivered = [];
    trackEquity(equityNow());
    state.applyBatch(batch);
    const orders = state.toOrders(bot.onBatch(state, batch) as any);
    state.recordOrders(orders);
    orders.forEach((order, index) => {
      let reject: string | null = null;
      const amount = order.side === 'buy' ? order.quote_lamports : order.token_amount;
      if (index >= hello.caps.max_orders_per_batch) reject = 'max_orders_per_batch';
      else if (usedIds.has(order.client_id)) reject = 'duplicate_client_id';
      else if (amount === '0') reject = 'zero_amount';
      else if (!curves.has(order.mint)) reject = 'not_in_universe';
      usedIds.add(order.client_id);
      const curve = curves.get(order.mint);
      pending.push({
        order,
        seq,
        index,
        decidedSlot: slot,
        fillSlot: slot + latency,
        reject,
        decisionVq: curve ? curve.vq : 0n,
        decisionVt: curve ? curve.vt : 0n,
        decisionRq: curve ? curve.rq : 0n,
      });
    });
    seq++;
  }

  // Drain whatever is still in flight, then flatten the book at the end slot.
  while (pending.length > 0) {
    const p = pending.shift()!;
    if (p.fillSlot > ds.endSlot) emitFill(p, 'rejected', 'after_end', 0n, 0n);
    else resolveOrder(p);
  }
  for (const mint of [...positions.keys()].sort()) forceClose(mint, 'flatten', ds.endSlot);
  trackEquity(cash);
  return {
    netPnl: cash - startCash,
    fills,
    mints: filledMints.size,
    rejected,
    failed,
    maxDrawdown,
    trips,
    rejectReasons,
  };
}
