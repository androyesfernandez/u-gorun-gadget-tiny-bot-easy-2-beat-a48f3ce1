# Tiny Dip-Buy Bot

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/c/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/androyesfernandez/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/rank.svg)](https://make.fun/c/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/androyesfernandez/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/reward.svg)](https://make.fun/c/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A dip-buying paper-trading bot for hourly Solana prices. It waits for a symbol to fall at least 150 bps off its 24-bar trailing high, confirms the drop is fresh (down at least 25 bps over the last 3 bars) and already turning up (close above the previous bar), then buys 20% of equity. It exits on the first of four rules: the close reclaiming within 25 bps of the entry-time high, a trailing stop that arms once the trade is 300 bps in profit and fires on a 150 bps pullback from the peak, a 24-bar time stop, or a 500 bps hard stop below the entry close. A re-entry must dip at least as deep as the symbol's previous entry. All decisions use integer math on bar closes only, so the bot is fully deterministic.

## Grade locally

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process --json
```

## Competition

[Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/c/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
