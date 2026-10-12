Run a gauntlet loop to give this project the test suite it has never had. The judge is
mutation testing: a suite only counts if it catches real bugs, so a separate critic will
break the code on purpose and your tests must notice.

BUILDER: write a test suite using node's built-in test runner (node:test — keep the
project dependency-free). Cover at least: tree logistic growth and carrying-capacity
gates; the multiplicative energy trade-offs in Animal.walk() (the sign of net metabolism
must never flip — docs/HANDOFF.md §3.4 explains why this once broke the whole ecosystem);
the shared-neighbor invalidation guard in live(); determinism (same seed → identical
final counts via the headless harness); quadtree/grid query equivalence; and the shape of
scoreRun (collapse scores below survival, declining runs score below stable ones).

CRITIC (fresh context, never sees the builder's reasoning): each round, inject 10 small
mutants into copies of the source — one at a time, run the suite against each. Mutants
must include the project's historical bugs reintroduced: trees.procreatingChance = 0
(HANDOFF §3.1), energy modifiers made additive again (§3.4), the nearby-invalidation
guard removed (§4), carrying-capacity gate disabled — plus mutants of the critic's own
invention (flipped comparisons, off-by-ones, dropped early-returns). The critic reports
which mutants survived.

The bar, per round: suite green on unmodified code, at least 9 of 10 mutants killed, full
run under 60 seconds. A surviving mutant goes back to the builder as the ONLY target:
write the test that kills it, then a new round begins with fresh mutants. Loop until a
round opens with 10/10 kills on the critic's first attempt.

Boundaries: tests must not mutate config.js on disk or depend on wall-clock time; use the
seeded RNG from headless/rng.mjs for anything stochastic; no snapshot tests of rendering.
Mutant copies live in a scratch dir and never touch the real source. Keep a progress file
listing every mutant tried, killed or survived, and the test that killed it. Every shell
needs: export PATH="/opt/homebrew/bin:$PATH".
