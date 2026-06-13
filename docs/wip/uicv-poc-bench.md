# UICollectionView POC Bench Results

**Branch:** `feat/uicollectionview-poc`
**Date:** TBD (device bench session)
**Device:** iPhone 15 Pro, Low Power Mode ON
**Scenario:** 1000-item heterogeneous feed (FeedComparisonTab), 5 rounds per mode

## Protocol

For each mode:
1. Cold-start the app, navigate to Comparison tab, select mode.
2. Reset PerfHood counters.
3. Scroll sequence (~30 s total): slow-scroll down → fast-scroll down → fling → bounce-back → fast-scroll up → fling up.
4. Record metrics from PerfHood.
5. Run 5 rounds, average.

## Decision rule (go/no-go)

Riff×UICV **accepted** if all of:
- FPS (avg/min/p5) within **5%** of Riff
- CPU (avg/p75/p90) within **10%** of Riff
- Memory (avg/p75/p90/peak) within **20%** of Riff
- Total Mounts comparable to Riff (recycling is working)

## Results

| Metric | Riff (cv) | Riff×UICV (cv-ucv) | FlashList (flash) | cv-ucv vs cv |
|---|---|---|---|---|
| FPS avg | — | — | — | — |
| FPS min | — | — | — | — |
| FPS p5 | — | — | — | — |
| JS Idle % | — | — | — | — |
| CPU avg | — | — | — | — |
| CPU p75 | — | — | — | — |
| CPU p90 | — | — | — | — |
| Mem avg (MB) | — | — | — | — |
| Mem p90 (MB) | — | — | — | — |
| Mem peak (MB) | — | — | — | — |
| Active Mounts avg | — | — | — | — |
| Total Mounts | — | — | — | — |
| Blank Area % | — | — | — | — |

## Decision

**TBD** — fill in after bench run.

[ ] Go: proceed to compositional spike
[ ] No-go: ship B1.14 only, drop Phase 2 commits from the PR

## Notes / observations

*(Fill in qualitative observations: visual parity, any flicker, state preservation on bounce-back, etc.)*
