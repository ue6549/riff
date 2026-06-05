# Riff — Sneak Peek Session

**Audience:** internal engineers
**Format:** speaker notes + slide outline
**Duration:** 90 minutes (workshop-style)
**Emphasis:** Riff-heavy (~70%); foundations as scaffolding (~30%)

Every Riff claim in this deck is grounded against code, not the README. Where the README overstates, the talk corrects it inline.

---

## Session arc

Four beats, ~90 min total:

1. **What runs where** (~25 min). JS engines, JSI, Fabric, the four object graphs per view, the three threads and their permissions. Plants the vocabulary.
2. **Where Riff intercepts** (~15 min). The six platform hooks Riff uses, with file:line. Sets up the architectural choices.
3. **How Riff actually runs** (~30 min). Four concrete flows + the slot lifecycle deep dive — the architecturally-interesting payoff.
4. **What Riff gets in return + honest gaps** (~10 min). Two-Layer Identity, Yoga-authority, compositional layouts, known gaps.

### Time budget

| Block | Min | Topic |
|---|---|---|
| 0 | 3 | Open: "what makes a list library fast on RN New Arch?" |
| A | 7 | JS engine fundamentals |
| B | 8 | How native objects enter JS |
| C | 10 | RN's four-object-graph + threads |
| D | 5 | Fabric commit cycle + interception surface |
| R1 | 5 | Two-jobs problem & Riff thesis |
| R2 | 10 | The six interception points |
| R3 | 10 | Four flows live-read |
| R4 | 10 | Slot lifecycle deep dive |
| R5 | 5 | Two-Layer Identity |
| R6 | 5 | Yoga-authority rule |
| R7 | 5 | Compositional + roadmap honesty |
| Q&A | 7 | Buffer |

### Three "aha" moments engineers should leave with

1. **JSI didn't solve the GC isolation problem. It solved the call-cost problem.** Lifetime is still hand-managed. (Block B)
2. **Riff does not unmount when a slot leaves the render window.** It depends on slot manager + per-type pool overflow. Render window is a *paint* boundary, not a *mount* boundary. (Block R4)
3. **All cell sizes are estimates. Yoga is the only authority.** Enforced by API naming (`estimated*` prefix) and by the correction pipeline being unconditional. (Block R6)

---

## Block 0 — Opening (3 min)

**Slide 0.1 — Title:** *Riff: a sneak peek at how it works*

**Slide 0.2 — The question:** *A list scrolls at 120fps. Cells render in JS. What gets to run on the hot path?*

Don't answer yet. Plant the question. We come back to it at R1.

---

## Block A — JS engine fundamentals (7 min)

**A.1 — V8 / Hermes mental model**
- Source → parser → AST → bytecode → Ignition (interpreter) → TurboFan (JIT for hot paths)
- Hermes ships bytecode AOT; no parse cost at startup

**A.2 — Hidden classes & shapes**
- Monomorphic property access is fast; "shape changes" force deoptimisation and re-shaping
- Tie-in: this is *why* React re-renders that change object shapes are slow

**A.3 — Single GC heap, single thread**
- The JS heap is sealed. Nothing else touches it without going through it. Plants the framing for Block B.

---

## Block B — How native objects enter JS (8 min)

**B.1 — Embedding model**
- A C++ host *creates* the engine instance. The engine doesn't run by itself.
- The host installs "external" objects into JS scope — these are C++ pointers wrapped in a JS object shell.

**B.2 — The old bridge (RN before Fabric)**
- JSON serialise → enqueue → other thread deserialises → ack
- Every layout update was a packet. Fast scroll = packet flood = dropped frames.

**B.3 — JSI: the new model**
- A thin C++ header. `jsi::Value`, `jsi::Function`, `jsi::HostObject`.
- JS calls C++ as a *function call*, not a message. No serialise. No async. No queue.

> **Aha #1:** A native module method call is now ~zero cost. *Async wasn't a feature — it was a workaround for the bridge.*

**B.4 — TurboModules & Fabric**
- TurboModule = JSI-exposed C++ object with a generated TS spec for type safety.
- Fabric = JSI-based renderer; ShadowNodes are real C++ objects, not JSON.

---

## Block C — RN's four-object-graph + threads (10 min)

**C.1 — Four objects, one View**

