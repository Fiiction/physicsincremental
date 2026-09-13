# September 14 progression balance

The ordinary-block and basic-income multipliers preserve the requested **1 / 2.5 / 5 / 10 / 20** relative to the preceding configuration. Boss health preserves **2 / 3 / 4 / 10 / 20**. Existing saves are not reset; new maps use these values.

| Chapter | Base block HP | Base income | Boss HP | Additional outer-ring exponent | Percentage-damage basis scale |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 1.5 | 8,000 | 1 | 1 |
| 2 | 150 | 30 | 1,725,000 | 1 | 1 |
| 3 | 125,000 | 720 | 960,000,000 | 1.22 | 0.06 |
| 4 | 56,000,000 | 17,280 | 240,000,000,000 | 1.06 | 0.08 |
| 5 | 9,000,000,000 | 414,720 | 3,450,000,000,000 | 1.3 | 0.4 |

Increasing income alongside HP alone accelerates research, while percentage attacks largely bypass the higher HP. The additional outer-ring reinforcement and reduced percentage-damage basis let a new region resist the previous region's area-clearing build. The innermost ring retains its existing base-health rule. The fifth chapter keeps its previous stronger outer-ring exponent. These are existing mechanics and configuration fields, not new damage rules.

Chapter 3's boss takes **3× direct collision damage**, up from 1×, so its higher nominal health does not recreate the previous boss wall. The other direct-hit multipliers remain 1 / 1 / 8 / 48. Breaking ordinary blocks still only removes 1% of a boss's current health and cannot kill it. Boss percentage-damage basis remains 0.5% of maximum HP, although area attacks cannot directly damage bosses.

Research unlocked in chapters 2 / 3 / 4 / 5 now has **2 / 4 / 6 / 8× starting prices**. Per-rank price growth and basic-attribute prices are unchanged. This distributes the increased chapter income across multiple purchases. Maximum ranks increase as follows; added rank descriptions use the real damage, participant or projectile formulas:

| Maximum | Technologies |
| ---: | --- |
| 60 | power (was 48) |
| 12 | combo (8), splitShock (8), splitTether (8), returnFormation (8), starPrism (8), elitePower (8) |
| 8 | fracture (6), starSalvo (6), comboBurst (6), beamArc (6), riftCollapse (6), starRift (6), finaleSalvo (6) |
| 6 | reactor (4) |

## Paired campaign verification

`progression-pace-baseline-data.json` preserves the full pre-change data. Both configurations were run through the **same Game implementation**, including the shortened attack tail. The test saves the source/configuration hashes. This prevents time saved by the separate effect-tail fix from being credited to the balance change.

```sh
node scripts/progression-pace-check.mjs baseline 12
node scripts/progression-pace-check.mjs current 12
```

The pilot starts a fresh save, earns all money, uses full-power geometric aim and shops after every run: power 1, kinetic 1 and idle 1 first, then the cheapest eligible research. Relic selections rotate across seeds. The fallback is two preceding-region farming runs after a zero-kill frontier run; **none were required**. Boss victories must include actual ball contact. These are progression simulations, not human timing or rendered-frame performance measurements.

| Metric, median | Previous data | New data | Ratio |
| --- | ---: | ---: | ---: |
| Campaign runs | 31 | 39 | 1.26× |
| Combat minutes | 16.86 | 25.80 | 1.53× |
| Estimated play minutes | 28.54 | 41.02 | 1.44× |

Estimated play adds the same **1.5 seconds of aiming per launch and 12 seconds shopping per run** to both versions. The median of the twelve *paired* combat-time ratios is **1.44×**; 1.53× is the ratio of the two campaign medians. Both sets completed **12/12**. New campaigns took 34–40 runs. These results support approximately 1.5× playtime, not 1.5× as many runs or a guarantee for every play style.

| Chapter | Runs, median | First-run clear percentage | Runs from first boss encounter to victory, median | Runs with a purchase | Upgrade ranks per run, median |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 14 | 2.56% | 3 | 96.99% | 4 |
| 2 | 3 | 23.01% | 2 | 100% | 24 |
| 3 | 3 | 40.00% | 2 | 100% | 16 |
| 4 | 5 | 32.65% | 4 | 100% | 7 |
| 5 | 12 | 34.71% | 4 | 99.32% | 2 |

Chapter 3's first-run clear percentage falls from 56.47% to 40%, and chapter 4 falls from 84.41% to 32.65%. Chapter 3's median boss challenge falls from three runs to two. The first boss is never defeated on its first encounter in these twelve campaigns. The final boss can still fall on its first encounter for a well-developed build (4/12), with most of that chapter's extra progression occurring before reliably reaching the boss. No sample goes more than one run without a purchase.

Research choices, aiming skill, frequent shopping during a run, idle income penalties and farming preferences can change pacing. Final chapter progression is intentionally slower. Higher newly added ranks remain as post-campaign growth; this test does not assert that every maximum is bought before the first campaign ends. Player-visible feel and menu/rendering performance are checked separately by the main task.
