// PullbackSnap — entry point for the pump.fun paper-trading bot.
//
// The grader runs `node /bot/main.ts` (Node 22 strips the types; no build step, no
// install). This file is only the wiring: it validates the strategy parameters,
// hands the strategy to the vendored protocol shim, and lets the shim own the wire.
//
// The wire protocol is hello / batch / orders / slot, one JSON line at a time on
// stdin/stdout, defined by the competition's harness (agent-fun/replay/v2):
//
//   hello  — once, before the first batch: capital, caps, fees, latency, seed.
//   batch  — once per slot: the slot's events, marks, fills and account.
//   reply  — our answer to each batch: at most caps.max_orders_per_batch orders.
//   done   — once, last: the final account, positions already flattened.
//
// Everything the bot decides lives in strategy.ts (createBot): the dip-buy entry
// filter, the mechanical exits, and the portfolio drawdown guard. This file adds
// nothing to those decisions — it only starts them, checks the parameters up
// front so a nonsense override fails before the first batch is answered, and
// reports progress to stderr (stdout carries replies only, so diagnostics must
// never go there).
//
// Determinism: the bot is a pure function of the batch stream. No clock reads, no
// randomness, no network, no environment reads anywhere in this entry, so two
// runs on the same data produce byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import { createBot, DEFAULT_PARAMS, validateParams } from './strategy.ts';
import type { BotState, Done } from './vendor/makefun-bot.ts';

// Fail fast on a bad parameter set: validateParams throws before the shim reads
// its first line, so a broken override can never trade a single batch.
validateParams(DEFAULT_PARAMS);

// One line per batch would drown the log, so progress is reported sparsely: hello
// once, then a short summary every 5,000 batches and at done. All of it goes to
// stderr — the harness reads replies from stdout, and anything else on stdout
// would corrupt the protocol.
let batchesSeen = 0;
const REPORT_EVERY = 5000;

const strategy = createBot(DEFAULT_PARAMS);

const { state, done } = await runBot({
  onHello(helloState: BotState) {
    const hello = helloState.hello;
    console.error(
      `[pullbacksnap] hello: protocol=${hello.protocol} seed=${hello.seed} ` +
        `capital=${hello.capital.lamports} lamports ` +
        `max_open_positions=${hello.caps.max_open_positions} ` +
        `max_orders_per_batch=${hello.caps.max_orders_per_batch} ` +
        `latency_slots=${hello.latency_slots}`,
    );
  },

  onBatch(batchState: BotState, batch) {
    batchesSeen++;
    if (batchesSeen % REPORT_EVERY === 0) {
      console.error(
        `[pullbacksnap] batch ${batch.seq} slot ${batch.slot}: ` +
          `${batchState.positions.size} open, ` +
          `${Number(batchState.cash) / 1e9} SOL cash, ` +
          `${batchState.pending.size} pending`,
      );
    }
    return strategy.onBatch(batchState, batch);
  },

  onDone(doneState: BotState, doneMsg: Done) {
    const cashSol = Number(doneState.cash) / 1e9;
    console.error(
      `[pullbacksnap] done (${doneMsg.reason}): ${batchesSeen} batches answered, ` +
        `final cash ${cashSol} SOL, ${doneState.positions.size} positions left`,
    );
  },
});

// runBot resolves only after done; reaching here means the replay ended cleanly.
void state;
void done;
