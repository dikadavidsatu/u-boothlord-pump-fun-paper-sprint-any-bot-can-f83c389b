# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/dikadavidsatu/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/dikadavidsatu/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

PullbackSnap: a pump.fun paper-trading bot for the make.fun replay sprint (agent-fun/replay/v2). It waits for a fresh curve to prove a real pump — a 40% run-up from its early base — then buys the dip: a 25% pullback from the peak, with buyers stepping back in (5 recent buys from 3 distinct wallets, 0.1 SOL net inflow, and the price already bouncing 12% off its window low, so it never catches a knife still falling). One fixed 0.12 SOL stake per position, at most 4 open, with mechanical exits (8% stop-loss, 50% take-profit, a trailing exit that only arms above the target, dead-tape and max-hold exits) and a portfolio drawdown guard that halts entries at −15% and flattens the book at −30%. A breadth fallback loosens the entry filter when round trips stall, to keep the 20-coin round-trip bar in reach. Fully deterministic: every decision is a pure function of the batch stream, no clock, no randomness, no network. Local backtest on the kit's dev dataset: +0.048 SOL net PnL over 92 round trips across 77 coins, 14.1% win rate, 2.8% max drawdown. Paper trading only — no real funds.

## Run it

```sh
node main.ts
```

Backtest locally (needs the competition kit unpacked):

```sh
node tools/backtest.ts /path/to/kit
```

See STRATEGY.md for the full entry, exit and guard rules.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vyqgkf3p&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
