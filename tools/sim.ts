// Local replay of the pump.fun bonding-curve market, written for this entry's backtest.
// It models the same market the house harness models, in my own compact form: a
// constant-product curve (virtual reserves), 95 bps protocol + 30 bps creator fees on each
// side, a 5,000 + 100,000 lamport tx fee per order, 2-slot fill latency, the 1%-of-real-
// reserve per-batch buy cap, at most 5 open positions, and a deterministic 2% failed-tx
// draw seeded from the run seed (sha256 of seed/seq/index, my own draw, no clock).
// The bot itself never imports this file; only tools/backtest.ts uses it offline.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { BotState, type Batch, type Bot, type Fill, type Hello, type Mark, type Order } from '../vendor/makefun-bot.ts';

const BPS = 10_000n;

export interface Dataset {
  sha256: string;
  endSlot: number;
  batches: { slot: number; events: any[] }[];
}

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
      const e = JSON.parse(line);
      lastSlot = e.slot;
      if (e.event === 'CreateEvent' && !members.has(e.mint)) {
        const h = BigInt('0x' + createHash('sha256').update(e.mint, 'utf8').digest('hex'));
        if (e.quote_mint === '11111111111111111111111111111111' && !e.is_mayhem_mode && !e.is_cashback_enabled && !excluded.has(e.mint) && h % BigInt(modulus) === BigInt(residue)) {
          members.add(e.mint);
        }
      }
      if (members.has(e.mint)) events.push(e);
    }
  }
  const batches: { slot: number; events: any[] }[] = [];
  for (const e of events) {
    const tail = batches[batches.length - 1];
    if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
    else batches.push({ slot: e.slot, events: [e] });
  }
  return { sha256: kitJson.dataset_sha256, endSlot: manifest.window?.end_slot ?? lastSlot, batches };
}

export function makeHello(seed: string): Hello {
  return {
    type: 'hello',
    protocol: 'agent-fun/replay/v2',
    seed,
    universe: { program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', quote: 'SOL', mayhem: 'excluded', exclude_cashback: true, sample: { hash: 'sha256', modulus: 16, residue: 15 } },
    capital: { lamports: '10000000000' },
    caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100, max_orders_per_batch: 16, shorts: false, leverage: false },
    latency_slots: 2,
    fees: { protocol_bps_fallback: 95, creator_bps_fallback: 30, base_fee_lamports: '5000', priority_fee_lamports: '100000', failed_tx_bps: 200 },
  };
}

interface Curve {
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
  complete: boolean;
  lastTrade: any | null;
}
interface Pending {
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

export interface Trip {
  mint: string;
  open: number;
  close: number;
  pnl: bigint;
}
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

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const feeOf = (amount: bigint, bps: bigint) => ceilDiv(amount * bps, BPS);

export function simulate(ds: Dataset, hello: Hello, bot: Bot): SimResult {
  const txFee = BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports);
  const latency = hello.latency_slots;
  const curves = new Map<string, Curve>();
  const pending: Pending[] = [];
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
  const perMint = new Map<string, bigint>();
  const openPnl = new Map<string, { pnl: bigint; open: number }>();
  const trips: Trip[] = [];
  let peak = startCash;
  let maxDd = 0;
  const spent = { seq: -1, byMint: new Map<string, bigint>() };