```
                         React heap (JS)
                                │
                    <View/>     │  React Element (VDOM)
                                ▼
                ─────────────── JSI ───────────────
                                │
                                ▼
                        ShadowNode (C++)
                     owns Yoga node ◄──┐  Yoga layout tree
                                │      │
                                ▼      │
                          UIView (UI thread)
```

- **React Element** — short-lived, JS heap, GC'd by V8/Hermes
- **ShadowNode** — C++ heap, owned by Fabric, lifetime tied to React Element graph via Fabric reconciler
- **Yoga node** — C++ heap, *owned by* the ShadowNode — never moves independently
- **UIView** — UI-thread heap (ObjC), lifetime managed by Fabric's mounting layer

**C.2 — Two heaps, no shared GC**
- JS GC has no idea C++ objects exist. C++ has no idea about JS GC.
- Lifetime bridging is JSI's responsibility — `jsi::HostObject`, `weak_ptr` patterns.

> Reinforce Aha #1: JSI didn't solve the GC isolation problem. It solved the *call cost* problem. Lifetime is still hand-managed.

**C.3 — Three threads, their permissions**

| Thread | Can touch UIKit? | Can call JSI? |
|---|---|---|
| JS | No | Yes — synchronous C++ calls, zero cost |
| Fabric commit pipeline | No | No — pure C++ |
| UI thread (main) | Yes | No |

UIKit is only safe to touch from the UI thread, but layout math should not run there. Fabric solves it: compute everything in C++, then deliver a minimal set of mutations to the UI thread to apply.

---

## Block D — Fabric commit cycle + interception surface (5 min)

**D.1 — One Fabric commit, simplified**

```
JS state change → React reconciles → ShadowTree diff →
  ShadowNode::layout()   (Yoga measures; anyone can override)
  → state delivery → UI thread → updateState: → updateLayoutMetrics: → frame
```

**D.2 — Hooks the platform gives you**
- `ShadowNode::layout()` — override on the container node
- `State` (Fabric state struct) — your own data packet ShadowNode→UIView
- `updateLayoutMetrics:` — intercept Fabric setting a frame on a UIView
- `UIScrollViewDelegate` — standard iOS, fires on UI thread before JS
- `KVO contentOffset` — sidesteps the delegate entirely

Riff hooks at all five, plus adds JSI bindings on top. That's the surface.

---

## Block R1 — Two-jobs problem & Riff thesis (5 min)

**R1.1 — Two jobs at different speeds**
- *Rendering*: expensive, on JS thread, runs as fast as React can reconcile.
- *Positioning*: must hit 60–120 fps, frame-perfect, no JS gap.
- Old RN: both went over the async bridge → fast scroll = bridge floods → frame drops.

**R1.2 — Where does the scroll hot path live in Riff?**

Answer the slide-0.2 question:

> The scroll hot path lives in C++, inside Fabric's ShadowNode commit. JS only learns about scroll when the render-window boundary crosses. **If you scroll 1 px, nothing happens in JS or React.**

---

## Block R2 — The six interception points (10 min)

For each: 30s of *where, what, why*.

### R2.1 — ① `CollectionViewContainerShadowNode::layout()`

- `cpp/CollectionViewContainerShadowNode.h:64`, `.cpp:99–122`
- Fabric calls this once per commit. Riff calls `correctChildPositionsIfNeeded()` → `updateStateIfNeeded()`.
- **Hash short-circuit (validated):** `shouldSkipCorrection()` at `.cpp:51–97` — 4-field hash (cache version, child count, child tags, Yoga frames). All match → whole correction is a no-op.

### R2.2 — ② `applyPositionsFromState:` (tag→UIView map)

- `ios/RNCollectionViewContainerView.mm:535–661`
- Reads `state.childTags[]` and `state.positions[]`. Builds `NSMutableDictionary tagToView`. Sets `child.frame` *by tag*, not by subview index. See R5 for the bug this fixes.

### R2.3 — ③ `updateLayoutMetrics:` on `RNMeasuredCellView` *(honest framing)*

- `ios/RNMeasuredCellView.mm:154–181`
- **NOT** a "size vs. position arbitration." LayoutCache already injected the cell height into Yoga at measure-time. The override is a *guard*: if `_shadowNodePositioned=YES`, keep the LayoutCache-set origin instead of letting Fabric's about-to-fire setFrame overwrite it.

