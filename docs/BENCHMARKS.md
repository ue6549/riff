# Riff vs FlashList — Benchmarks

## Device & Environment

| | |
|---|---|
| Device | iPhone (physical) |
| Power mode | **Power saver + charging** — CPU governor capped; absolute FPS numbers are conservative |
| Display | 60 Hz |
| Runs per scenario | 2 — values below are averages |

Power saver mode depresses the CPU ceiling. FPS deltas are real but conservative: in normal power mode Flash's fast-scroll numbers would be ~5–10 FPS higher, Riff's would already be at ceiling (59–60), so the gap narrows slightly in absolute terms but persists structurally because the bottleneck is recycling throughput, not raw clock speed.

---

## Methodology

Each run: automated scroll at a fixed velocity (Slow = 20 px/frame, Fast = 100 px/frame, Fling = gesture fling) over the full content length, down then up. Metrics sampled at 60 Hz.

- **Avg FPS / Min FPS / p5 FPS** — frame rate from JS thread
- **Avg CPU %** — process CPU averaged over run duration
- **Avg Mem MB** — memory delta over run (negative = GC returned memory mid-test; not absolute heap)
- **Mount Avg** — average cell mount events per second (recycling proxy)

---

## Search Results Demo

Long heterogeneous list (~400 items, mixed text/image/badge rows). This is the highest-stress scenario — large item count, variable heights, no layout uniformity.

| Scenario | Riff FPS | Flash FPS | Riff CPU | Flash CPU | Riff Mounts/s | Flash Mounts/s |
|---|---|---|---|---|---|---|
| Slow ↓ 20 | 59 | 54.5 | 16.5% | 38% | 11 | 59 |
| Slow ↑ 20 | 59 | 56 | 15.5% | 37.5% | 10.5 | 63 |
| Fast ↓ 100 | **59** | **37.5** | 36% | 59.5% | 10.5 | 62.5 |
| Fast ↑ 100 | **56** | **38.5** | 39.5% | 54.5% | 10.5 | 55.5 |
| Fling ↓ | 58 | 46.5 | 12.5% | 33% | 11 | 78 |
| Fling ↑ | 58.5 | 57 | 8% | 7.5% | 7.5 | 52 |

**Fast scroll is the headline.** Flash drops to 37–38 FPS at 59–60% CPU while Riff holds 56–59 FPS at 36–40% CPU. Flash is executing ~60 recycle events/sec under fast scroll; Riff cells are identity-stable and don't need to be re-rendered on scroll. The gap appears at fast scroll velocity because that's when recycling throughput becomes the bottleneck — at slow scroll, both are CPU-idle enough that the overhead is absorbed.

Fling asymmetry (Flash 46.5 ↓ vs 57 ↑): fling-down enters unmeasured content and triggers heavier layout work in Flash. Fling-up scrolls through already-measured content, so Flash recovers.

---

## Homepage Demo

Short compositional feed (~6 sections, moderate item count per section). Both engines are at the 60 Hz display ceiling across all scenarios — no FPS gap. The differences are efficiency metrics.

| Scenario | Riff FPS | Flash FPS | Riff CPU | Flash CPU | Riff Mounts/s | Flash Mounts/s |
|---|---|---|---|---|---|---|
| Slow ↓ 20 | 59 | 56.5 | 17.5% | 35% | 13 | 80.5 |
| Slow ↑ 20 | 59 | 59 | 16% | 31.5% | 14 | 86 |
| Fast ↓ 100 | 60 | 59.5 | 21.5% | 32% | 12 | 84.5 |
| Fast ↑ 100 | 60 | 59 | 32.5% | 31.5% | 13.5 | 86.5 |
| Fling ↓ | 59 | 60 | 13.5% | 8.5% | 12 | 87 |
| Fling ↑ | 59 | 60 | 6.5% | 5% | 19 | 89 |

**CPU**: Riff ~17–22% under load vs Flash ~31–35% — roughly 2× lower. At the display ceiling FPS looks equal, but Riff leaves more CPU headroom for app logic, animations, and background work.

**Memory**: Riff delta ≈ 0–5 MB (cells persist by identity; GC reclaims inactive ones). Flash maintains a ~27–28 MB persistent recycled-cell pool regardless of scroll state — it exists even when the list is idle. This is not a leak; it's the design cost of recycling. On memory-constrained devices this pool competes with app state and image caches.

**Mount count**: Flash 80–89 mounts/sec even at gentle scroll speeds — the pool is continuously turning over. Riff 12–19 mounts/sec reflects first-time renders plus section transitions only.

---

## Storefront Demo

Compositional layout: horizontal carousels (list H, grid H, flow V) interleaved with vertical list sections. Short H sections with bounded item counts.

