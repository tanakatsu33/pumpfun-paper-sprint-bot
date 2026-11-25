# pump.fun Paper Sprint Bot

![bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)
![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/tanakatsu33/pumpfun-paper-sprint-bot/rank.svg)
![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/tanakatsu33/pumpfun-paper-sprint-bot/reward.svg)

A defensive, probes-only paper-trading bot: it opens one small (0.0101 SOL) probe per coin on a mild
inflow screen and closes it within a short hold, stop, or target, with the momentum sleeve disabled
after testing showed it lost money. On the dev dataset it meets the guardrails (23 coins with a round trip of at
least 0.01 SOL, max drawdown 0.19%) while keeping the loss to roughly the fixed fee cost of the probes.

Bounty: https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

See [NOTES.md](NOTES.md) for the experiment log and grades.