  const failedDraw = (s: number, i: number): boolean => {
    const h = createHash('sha256').update(`${hello.seed}:${s}:${i}`).digest();
    return (h.readUInt16BE(0) % 10_000) < hello.fees.failed_tx_bps;
  };
  const feesFor = (landing: any | null) => ({
    protocol: landing !== null && BigInt(landing.fee_basis_points) > 0n ? BigInt(landing.fee_basis_points) : BigInt(hello.fees.protocol_bps_fallback),
    creator: landing !== null && BigInt(landing.creator_fee_basis_points) > 0n ? BigInt(landing.creator_fee_basis_points) : BigInt(hello.fees.creator_bps_fallback),
  });
  // Constant-product quotes on virtual reserves.
  const buyTokens = (spendNet: bigint, c: Curve) => (spendNet <= 1n ? 0n : ((spendNet - 1n) * c.vt) / (c.vq + spendNet - 1n));
  const sellQuote = (t: bigint, c: Curve) => (t * c.vq) / (c.vt + t);
  const closeValue = (mint: string, tokens: bigint): { net: bigint; abandon: boolean } => {
    const c = curves.get(mint)!;
    const f = feesFor(c.lastTrade);
    const q = sellQuote(tokens, c);
    const capped = q > c.rq ? c.rq : q;
    const proceeds = capped - feeOf(capped, f.protocol) - feeOf(capped, f.creator);
    return { net: proceeds - txFee, abandon: proceeds - txFee <= 0n };
  };
  const equityNow = () => {
    let e = cash;
    for (const [mint, p] of positions) {
      const v = closeValue(mint, p.tokens);
      if (!v.abandon) e += v.net;
    }
    return e;
  };
  const pushEquity = (e: bigint) => {
    if (e > peak) peak = e;
    const dd = Number(peak - e) / Number(peak);
    if (dd > maxDd) maxDd = dd;
  };
  const flow = (mint: string, d: bigint) => {
    perMint.set(mint, (perMint.get(mint) ?? 0n) + d);
    const o = openPnl.get(mint);
    if (o) o.pnl += d;
  };
  const closeTrip = (mint: string, slot: number) => {
    const o = openPnl.get(mint);
    if (!o) return;
    trips.push({ mint, open: o.open, close: slot, pnl: o.pnl });
    openPnl.delete(mint);
  };
  const pushFill = (p: Pending, status: Fill['status'], reason: string | null, quote: bigint, tokens: bigint) => {
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
      client_id: p.order.client_id, mint: p.order.mint, side: p.order.side, status,
      reason: reason as Fill['reason'], decided_slot: p.decidedSlot, slot: p.fillSlot,
      quote_lamports: quote.toString(), token_amount: tokens.toString(),
      fee_lamports: '0', tx_fee_lamports: status === 'rejected' ? '0' : txFee.toString(), fee_fallback: false,
    });
  };
  const openCount = () => {
    let n = 0;
    for (const p of positions.values()) if (p.tokens > 0n) n++;
    return n;
  };

  const resolve = (p: Pending): void => {
    if (p.reject !== null) return pushFill(p, 'rejected', p.reject, 0n, 0n);
    const c = curves.get(p.order.mint)!;
    if (c.complete) return pushFill(p, 'rejected', 'token_complete', 0n, 0n);
    const f = feesFor(c.lastTrade);
    const slip = BigInt(p.order.max_slippage_bps);
    if (p.order.side === 'sell') {
      const pos = positions.get(p.order.mint);
      const t = BigInt(p.order.token_amount);
      if (pos === undefined || pos.tokens < t) return pushFill(p, 'rejected', 'insufficient_tokens', 0n, 0n);
      const q = sellQuote(t, c);
      if (q > c.rq) return pushFill(p, 'rejected', 'max_order_size', 0n, 0n);
      const proceeds = q - feeOf(q, f.protocol) - feeOf(q, f.creator);
      if (proceeds <= 0n) return pushFill(p, 'rejected', 'zero_amount', 0n, 0n);
      const expected = sellQuote(t, { vq: p.decisionVq, vt: p.decisionVt, rq: 0n, rt: 0n, complete: false, lastTrade: null });
      const expectedProceeds = expected - feeOf(expected, f.protocol) - feeOf(expected, f.creator);
      if (proceeds * BPS < expectedProceeds * (BPS - slip)) return pushFill(p, 'rejected', 'max_slippage', 0n, 0n);
      if (cash < txFee) return pushFill(p, 'rejected', 'insufficient_cash', 0n, 0n);
      if (failedDraw(p.seq, p.index)) {
        cash -= txFee;
        flow(p.order.mint, -txFee);
        return pushFill(p, 'failed', null, 0n, 0n);
      }
      cash += proceeds - txFee;
      flow(p.order.mint, proceeds - txFee);
      const removed = pos.tokens === t ? pos.cost : (pos.cost * t) / pos.tokens;
      pos.tokens -= t;
      pos.cost -= removed;
      // Selling moves the curve: quote out, tokens in.
      c.vq -= q;
      c.rq -= q;
      c.vt += t;
      c.rt += t;
      if (pos.tokens === 0n) {
        positions.delete(p.order.mint);
        closeTrip(p.order.mint, p.fillSlot);
      }
      return pushFill(p, 'filled', null, proceeds, t);
    }
    const spend = BigInt(p.order.quote_lamports);
    const held = positions.get(p.order.mint);
    if ((held === undefined || held.tokens === 0n) && openCount() >= hello.caps.max_open_positions) {
      return pushFill(p, 'rejected', 'max_open_positions', 0n, 0n);
    }
    if (spent.seq !== p.seq) {
      spent.seq = p.seq;
      spent.byMint.clear();
    }
    const total = (spent.byMint.get(p.order.mint) ?? 0n) + spend;
    if (total * BPS > p.decisionRq * BigInt(hello.caps.max_order_bps_of_real_reserve)) {
      return pushFill(p, 'rejected', 'max_order_size', 0n, 0n);
    }
    spent.byMint.set(p.order.mint, total);
    // Exact-in buy: strip curve fees, then constant-product tokens out.
    const net0 = (spend * BPS) / (BPS + f.protocol + f.creator);
    const fee = feeOf(net0, f.protocol);
    const creatorFee = feeOf(net0, f.creator);
    const over = net0 + fee + creatorFee > spend ? net0 + fee + creatorFee - spend : 0n;
    const q0 = net0 - over;
    let t = buyTokens(q0, c);
    let paid = q0 + fee + creatorFee;
    if (t > c.rt) {
      t = c.rt;
      if (t === 0n) return pushFill(p, 'rejected', 'zero_amount', 0n, 0n);
      const q = (t * c.vq) / (c.vt - t) + 1n;
      paid = q + feeOf(q, f.protocol) + feeOf(q, f.creator);
    }
    if (t === 0n) return pushFill(p, 'rejected', 'zero_amount', 0n, 0n);
    const expectedT = buyTokens(q0, { vq: p.decisionVq, vt: p.decisionVt, rq: 0n, rt: 0n, complete: false, lastTrade: null });
    if (t * BPS < expectedT * (BPS - slip)) return pushFill(p, 'rejected', 'max_slippage', 0n, 0n);
    if (cash < spend + txFee) return pushFill(p, 'rejected', 'insufficient_cash', 0n, 0n);
    if (failedDraw(p.seq, p.index)) {
      cash -= txFee;
      flow(p.order.mint, -txFee);
      return pushFill(p, 'failed', null, 0n, 0n);
    }
    cash -= paid + txFee;
    let pos = held;
    const opening = pos === undefined || pos.tokens === 0n;
    if (pos === undefined) {
      pos = { tokens: 0n, cost: 0n };
      positions.set(p.order.mint, pos);
    }
    if (opening) openPnl.set(p.order.mint, { pnl: 0n, open: p.fillSlot });
    flow(p.order.mint, -(paid + txFee));
    pos.tokens += t;
    pos.cost += paid;
    c.vq += q0;
    c.rq += q0;
    c.vt -= t;
    c.rt -= t;
    return pushFill(p, 'filled', null, paid, t);
  };

  const forceClose = (mint: string, why: string, slot: number) => {
    const pos = positions.get(mint)!;
    const c = curves.get(mint)!;
    const v = closeValue(mint, pos.tokens);
    const n = closeCounter++;
    const kind = v.abandon ? 'writeoff' : why;
    if (!v.abandon) {
      cash += v.net;
      flow(mint, v.net);
      const q = sellQuote(pos.tokens, c);
      c.vq -= q;
      c.rq -= q;
      c.vt += pos.tokens;
      c.rt += pos.tokens;
    }
    undelivered.push({
      client_id: `_${kind}_${n}`, mint, side: 'sell', status: 'filled', reason: null,
      decided_slot: slot, slot, quote_lamports: v.abandon ? '0' : (v.net + txFee).toString(),
      token_amount: pos.tokens.toString(), fee_lamports: '0',
      tx_fee_lamports: v.abandon ? '0' : txFee.toString(), fee_fallback: false,
    });
    positions.delete(mint);
    closeTrip(mint, slot);
  };

  const account = () => ({
    cash_lamports: cash.toString(),
    positions: [...positions.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([mint, p]) => ({ mint, token_amount: p.tokens.toString(), cost_lamports: p.cost.toString() })),
  });
  const marks = (): Mark[] => {
    const want = new Set<string>(positions.keys());
    for (const p of pending) if (curves.has(p.order.mint)) want.add(p.order.mint);
    return [...want].sort().map((mint) => {
      const c = curves.get(mint)!;
      return { mint, slot: 0, virtual_token_reserves: c.vt.toString(), virtual_quote_reserves: c.vq.toString(), real_token_reserves: c.rt.toString(), real_quote_reserves: c.rq.toString() };
    });
  };

  const state = new BotState(hello);
  bot.onHello?.(state);
  for (const b of ds.batches) {
    const x = b.slot;
    while (pending.length > 0 && pending[0]!.fillSlot < x) resolve(pending.shift()!);
    const completed: string[] = [];
    for (const e of b.events) {
      if (e.event === 'CreateEvent') {
        curves.set(e.mint, { vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves), rq: 0n, rt: BigInt(e.real_token_reserves), complete: false, lastTrade: null });
      } else if (e.event === 'TradeEvent') {
        const c = curves.get(e.mint)!;
        c.vq = BigInt(e.virtual_quote_reserves);
        c.vt = BigInt(e.virtual_token_reserves);
        c.rq = BigInt(e.real_quote_reserves);
        c.rt = BigInt(e.real_token_reserves);
        c.lastTrade = e;
      } else {
        curves.get(e.mint)!.complete = true;
        completed.push(e.mint);
      }
    }
    for (const mint of completed) if (positions.has(mint)) forceClose(mint, 'complete', x);
    while (pending.length > 0 && pending[0]!.fillSlot === x) resolve(pending.shift()!);
    const batch: Batch = { type: 'batch', seq, slot: x, events: b.events, marks: marks(), fills: undelivered, account: account() };
    undelivered = [];
    pushEquity(equityNow());
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
      const c = curves.get(order.mint);
      pending.push({
        order, seq, index, decidedSlot: x, fillSlot: x + latency, reject,
        decisionVq: c ? c.vq : 0n, decisionVt: c ? c.vt : 0n, decisionRq: c ? c.rq : 0n,
      });
    });
    seq++;
  }
  while (pending.length > 0) {
    const p = pending.shift()!;
    if (p.fillSlot > ds.endSlot) pushFill(p, 'rejected', 'after_end', 0n, 0n);
    else resolve(p);
  }
  for (const mint of [...positions.keys()].sort()) forceClose(mint, 'flatten', ds.endSlot);
  pushEquity(cash);
  return { netPnl: cash - startCash, fills, mints: filledMints.size, rejected, failed, maxDrawdown: maxDd, trips, rejectReasons };
}
