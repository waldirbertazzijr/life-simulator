I want you to turn this repository into a fully autonomous game — a living world that
plays itself. Trees, herbivores, and carnivores evolving, hunting, herding, and dying
under a day/night cycle, mesmerizing enough that a stranger would leave it running in a
browser tab like an aquarium. The quality bar is The Bibites and Equilinox — real
ecosystem games people pay for and watch for hours. Our sim should survive a blind
side-by-side against them.

Read docs/HANDOFF.md and docs/ECOSYSTEM_BALANCE.md first — they are accurate and
hard-won. Then break the goal into the smallest parts that can be improved and judged
independently. Fan out builder subagents only where the work is genuinely independent;
keep tightly coupled systems under one coherent owner. Give every important part a
separate, harsh critic with fresh context. Critics inspect the real artifact — pixels,
harness output, genetics printouts — never a builder's summary.

The bars, which no builder may negotiate with:

- ALIVE: all three species persist 60,000 frames on seeds the builder has never seen.
  Judge with scoreRun in headless/harness.mjs. Critics choose the seeds, every round.
- HONEST: evolved genetics stay diverse. A single mutation sweeping the population or a
  gene pinned at an extreme means the ecosystem is reward-hacking a model bug — it
  happened before (HANDOFF §3.4, "eternal hibernation"). The critic reads the genetics
  printout from headless/run.mjs every round and fails the round on a sweep.
- BEAUTIFUL: headless Chromium screenshots (HANDOFF §5 has the exact command) at several
  window sizes and times of day, blind-A/B'd against real screenshots of The Bibites and
  Equilinox with labels stripped. If ours loses, the critic names the single biggest
  visual gap and only that goes back to the builder.
- SMOOTH: playable at 1,000+ entities. headless/bench.mjs before/after for step
  throughput, plus the on-screen FPS meter in a real browser screenshot.

Hard rules:

- Engine.step() stays the single source of truth for browser and headless. Never fork it.
- Builders may not edit scoreRun or the harness to make a score pass. Only a critic may
  propose a scoring change, with a written argument, and it applies from the next round.
- Behavior-preserving changes (refactors, perf) must prove byte-identical fingerprints:
  node headless/run.mjs --frames 6000 --seed N on critic-chosen seeds, before vs after.
- Model or dynamics changes invalidate the tuned config. Order is always: fix the model →
  verify → re-search with headless/search.mjs. Never search first (HANDOFF §6).
- Local only. No deploys, no spending, no credentials, no telemetry. A new dependency
  needs a one-line justification on the progress page.
- Every shell: export PATH="/opt/homebrew/bin:$PATH".

Maintain a simple live progress page — one self-contained HTML file I can open from my
phone — showing rounds, screenshots, scores, failed approaches, and the next target.
Update it as you work. After each major wave, spawn one fresh integration critic to
inspect the whole game and smooth the seams: consistent art, consistent feel, one thing
rather than separately-improved parts.

Keep looping — /loop on every piece; there is no fixed final round. Do not stop at
"pretty good for AI": a critic passes a piece only when, shown the two blind, it is
genuinely torn or utterly wowed by ours. Stop when that starts happening, when a round
produces no measurable gain twice in a row, or when I stop you. Fan out subagents and
ultracode.