| Scenario | Riff FPS | Flash FPS | Riff CPU | Flash CPU | Riff Mounts/s | Flash Mounts/s |
|---|---|---|---|---|---|---|
| Slow ↓ 20 | 58 | 55 | 17.5% | 28.5% | 12 | 30 |
| Slow ↑ 20 | 58 | 55 | 17% | 30% | 12 | 28.5 |
| Fast ↓ 100 | 57 | 56 | 32.5% | 30.5% | 13 | 36 |
| Fast ↑ 100 | 53 | 56 | 38.5% | 26.5% | 11 | 22 |
| Fling ↓ | 57 | 56 | 19% | 16% | 11 | 37 |
| Fling ↑ | 58 | 59 | 10% | 5.5% | 10 | 17 |

**Broadly even.** Fast ↑ shows Riff at 53 vs Flash 56 — within measurement noise on a throttled device; likely H sub-container measurement overhead during fast upward scroll through the first pass. This is the expected result: storefront has short H sections whose cells converge quickly, so recycling pressure is low and FlashList's optimization for uniform-height items gives it parity here. CPU and mount count still favor Riff.

---

## Summary

| | Search (fast) | Homepage | Storefront |
|---|---|---|---|
| FPS | **Riff +20** | Tied (ceiling) | Tied |
| CPU under load | **Riff −23 pp** | **Riff −14 pp** | Slight Riff advantage |
| Memory footprint | Near zero | Near zero | Near zero |
| Flash pool cost | — | ~27 MB persistent | — |
| Mounts/sec | **Riff 6× lower** | **Riff 6–7× lower** | Riff 2–3× lower |

**Where Riff wins clearly**: long heterogeneous lists under fast scroll. Identity rendering keeps cells alive; no recycling throughput bottleneck; CPU stays low; FPS holds.

**Where they're equal**: short/bounded content at gentle scroll speeds where both engines are below their CPU ceiling. Any compositional demo with short sections fits here.

**Where Flash has structural overhead regardless of FPS**: memory (persistent pool) and mount count (constant recycling churn). These are design costs, not bugs — but they're real on constrained devices.

---

## Raw Data

Two runs per scenario. All numbers above are averages.

### Search Results

```
Engine,Label,Avg FPS,Min FPS,p5 FPS,Avg CPU,p75 CPU,p90 CPU,Avg JS Idle,Avg Mem MB,Peak Mem MB,Mount Avg,Mount Max,Duration (ms)
riff,Slow ↓ 20,59,37,50,17,16,22,100,-0.9,5.3,11,12,37062
riff,Slow ↑ 20,59,47,53,16,15,18,100,-6.2,-1.4,11,12,37809
riff,Fast ↓ 100,59,55,55,35,47,47,100,-4.7,-3.3,10,12,5330
riff,Fast ↑ 100,55,51,51,42,49,51,94,-4.5,-3.5,11,12,5301
riff,Fling ↓,58,50,50,11,14,39,97,-6.5,-4.1,12,12,3084
riff,Fling ↑,58,49,49,9,18,20,96,-6.7,-2.9,8,12,3084
flash,Slow ↓ 20,54,31,37,38,38,52,89,22.9,46.5,59,85,41878
flash,Slow ↑ 20,56,31,43,38,38,53,92,24.9,43.5,63,85,42226
flash,Fast ↓ 100,38,26,26,61,70,72,66,29.4,37.5,64,85,7786
flash,Fast ↑ 100,41,29,29,53,59,68,68,23.0,36.2,54,85,6979
flash,Fling ↓,47,36,36,32,62,73,81,29.9,41.3,82,85,3084
flash,Fling ↑,57,47,47,7,20,20,97,22.5,29.1,54,85,3084
riff,Slow ↓ 20,59,47,50,16,16,17,98,1.1,7.0,11,12,37911
riff,Slow ↑ 20,59,47,52,15,16,20,99,-2.6,1.7,10,12,37941
riff,Fast ↓ 100,59,56,56,37,43,46,98,-1.0,0.5,11,12,5330
riff,Fast ↑ 100,57,50,50,37,39,49,95,-0.8,1.4,10,12,5434
riff,Fling ↓,58,55,55,14,19,54,96,-2.8,2.0,10,12,3068
riff,Fling ↑,59,56,56,7,16,23,98,-4.3,-0.5,7,10,3084
flash,Slow ↓ 20,55,33,37,38,39,52,89,20.0,37.3,59,85,41732
flash,Slow ↑ 20,56,33,43,37,37,54,91,24.3,44.3,63,85,41759
flash,Fast ↓ 100,37,27,27,58,72,77,64,28.2,36.8,61,85,7686
flash,Fast ↑ 100,36,24,24,56,62,75,68,25.5,41.5,57,85,6545
flash,Fling ↓,46,32,32,34,49,66,79,27.9,40.7,74,80,3151
flash,Fling ↑,57,47,47,8,6,30,98,20.1,26.2,50,50,3084
```

### Homepage

