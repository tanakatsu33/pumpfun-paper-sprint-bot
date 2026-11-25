// pumpfun-paper-sprint-bot: run by the grader as `node main.ts` (Node 22, no build step).
// The strategy lives in strategy.ts; vendor/agentfun-bot.ts is the protocol shim.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