### R2.4 — ④ `scrollViewDidScroll:` *(honest framing)*

- `ios/RNCollectionViewContainerView.mm:346–385` (V), `ios/RNCollectionSubContainerView.mm:1023` (H)
- Both delegates throttle and fire a JS-side scroll event. Neither calls C++ `processScroll` directly via JSI from the delegate. JS receives the event and calls `nativeWindowController.processScroll` / `processHScroll` in response.
- The band-skip lives in *JS render-range computation*: if the returned render range and cache version are unchanged from the previous tick, JS early-returns with no React work.
- The V/H asymmetry is in *what C++ does* inside `processScroll`, not who calls it: for static layouts (`list`/`grid`/`masonry`/`flow`) it's an O(log n) render-range binary search with no position recomputation; for scroll-driven dynamic layouts (`radial`/`carousel3D`/`spiral`/`hex`, currently used only as H section types) it recomputes per-item frame/transform/alpha at the new scroll offset, because those layouts' geometry is a function of scroll position.

### R2.5 — ⑤ KVO on `contentOffset` for sticky views

- `ios/RNScrollCoordinatedView.mm:219–242`, `259–267`
- `addObserver:forKeyPath:@"contentOffset"`. Separate from the delegate chain (which the container already owns).
- **Single instance** per sticky — one view, transformed; not a duplicate floating copy.

### R2.6 — ⑥ JSI bindings: `NativeCollectionViewModule`

- `cpp/CollectionViewModule.cpp`: `processScroll` (line 541), `scrollTo*` family (1209–1306).
- LayoutCache + LayoutEngine registries keyed by `cacheId` (42–53, 60–97).
- Pattern to point out: `weak_ptr` in the registry (`.cpp:96`) — that's how the JSI side stays alive across Fabric view recycling without leaking.

---

## Block R3 — Four flows live-read (10 min, ~2.5 min each)

Pull up README §"Four concrete flows" on screen.

1. **Cold start** — `prepare()` seeds estimates → first commit paints at estimated positions → next commit corrects.
2. **Steady-state scroll** — UI-thread scroll → JSI cache write → throttled onScroll → JS checks `renderRange + cacheVersion`, band-skips if unchanged → otherwise React reconciles a window-sized slice.
3. **Height correction** — `correctChildPositionsIfNeeded` diffs Yoga vs cache → `applyMeasurements()` → cascade → state delivery → MVC absorbs offset delta if above-fold.
4. **Mutation** — `snapshot/apply` → evict stale heights → `startTransition(setData)` → `invalidateFrom(i)` recomputes tail only.

Anchor for each: *"where is the JS thread during this?"* — three of the four flows have JS sitting idle most of the time.

---

## Block R4 — Slot lifecycle deep dive (10 min) — the payoff

### R4.1 — Two knobs, one ceiling, one afterlife

