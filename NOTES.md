# Experiment log

Grader: `makefun grade-local --driver process --worktree` on the kit's 24h dev dataset (128,058 events,
~403k slots, 1,222 coins). Stress: `--stress 20 --stress-jobs 4`.

Fees are 95 + 30 = 125 bps **per side** (2.5% round trip) plus 105,000 lamports per transaction,
so a 0.0101 SOL probe costs about 0.00046 SOL before price drift.

## Offline event study (tools/study.mjs)
Simulates entering 2 slots after a signal and exiting on stop / trail / max hold, net of fees.
- Momentum (150-slot window, net inflow >= 2 SOL, >= 5 buyers, near window high), 0.1 SOL:
  246 trades, -1.48 SOL, win 25%; stops average about -16% because of the 2-slot latency.
- Stricter variants (net >= 5 SOL / >= 10 buyers, 600-slot window, older curves, tighter or wider
  stops, near-completion curves): every one negative in every quarter of the day.
- Probes at 0.01 SOL, one per coin: about -0.0005 SOL each with a 60-slot hold, which is essentially
  the fixed fee cost. A mild inflow screen (net >= 0.3 SOL, >= 2 buyers) was the cheapest.

## v1: probes + momentum sleeve on
probes: 23 target, 0.0101 SOL, rq 5..70 SOL, age >= 300 slots, 150-slot window, net >= 0.3 SOL,
>= 2 buyers, price >= window start and <= 1.25x window low, hold 60 slots, stop -25%, target +10%.
momentum: 600-slot window, net >= 5 SOL, >= 8 buyers, rq 10..60, within 10% of high, <= 1.3x low,
0.1 SOL max, 2 open, 0.25 SOL deployed max, stop -8%, trail 6% after +8%, hold 600 slots.
- dev: net -0.1938 SOL, max DD 2.08%, 88 fills, 40 coins (44 round trips), win rate 27%.
- Verdict: the momentum sleeve loses money, matching the event study.
