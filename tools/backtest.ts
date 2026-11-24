// Backtest: run this entry's bot on the kit's dev dataset with the local replay
// (tools/sim.ts) and print net PnL, fills, distinct coins, completed round
// trips, wins, max drawdown and rejects — then run it a second time to prove
// determinism (same net, same fills, same trips).
//
//   node tools/backtest.ts <kit dir> ['{"stakeSol":0.2}'] [--trips]
//
// The optional JSON argument overrides strategy parameters for a sweep; --trips
// lists every round trip with its hold length and PnL.

import { createBot, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, simulate } from './sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/backtest.ts <kit dir> [params json] [--trips]');
  process.exit(2);
}
const overrides =
  process.argv[3] !== undefined && process.argv[3].startsWith('{')
    ? (JSON.parse(process.argv[3]) as Partial<Params>)
    : {};
const dataset = loadDataset(kit);
const hello = makeHello('123456789');
const params = { ...DEFAULT_PARAMS, ...overrides };
const toSol = (lamports: bigint): string => (Number(lamports) / 1e9).toFixed(6);

/** Run the bot once over the whole dataset. */
const runOnce = () => simulate(dataset, hello, createBot(params));

const first = runOnce();
const wins = first.trips.filter((trip) => trip.pnl > 0n).length;
const qualifying = first.trips.filter((trip) => trip.pnl !== 0n).length;
const winRate = first.trips.length > 0 ? ((100 * wins) / first.trips.length).toFixed(1) : '0';
console.log(
  `net ${toSol(first.netPnl)} SOL  fills ${first.fills}  coins ${first.mints}  ` +
    `trips ${first.trips.length} (qualifying ${qualifying})  wins ${wins} (${winRate}%)  ` +
    `dd ${(100 * first.maxDrawdown).toFixed(2)}%  rejected ${first.rejected} ${JSON.stringify(first.rejectReasons)}  ` +
    `failed ${first.failed}`,
);

const second = runOnce();
const identical =
  first.netPnl === second.netPnl &&
  first.fills === second.fills &&
  first.trips.length === second.trips.length &&
  first.trips.every(
    (trip, i) => trip.mint === second.trips[i]!.mint && trip.pnl === second.trips[i]!.pnl,
  );
console.log(`determinism: second run identical = ${identical} (net ${toSol(second.netPnl)}, trips ${second.trips.length})`);
// A non-deterministic bot is a broken bot: fail the run loudly instead of
// printing numbers that cannot be reproduced.
if (!identical) process.exit(1);

if (process.argv.includes('--trips')) {
  for (const trip of first.trips) {
    console.log(trip.mint, `hold ${trip.close - trip.open} slots`, toSol(trip.pnl));
  }
}