*(corrected framing — README's "three concentric windows" is misleading)*

- **`renderMultiplier`** (consumer prop, default **0.5**) — how much beyond the visible viewport to *want* in the render range. With default, render range ≈ visible + 0.5× vp leading + 0.5× vp trailing = 2× vp wide.

- **`mountedWindowSize`** (consumer prop, default **2.0**) — a **hard cap** on the resulting render range, *not* a separate concentric ring. `applyBudget` (CollectionView.tsx:760–780) trims render range if it would exceed `mountedWindowSize × vpHeight`. At defaults the two align.
  - **Why have both knobs when defaults align?** Three reasons:
    1. *Different intent* — `renderMultiplier` expresses behaviour ("how much prefetch I want"); `mountedWindowSize` expresses safety ("absolute mount ceiling").
    2. *Memory-pressure response is asymmetric* — CollectionView.tsx:1445 applies `memoryMultiplier` to `mountedWindowSize` only. The system shrinks the cap silently under pressure without rewriting the consumer's stated prefetch intent.
    3. *Trim policy* — `applyBudget` (symmetric around visible midpoint, visible always preserved) belongs to the ceiling, not the prefetch knob.
  - Honest framing for the talk: "two knobs where most libraries have one — API complexity vs. clean separation of intent and safety; in practice the cap rarely fires."

- **`measureAhead`** (consumer prop, default **0 = OFF**) — adds a separate band ahead of the render range where slots mount with `Activity=hidden` so Yoga can measure them early. Disabled in the default config and in the perf bench.

- **`recyclePoolSize`** (consumer prop, default **auto**) — per-`getItemType` LIFO afterlife. Auto formula: `max(renderRangeSize, maxHWindow × 2, 8)`, recomputed every `sync()` — tracks viewport changes automatically; no consumer wiring for rotation. The `maxPoolSize = 4` in `SlotManager.ts:74` is the pre-first-sync placeholder.

#### H-section windowing in compositional layouts

A beat worth its own slide:
- **V is global** — one render range across the whole list
- **H is per-section** — each H section runs its own `processHScroll` with its own render range, cacheVersion, band-skip
- Multiplier precedence: `section.renderMultiplier ?? hRenderMultiplier ?? renderMultiplier ?? 0.5`
- H cells inside V range but outside their section's H range go to the pool via SlotManager's `excludeIndices` (CollectionView.tsx:3198)

Sources: `CollectionView.tsx` (props 1156–1158, MVC 1445, ranges 2258–2309, auto-pool 3188–3196), `SlotManager.ts`.

### R4.2 — Lifecycle, honest version *(load-bearing slide)*

```
            entry: appears in render-induced needed set
                        │
                        ▼
              Activity=visible (mounted)
                        │
       slot leaves needed set, but pool has room
                        │
                        ▼
              moved to per-type pool   (still in React tree, still mounted, Activity=hidden)
                        │
              pool already at cap on next eviction       OR
              pool > maxPoolSize after Phase 4 trim      (dynamic-cap reduction)
                        │
                        ▼
              REMOVED from activeSlots  (React finally drops the Fiber)
```

- "Activity=hidden in mounted cap but outside render range" is *only* a thing when `measureAhead > 0`. With the default `measureAhead=0`, nothing is pre-mounted ahead; only the pool retains slots backward.
- **Primary unmount** = Phase 2 (SlotManager.ts:207–211, "pool full → push fails → delete").
- **Defensive unmount** = Phase 4 (294–304, "maxPoolSize was reduced dynamically → trim excess"). Only fires when `recyclePoolSize` is changed or the auto-formula's window shrank.
- Within the pool, slot keeps its Fiber. React `key={slotKey}` (CollectionView.tsx:3399) is stable; same data returning → routed back to its slot via `dataKeyToSlot` (SlotManager.ts:71) → prop update, no remount.

### R4.3 — The "aha"

> **Aha #2:** Riff does NOT unmount when a slot leaves the render window. It depends on SlotManager + per-type pool overflow.

- That's why "active components: 14" can be much smaller than "total mounted." Render window = paint boundary, not mount boundary. The mount boundary is pool overflow.

**Compared to FlashList / RLV (be precise):**

| Behaviour | Riff | FlashList | RLV |
|---|---|---|---|
| Scrolled-off cell, same data returns soon | Same Fiber via `dataKeyToSlot` → state survives | Slot reassigned to new data → state lost unless `useRecyclingState` saves it | Same — state lost on slot reassignment |
| Cell beyond render window | `Activity=hidden` (no paint, no useEffect re-fire) — RN 0.83+ only | Still rendered into recycler; `drawDistance` controls how far. Cell stays mounted with new data | Same as FlashList |
| What happens "beyond range" | Pool fills, overflow truly unmounts (Fiber dropped) | Cell does **not** unmount — goes back to recycler pool awaiting reassignment | Same — cells reused, rarely destroyed |
| Hidden-but-measured tier | Yes (`measureAhead` + Activity=hidden) | None | None |

Different memory profile (Riff 2–3× lower in the bench). Different state semantics (Riff preserves React state for items returning within pool retention; FlashList/RLV lose state on slot reassignment).

### R4.4 — Activity API fallback *(honest)*

- `Activity` is only on RN 0.83+. CollectionView.tsx:51–56 has `const Activity = (React as any).Activity | undefined` with a `<>{children}</>` fallback at line 1016.
- On RN < 0.83 the fallback renders the cell normally. The cell's React component runs, `useEffect` fires, Yoga measures — full mount cost. UIScrollView clips it visually but compute is unsaved.
- The `top:-9999` references in CollectionView.tsx (lines 14, 506, 2742) are **stale comments** from an earlier design. There is no actual offscreen-parking styling in code. Don't repeat the README's "graceful degradation via top:-9999" claim; it isn't true.
- **There is no clean Activity substitute** — Activity is the only React primitive that suspends a subtree's rendering while keeping its Fiber alive. The honest message: "On RN 0.83+ Activity unlocks the pool's compute benefit. Pre-0.83 the pool is a memory-only optimisation; we may want to clamp `maxPoolSize=0` to avoid the auto-pool keeping many cells alive that all re-render on every parent reconcile." (Filed as backlog item B-pre83-pool.)

---

## Block R5 — Two-Layer Identity (5 min)

### R5.1 — The Fabric "last index" optimisation

- When Fabric reconciles a new child list, if a child's previous index is already ≥ the highest previous index seen so far, Fabric emits no MOVE command. Correct for relative order, wrong for absolute order when interleavings happen.
- Real production failure (logs, 2026-04): decoration separators added between section backgrounds → ShadowNode child order changes → native subview order doesn't → index-based positioning applies frames to the wrong views.

### R5.2 — The fix

- `CollectionViewState.childTags[]` carries Fabric tags parallel to `positions[]`.
- `applyPositionsFromState:` builds `tagToView` map, sets frame by tag.
- Files: `cpp/CollectionViewContainerShadowNode.cpp` (childTags assignment), `ios/RNCollectionViewContainerView.mm:571–626`.

> **Aha:** Fabric uses tags everywhere internally (events, accessibility). Riff adopts the same identity system for the geometry channel. Index-based was the bug.

---

## Block R6 — Yoga-authority rule (5 min)

### R6.1 — The rule

- Every consumer-provided size is an **estimate**. Yoga measures, ShadowNode diffs, corrections cascade.
- API naming: every size prop carries the `estimated` prefix — `estimatedItemHeight`, `estimatedHeightForItem`, `estimatedSizeForItem`, `estimatedCrossAxisHeight`.
- Enforcement: `CLAUDE.md:59–67`, `src/types/protocol.ts`.

### R6.2 — Why this matters

- One pipeline (estimate → measure → correct), not two (fixed vs. variable).
- Eliminates a class of "wrong upfront size" bugs (FlatList / `getItemLayout`).
- FlashList comparison: has `estimatedItemSize` but also requires uniform column widths via `numColumns`. Riff's `grid` / `masonry` / `flow` do not.

> **Aha #3:** all cell sizes are estimates. Yoga is the only authority. Enforced by API naming and by the correction pipeline being unconditional.

---

## Block R7 — Compositional + roadmap honesty (5 min)

### R7.1 — Compositional layouts

- One `<CollectionView>` can host hero / H-carousel / grid / masonry / flow in one scroll container, one cache, one window budget.
- `src/layouts/compositional.ts`; `cpp/layouts/CompositionalLayout.cpp` multiplexes per-section engines.
- Closest analogue: `UICollectionViewCompositionalLayout`. No existing RN library has this as a first-class primitive.

### R7.2 — Honest gaps *(this slide builds trust)*

- **`invalidateItem` is misleading.** README §9 frames it as targeted invalidation from `(section, index)`. Implementation (CollectionView.tsx:2148–2157) ignores both arguments — it's a global render-gen bump that re-renders all window cells. Yoga ends up re-measuring everything in the window. Works in practice; the API is more honestly named `invalidateWindow()`. (Filed as **B-invalidate-api-truth**.)
- **TS `customLayout` has a known correction bug.** README §12 admits this. `correctChildPositionsIfNeeded` reads Yoga sequential positions for custom-layout cells instead of layout-provided positions → stacking. Planned milestone.
- **Static invalidation has ~33ms detection lag.** README §13. Double-RAF poll. Direct native callback is on the roadmap.

### R7.3 — What's portable

- LayoutCache + Layout Engine protocol: pure C++, zero deps → Android port is mostly mapping, web port is "rewrite layout in TS."
- Platform-specific surface: the six hooks. Everything else transfers.

---

## Code-on-screen moments (~6 min total budget)

Three short ones. Point at the *shape*, not the details.

1. **`cpp/CollectionViewContainerShadowNode.cpp:99–122`** — show how few lines the `layout()` override is. The whole hot path fits on one screen.
2. **`ios/RNCollectionViewContainerView.mm:571–626`** — the tag→UIView map. Show the loop, point at `tagToView[@(childTags[i])]`.
3. **`src/components/SlotManager.ts:200–304`** — the Phase 2 / Phase 4 split. Highlight line 300 (the unmount point).

---

## Live-question cheat sheet

| Question | File:line |
|---|---|
| Where is the ShadowNode override? | `cpp/CollectionViewContainerShadowNode.cpp:99` |
| Where does unmount actually happen? | `src/components/SlotManager.ts:207–211` (primary), `294–304` (defensive) |
| Where's the band-skip? | C++: `cpp/CollectionViewContainerShadowNode.cpp:51–97`. JS: `CollectionView.tsx` (renderGen + cacheVersion equality) |
| Where's the tag-map fix? | `ios/RNCollectionViewContainerView.mm:571–626` |
| Where's the JSI surface? | `cpp/CollectionViewModule.cpp:541, 1209–1306` + registries 42–97 |
| Where's the slot pool? | `src/components/SlotManager.ts:70–303` |
| Where's MVC? | `cpp/LayoutCache.h:256–313` + `ios/RNCollectionViewContainerView.mm:331` |
| Auto-pool-size formula? | `src/components/CollectionView.tsx:3188–3196` |
| `applyBudget` trim policy? | `src/components/CollectionView.tsx:760–780` |
| Per-section H windowing? | `src/components/CollectionView.tsx:484–492` (props), `2549–2558` (handler), `3251` (precedence) |

---

## Q&A backup: Riff vs FlashList — total-mount inversion

**Why the search-page total-mount inversion (Riff 1,135 vs FlashList 3,050):**
Search has long V depth + many V-window crossings + intermittent H sections. FlashList: each H section is a nested `<FlashList horizontal>` instance — when V scroll moves it out, the whole H FlashList tears down; on bounce-back, fresh remount → all H cards cold-mount fresh inside it. High mount churn per V crossing. Riff: H sections are sub-containers in the ShadowNode tree; they don't tear down per V crossing.

**Why the homepage/storefront total-mount flip (FlashList lower):**
Within each H FlashList instance, RLV's per-section recycler keeps cards stable through H scroll. Very few per-card mounts. Riff's outer per-type pool absorbs H cards too, but the pool's `maxPoolSize` eventually overflows when V scroll passes multiple sections with active H scroll, causing extra per-card mounts.

**Architectural trade-off:** Riff's uniform-pool model produces flat CPU/memory across page types (2× lower CPU than FlashList everywhere) but higher total mount counts on H-heavy pages; FlashList's per-section-recycler model is great when sections stay mounted, expensive when they get torn down. Numbers favour Riff on every metric except total-mounts-on-uniform-H-pages.

---

## Deviations from the README (be honest in the talk)

Validated as wrong/overstated. Session reflects code reality, not README.

1. **`scrollViewDidScroll:` does not call C++ `processScroll` synchronously.** Writes scroll offset to LayoutCache + throttled JS event. Band-skip is in JS render-range logic.
2. **`invalidateItem(section, index)` ignores both arguments.** Global render-gen bump → all window cells re-render.
3. **`updateLayoutMetrics:` is an origin guard, not a "Yoga vs. cache" arbitration.**
4. **Slot unmount is not at the render-window edge.** Activity=hidden → pool → only true unmount on per-type pool overflow.
5. **"Three concentric windows" framing is misleading.** `mountedWindowSize` is a ceiling on the render range itself, not a ring.
6. **Pool default does auto-track window size** (README correct); the `maxPoolSize=4` in SlotManager is a pre-first-sync placeholder.
7. **"Graceful degradation via top:-9999"** is not in code; only `<>{children}</>` fragment fallback exists.

---

## Verification — before the session

1. Walk through every file:line reference; confirm lines still match. Update before printing slides.
2. For each code-on-screen moment, dry-run in the IDE you'll demo from. Make sure relevant lines fit on screen at presentation font size.
3. Read aloud the honest-framing slides (R2.4, R2.3, R4.2, R4.4, R7.2) and time them. They're the parts engineers will press on.
4. Practice R4.2 (slot lifecycle ASCII) — if clunky on screen, redraw as a proper diagram.
5. Check audience's RN version; if pre-0.83, expand R4.4 to a full slide and call out the B-pre83-pool implication.

Pass criteria: a colleague who didn't help build Riff can read this deck and run the session unaided.