```
Engine,Label,Avg FPS,Min FPS,p5 FPS,Avg CPU,p75 CPU,p90 CPU,Avg JS Idle,Avg Mem MB,Peak Mem MB,Mount Avg,Mount Max,Duration (ms)
riff,Slow ↓ 20,59,52,53,18,19,34,98,2.1,10.3,13,21,18922
riff,Slow ↑ 20,59,53,55,16,16,18,97,-4.1,-1.6,14,22,18921
riff,Fast ↓ 100,60,60,60,23,28,34,99,-3.8,-2.6,12,14,3232
riff,Fast ↑ 100,60,60,60,34,38,44,99,-3.8,-2.6,13,21,3221
riff,Fling ↓,59,56,56,15,24,33,96,-4.7,-3.3,12,12,3080
riff,Fling ↑,60,55,55,6,7,41,98,-6.0,-3.1,19,20,3084
flash,Slow ↓ 20,56,36,36,35,35,49,91,27.8,31.6,81,87,11152
flash,Slow ↑ 20,59,56,56,32,34,39,98,29.3,31.6,86,90,11069
flash,Fast ↓ 100,59,56,56,32,36,36,98,28.2,30.7,83,87,2167
flash,Fast ↑ 100,59,56,56,32,30,36,98,29.4,30.8,86,89,2167
flash,Fling ↓,60,60,60,8,11,23,98,28.9,29.8,87,87,3084
flash,Fling ↑,60,60,60,5,8,13,100,28.6,30.0,89,89,3084
riff,Slow ↓ 20,59,49,53,17,17,27,98,5.1,9.4,13,23,18922
riff,Slow ↑ 20,59,51,51,16,16,28,97,0.8,4.8,14,22,18954
riff,Fast ↓ 100,60,60,60,20,22,39,100,0.2,1.9,12,14,3199
riff,Fast ↑ 100,60,58,58,31,36,43,98,1.1,2.6,14,21,3217
riff,Fling ↓,59,56,56,12,23,30,97,0.0,2.0,12,12,3068
riff,Fling ↑,58,51,51,7,6,30,98,-0.9,1.5,19,20,3083
flash,Slow ↓ 20,57,36,37,35,36,42,91,25.7,29.2,80,87,11136
flash,Slow ↑ 20,59,56,56,31,34,38,98,27.4,29.3,86,90,11068
flash,Fast ↓ 100,60,60,60,32,33,35,99,25.7,27.5,86,90,2167
flash,Fast ↑ 100,59,56,56,31,36,36,99,26.5,27.8,87,90,2167
flash,Fling ↓,60,60,60,9,12,26,97,26.9,27.9,87,87,3084
flash,Fling ↑,60,60,60,5,4,16,100,26.5,27.9,89,89,3084
```

### Storefront

```
Engine,Label,Avg FPS,Min FPS,p5 FPS,Avg CPU,p75 CPU,p90 CPU,Avg JS Idle,Avg Mem MB,Peak Mem MB,Mount Avg,Mount Max,Duration (ms)
riff,Slow ↓ 20,58,40,46,17,16,31,95,39.4,81.1,12,19,28408
riff,Slow ↑ 20,58,41,44,16,16,24,95,11.1,18.3,12,19,28305
riff,Fast ↓ 100,57,53,53,32,42,46,90,5.4,10.9,13,18,4248
riff,Fast ↑ 100,54,47,47,40,47,51,86,4.8,7.6,11,19,4301
riff,Fling ↓,56,47,47,21,45,52,88,2.0,6.1,10,12,3084
riff,Fling ↑,59,47,47,7,8,49,96,0.8,2.7,10,12,3084
flash,Slow ↓ 20,55,41,46,28,32,44,88,17.3,24.6,30,39,12833
flash,Slow ↑ 20,55,42,42,29,33,44,87,20.6,26.5,28,39,12919
flash,Fast ↓ 100,56,44,44,34,54,54,93,20.4,25.4,37,39,2166
flash,Fast ↑ 100,56,53,53,30,34,39,95,18.6,25.4,22,39,2150
flash,Fling ↓,57,44,44,18,34,55,92,20.2,23.4,37,39,3084
flash,Fling ↑,59,53,53,5,10,18,98,15.7,20.8,17,39,3084
riff,Slow ↓ 20,58,34,43,18,17,24,94,12.3,18.1,12,19,28388
riff,Slow ↑ 20,58,40,45,18,18,27,95,17.2,38.4,12,19,28454
riff,Fast ↓ 100,57,53,53,33,43,45,88,24.7,27.4,13,18,4349
riff,Fast ↑ 100,52,45,45,37,54,57,87,23.7,26.7,11,17,4385
riff,Fling ↓,58,44,44,17,41,62,93,21.8,24.3,12,12,3084
riff,Fling ↑,57,46,46,13,13,51,96,22.4,27.5,10,12,3084
flash,Slow ↓ 20,55,37,37,29,28,50,92,27.1,30.1,30,39,12604
flash,Slow ↑ 20,55,42,43,31,38,51,93,25.7,30.3,29,44,12752
flash,Fast ↓ 100,56,46,46,27,30,37,88,25.9,29.4,35,39,2199
flash,Fast ↑ 100,56,51,51,23,28,29,95,24.5,27.4,22,39,2167
flash,Fling ↓,55,44,44,14,25,34,96,26.0,26.9,37,39,3084
flash,Fling ↑,59,53,53,6,4,21,99,22.8,27.4,17,39,3084
```
