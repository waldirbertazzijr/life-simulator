# Gauntlet Loops for life-simulator

Ready-to-paste prompts (Matt Shumer's Gauntlet Loop pattern) for running long, autonomous
builder-vs-critic improvement loops on this project.

## The files

| File | Loop | Bar |
|---|---|---|
| `00-master-autonomous-game.md` | The all-in-one Claude-of-Duty-style run | Blind A/B vs real ecosystem games + harness score |
| `01-refactor-gauntlet.md` | Split the `Animal.js` monolith | Byte-identical seeded fingerprints |
| `02-test-gauntlet.md` | Build a test suite | Mutation testing — critic injects bugs, suite must catch them |
| `03-stability-gauntlet.md` | Honest, persistent ecosystem | `scoreRun` on held-out seeds + genetics diversity |
| `04-visual-gauntlet.md` | Make it beautiful | Blind screenshot A/B vs The Bibites / Equilinox |
| `05-performance-gauntlet.md` | 2× throughput | `bench.mjs` + identical fingerprints |

## How to run one

1. Open Claude Code at the repo root.
2. Set effort: `/effort` → **ultracode** (recommended for 00, 03, 04).
3. Paste the entire contents of one gauntlet file as your prompt.
4. Walk away. Watch the progress page it creates. Stop it when you're happy.

Recommended order for the focused loops: **02 → 01 → 03 → 04 → 05**
(tests make the refactor safe; a stable ecosystem makes the visual loop worth watching).
Or skip all of that and run **00** — the full autonomous-game run.

## House rules (baked into every prompt)

- **Critics pick the seeds.** Builders never see the judgment seeds. This project has already
  been reward-hacked once (`docs/HANDOFF.md` §3.4) — assume it will happen again.
- **Builders never grade their own work.** Fresh-context critic, real artifact, no builder summaries.
- **Receipts, not claims.** Fingerprints, screenshots, bench numbers, genetics printouts.
- **`Engine.step()` is sacred.** One step path for browser and headless, never forked.
- **Nobody edits `scoreRun` to make a score pass.**
- Node isn't on PATH: every shell needs `export PATH="/opt/homebrew/bin:$PATH"`.
