# Hodline engine

The game engine behind **[Hodline](https://hodline.xyz)**, a browser tower-defense game on Robinhood Chain mainnet, and the replay that checks every score.

[Play](https://hodline.xyz) · [X @hodlinexyz](https://x.com/hodlinexyz)

## Why this repo is public

Hodline pays out token prizes for leaderboard scores, so the scores have to be trustworthy. A browser can send any number it likes, so the server never takes a score at face value.

Instead, the game records the player's **inputs**: each tower placed, upgraded, sold or retargeted, and each wave called, along with the tick it happened on. The server then runs those inputs through this same engine and keeps the result the engine produces. If a record asks for a move the game would not allow, such as building on the path or spending gold the player does not have, the replay rejects it.

This repo is that engine. It is the exact code the site plays and the server replays. Anyone can use it to check how a score was reached.

## What makes it deterministic

- **One seeded random stream.** Everything that can change the outcome draws from a seeded SplitMix64 generator in `src/game/rng.ts`. Cosmetic effects (sparks, puffs) stay off that stream, so drawing one more spark never shifts a gameplay roll.
- **Fixed ticks.** The simulation steps at 60 ticks per second regardless of frame rate. Playing at 1x or 5x gives the same result.
- **Portable math.** The simulation only uses operations IEEE-754 rounds exactly (`+ - * /`, `sqrt`) and its own helpers in place of `Math.pow` or `Math.hypot`, which can differ between engines. The same run comes out the same on a phone and on the server.
- **One implementation.** The server does not have its own copy of the rules. It bundles `src/game/replay.ts` from this code, so the two cannot drift apart.

## Verify a run yourself

```bash
npm install
npm run verify
```

This replays `examples/endless-wave-51.json`, a real wave-51 Endless run (166 inputs, about 28 minutes of play), in under a second:

```
wave     51
kills    1940
rejected 0
score    52940
OK: every action replayed cleanly
```

To check any other record:

```bash
node verify.mjs path/to/record.json
```

## Layout

| File | What it is |
|---|---|
| `src/game/engine.ts` | The simulation: towers, enemies, waves, combos, gold, lives, and the input recorder |
| `src/game/config.ts` | Tower and enemy stats, wave plans, tuning |
| `src/game/map.ts`, `levels.ts` | Map generation and the campaign levels |
| `src/game/rng.ts` | The seeded random stream and deterministic math helpers |
| `src/game/replay.ts` | Rebuilds a run from its record and reports wave, kills and rejected inputs |
| `src/game/art.ts`, `sfx.ts`, `progress.ts` | Drawing, sound and local progress. These are browser-only and never affect the outcome. |
| `verify.mjs` | Command-line wrapper around the replay |

## License

Published for transparency and review. Copyright © 2026 Hodline. All rights reserved. The rest of Hodline (site, server, payouts) is not open source.
