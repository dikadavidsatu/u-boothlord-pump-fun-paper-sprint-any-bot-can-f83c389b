// Backtest: run this entry's bot on the kit's dev dataset with the local replay
// (tools/sim.ts) and print net PnL, fills, distinct coins, completed round trips, wins,
// max drawdown and rejects — then run it a second time to prove determinism.
//
//   node tools/backtest.ts <kit dir> ['{"stakeSol":0.2}'] [--trips]

import { createBot, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, simulate } from './sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/backtest.ts <kit dir> [params json] [--trips]');
  process.exit(2);
}
const overrides = process.argv[3] !== undefined && process.argv[3].startsWith('{') ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};
const ds = loadDataset(kit);
const hello = makeHello('123456789');
const params = { ...DEFAULT_PARAMS, ...overrides };
const sol = (x: bigint) => (Number(x) / 1e9).toFixed(6);

const run = () => simulate(ds, hello, createBot(params));
const r = run();
const wins = r.trips.filter((t) => t.pnl > 0n).length;
const qualifying = r.trips.filter((t) => t.pnl !== 0n).length;
console.log(`net ${sol(r.netPnl)} SOL  fills ${r.fills}  coins ${r.mints}  trips ${r.trips.length} (qualifying ${qualifying})  wins ${wins} (${r.trips.length > 0 ? ((100 * wins) / r.trips.length).toFixed(1) : '0'}%)  dd ${(100 * r.maxDrawdown).toFixed(2)}%  rejected ${r.rejected} ${JSON.stringify(r.rejectReasons)}  failed ${r.failed}`);
const r2 = run();
const same =
  r.netPnl === r2.netPnl &&
  r.fills === r2.fills &&
  r.trips.length === r2.trips.length &&
  r.trips.every((t, i) => t.mint === r2.trips[i]!.mint && t.pnl === r2.trips[i]!.pnl);
console.log(`determinism: second run identical = ${same} (net ${sol(r2.netPnl)}, trips ${r2.trips.length})`);
if (process.argv.includes('--trips')) {
  for (const t of r.trips) console.log(t.mint, `hold ${t.close - t.open} slots`, sol(t.pnl));
}
