# Strategy: PullbackSnap

Paper-trading bot for the pump.fun replay sprint (agent-fun/replay/v2). One program,
`main.ts`, speaks the hello / batch / orders / slot protocol through the vendored shim;
all trading logic lives in `strategy.ts`, and `main.ts` only validates the parameters
and wires the strategy to the shim.

## Entry — buy the dip after a proven pump

A coin qualifies only when all of these hold on its tape:

1. **Seasoned**: created 100–6,000 slots ago, real SOL reserves between 2 and 60.
2. **Proven pump**: price ran at least 40% from its early base to a recent peak, and the
   peak is at most 1,500 slots old.
3. **Real dip**: current price is at least 25% below that peak but still 5% above base.
4. **Buyers returning**: in the last 40 slots, at least 5 buys from at least 3 distinct
   wallets, 0.1 SOL net inflow, the last trade a buy — and the price already bouncing at
   least 12% off the window low (never catch a knife still falling).

One fixed 0.12 SOL stake per position, no pyramiding, at most 4 open at once, total
exposure capped at 1.0 SOL. A coin can be entered at most twice, with a 900-slot
cooldown after an exit.

## Exits — mechanical, decided before entry

- Hard stop-loss at −8% of cost, take-profit at +50% of cost.
- Trailing exit parked above the target (+55% arm, −10% from peak): it only guards runs
  that blow past take-profit. The local backtest showed an earlier trail cut winners
  short of the target, so it does not arm below it.
- Dead-tape exit: no trade on a held coin for 600 slots.
- Maximum hold: 1,500 slots, so capital recycles into new coins.
- Portfolio drawdown guard: entries halt at −15% from the equity peak; the whole book
  flattens at −30%. The house guardrail is 50%.

## Breadth fallback

The ranking bar needs round trips on at least 20 distinct coins. If no round trip has
completed for 6,000 slots while fewer than 20 coins are done, entries loosen (15%
run-up, 6% pullback, 0.06 SOL stake, 300-slot holds) until trips resume.

## Determinism

No clock reads, no randomness, no network. Every decision is a pure function of the
batch stream; two runs on the same data produce byte-identical action logs (verified by
`tools/backtest.ts`, which runs the replay twice). Parameters are validated up front
(`validateParams` in `strategy.ts`, called from `main.ts` before the first batch), so a
bad override fails loudly instead of trading.

## Local backtest (kit dev dataset, all three parts)

| | |
|---|---|
| Net PnL | **+0.0477 SOL** |
| Fills | 184 |
| Distinct coins traded | 77 |
| Completed round trips | 92 |
| Win rate | 14.1% (13/92) |
| Max drawdown | 2.84% |
| Rejected / failed orders | 0 / 1 |

Tuning notes live in the comment above `DEFAULT_PARAMS` in `strategy.ts`. The final
window is different data, so the parameters sit in a flat, robust region rather than the
sample's single best cell.
