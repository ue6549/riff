# RNCollectionView — Architecture

Living document. Updated as milestones complete. Open questions stay open until
resolved by benchmarks or explicit design work.

---

## 1. The C++ Foundation — Always Present

Regardless of which layout engine is active, the following subsystems are **always C++**.
They form the permanent native foundation of the library.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        C++ Foundation (always present)                      │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Window Controller  (JSI, UI thread — never blocked by JS)          │   │
│  │  · reads scroll offset (SharedValue) every frame                    │   │
│  │  · classifies every item into a tier: visible/render/layout/data    │   │
│  │  · fires mount/unmount signals to React via JSI                     │   │
│  │  · velocity-aware: window expands leading edge on fast scroll       │   │
│  │  · all tuning values (multipliers, budgets) come from JS windowConfig│   │
│  └──────────────────────────────┬──────────────────────────────────────┘   │
│                                 │ getAttributesInRect(visibleRect)          │
│                                 ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  LayoutCache  (C++ JSI, thread-safe, mutex-guarded)                 │   │
│  │  · primary source of truth for all positional data                  │   │
│  │  · stores LayoutAttributes per item key (frame, sizingState, tier…) │   │
│  │  · spatial index (M1.4) — O(log n + k) getAttributesInRect          │   │
│  │  · versioned — monotonic counter increments on every write          │   │
│  │  · serialises to FlatBuffers (MMKV) for cold-start restoration      │   │
│  └──────────────────────────────▲──────────────────────────────────────┘   │
│                                 │ writes LayoutAttributes                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Layout Engine  (C++ JSI, background thread)                        │   │
│  │  · ListLayout: compute(), invalidateFrom()                          │   │
│  │  · GridLayout, MasonryLayout, CompositionalLayout  (future)        │   │
│  │  · sticky header position updated every scroll frame               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Diff Engine  (C++ JSI, background thread)                          │   │
│  │  · key-based O(n) Myers diff on data updates                        │   │
│  │  · produces { inserted, removed, moved, updated } patch             │   │
│  │  · drives partial LayoutCache invalidation (only affected items +   │   │
│  │    all downstream items reflow; upstream items untouched)           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  State Persistence  (Native + MMKV)                                 │   │
│  │  · scroll position: native store, restored pre-first-frame          │   │
│  │  · layout cache snapshot: FlatBuffers in MMKV                       │   │
│  │    keyed by (listId + dataHash + viewportWidth + layoutConfigHash)  │   │
│  │  · restored before first scroll event — window controller has       │   │
│  │    accurate positions from frame 0, no blank-area flash             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

**What sits in C++ and why:**

| Subsystem | Why C++ | Config origin |
|---|---|---|
| Window controller | Must react to scroll on UI thread — no JS round-trip | `windowConfig` prop via JSI `configure()` |
| LayoutCache | Shared between UI thread (window controller reads) and background thread (layout engine writes). Mutex-guarded. | Cache key policy from JS |
| Layout engine (built-in) | Background thread parallelism, no JS GIL equivalent | Layout spec objects from JS |
| Spatial index | O(log n) `getAttributesInRect` — the scroll-frame hot path | None needed |
| Diff engine | Key comparison on large datasets off main thread | None needed |
| Sticky header positioning | Must update every scroll frame synchronously | Layout spec |
| State persistence (scroll pos) | Must restore before Fabric first commit — async is too late | `listId` from JS |
| FlatBuffers serialization | Zero-copy reads on restore — no parse overhead | Schema versioned |

---

## 2. The Layout Computation Choice — C++ Built-in vs TS Plugin

Above the C++ foundation, **who writes into LayoutCache** is a choice.

```
┌─────────────────────────────────────────────────────────────────┐
│               Who writes LayoutAttributes into C++ LayoutCache  │
│                                                                  │
│   ┌──────────────────────────┐   ┌───────────────────────────┐  │
│   │  C++ Layout Engine       │   │  TS CustomLayoutPlugin    │  │
│   │  (built-in layouts)      │   │  (consumer layouts)       │  │
│   │                          │   │                           │  │
│   │  · ListLayout            │   │  · always TS              │  │
│   │  · GridLayout  (future)  │   │  · OTA-updatable          │  │
│   │  · MasonryLayout (future)│   │  · no native build step   │  │
│   │  · CompositionalLayout   │   │  · writes to C++ cache    │  │
│   │    (future)              │   │    via JSI setAttributes  │  │
│   │                          │   │                           │  │
│   │  Not OTA-updatable.      │   │  interface CustomLayout-  │  │
│   │  Fastest.                │   │  Plugin {                 │  │
│   │  Runs off JS thread.     │   │    compute(ctx, cache)    │  │
│   │                          │   │    invalidateFrom?(...)   │  │
│   └──────────┬───────────────┘   └─────────────┬─────────────┘  │
│              │                                 │                 │
│              └──────────────┬──────────────────┘                 │
│                             │ writes LayoutAttributes             │
│                             ▼                                    │
│              ┌──────────────────────────┐                        │
│              │  C++ LayoutCache  ←──────┼── always C++           │
│              └──────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────┘
```

**Why the TS path is permanent (not a fallback):**
- Custom layouts written by product teams are always TS — they need to be OTA-updatable.
- Web platform has no C++ JSI; TS is the only option there.
- `TSLayoutCache` (built for M1.3b benchmarking) is a standalone mirror — useful for benchmark isolation and web. On iOS/Android in production, TS plugins write into C++ LayoutCache via JSI.

**Decision pending:** Which path is default for built-in layouts on each platform.
iOS benchmark data collected (M1.3b). Android + other platforms pending.

---

## 3. Layout Passes — How Computation Works

### 3a. Full compute — O(n)

Triggered on first load or full section invalidation (data completely replaced).

```
Input params from JS:
  itemCount, viewportWidth, sectionInsets, itemSpacing
  itemHeight (fixed mode)  ─OR─  itemHeights[] (estimated mode)
                                                    │
                                                    ▼
  For each item i:
    y = sectionInsetTop + Σ heights[0..i-1] + (i × spacing)
    frame = { x: insetLeft, y, width: viewportWidth−insets, height: h[i] }
    sizingState = "measured"    ← fixed mode (final, no correction needed)
                 "placeholder"  ← estimated mode (corrected after first render)
                                                    │
                                                    ▼
                          Writes all attrs into LayoutCache  O(n)
```

### 3b. Partial invalidation — O(n − pivot)

Triggered after a cell reports its actual size (estimated → measured correction)
or after a data diff identifies changed items.

```
Before invalidateFrom("item-5000", params):

  item-0    y=16    ┐
  item-1    y=116   │  untouched — frames preserved exactly
  ...               │
  item-4999 y=X     ┘
  item-5000 y=X+h_old  ← pivot: height was updated in cache by caller
  item-5001 y=...      ← stale
  ...
  item-9999 y=...      ← stale


After invalidateFrom:

  item-0    y=16    ┐
  ...               │  unchanged (never read, never written)
  item-4999 y=X     ┘
  item-5000 y=X+h_new  ← reads stored height (h_new), rewrites frame
  item-5001 y=X+h_new+h_5001  ← Y delta propagated forward
  ...
  item-9999 y=...+Δh   ← all shifted by Δh = h_new − h_old

  Cost: O(n − pivot). Items before pivot: zero reads, zero writes.
```

### 3c. Estimated height correction (no scroll jump)

When a cell in estimated mode renders and reports its real size:

```
1. Cell calls useCellSize({ height: actualHeight })     [JS / React]
2. CollectionView JSI call: layoutCache.setAttributes({ ...attrs, height: actualHeight, sizingState: "measured" })
3. layout.invalidateFrom(key, params)                   [C++ background thread]
4. Window controller reads updated layout               [next scroll frame]
5. If position delta > correctionMinDelta:
     native scroll view contentOffset adjusted by Δh   [synchronous, pre-frame]
     → scroll position preserved, no visible jump
```

---

## 4. Windowing — Tier Classification

Every item is in exactly one tier at all times. The window controller reclassifies
items on every scroll frame, running on the UI thread via C++ JSI.

```
  ┌──────────────────────────────────────────────────────────────┐
  │                      scroll content                          │
  │                                                              │
  │  ┌────────────────────────────────────────────────────┐      │
  │  │  DATA window  (dataMultiplier × viewport)          │      │
  │  │  · no layout attrs computed yet                    │      │
  │  │  · onPrefetch(keys) callback fired to JS           │      │
  │  │                                                    │      │
  │  │  ┌────────────────────────────────────────────┐   │      │
  │  │  │  LAYOUT window  (layoutMultiplier × vp)    │   │      │
  │  │  │  · LayoutAttributes in C++ cache           │   │      │
  │  │  │  · no React component mounted              │   │      │
  │  │  │                                            │   │      │
  │  │  │  ┌────────────────────────────────────┐   │   │      │
  │  │  │  │  RENDER window  (renderMultiplier) │   │   │      │
  │  │  │  │  · React component mounted         │   │   │      │
  │  │  │  │  · Activity mode="hidden"          │   │   │      │
  │  │  │  │  · fiber alive, state preserved    │   │   │      │
  │  │  │  │  · paint skipped, GPU memory free  │   │   │      │
  │  │  │  │                                    │   │   │      │
  │  │  │  │  ┌──────────────────────────────┐  │   │   │      │
  │  │  │  │  │  VISIBLE  (viewport)         │  │   │   │      │
  │  │  │  │  │  · Activity mode="visible"   │  │   │   │      │
  │  │  │  │  │  · painted, interactive      │  │   │   │      │
  │  │  │  │  └──────────────────────────────┘  │   │   │      │
  │  │  │  └────────────────────────────────────┘   │   │      │
  │  │  └────────────────────────────────────────────┘   │      │
  │  └────────────────────────────────────────────────────┘      │
  │                                                              │
  │  OUTSIDE: nothing allocated anywhere                         │
  └──────────────────────────────────────────────────────────────┘
```

| Tier | Layout attrs | React component | Painted | RN 0.83+ mechanism |
|---|---|---|---|---|
| visible | ✓ in cache | mounted | ✓ | `Activity mode="visible"` |
| render | ✓ in cache | mounted | ✗ | `Activity mode="hidden"` |
| layout | ✓ in cache | unmounted | ✗ | — |
| data | ✗ | unmounted | ✗ | `onPrefetch` callback |
| outside | ✗ | unmounted | ✗ | — |

**Window is asymmetric — biased toward scroll direction:**
- Leading edge (direction of travel): renderMultiplier × viewport (default 3×)
- Trailing edge (behind scroll): trailingMultiplier × viewport (default 1×)
- On fast fling: leading window expands, trailing edge collapses aggressively
- All multipliers are runtime-configurable from JS `windowConfig` — no native rebuild

**On RN < 0.83 (new arch, no Activity):** render and visible tiers collapse — components
mount at absolute positions, ScrollView clipping handles visual hiding. Window controller
behaviour is identical; only the React layer differs.

---

## 5. Full Data Flow

```
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                           JS / React                                     │
  │                                                                          │
  │  CollectionView component                                                │
  │  · data={dataSource}                                                     │
  │  · layout={new ListLayout(...)}   ← or CustomLayoutPlugin                │
  │  · windowConfig={...}             ← all tuning, passed to C++ at runtime │
  │  · renderItem={...}                                                       │
  │                                                                          │
  │  On data change:                                                         │
  │    startTransition(() => setState(newData))                               │
  │         │                                                                 │
  │         ▼                                                                 │
  │    Diff Engine (C++, bg thread)                                          │
  │    { inserted, removed, moved, updated }                                 │
  │         │                                                                 │
  │         ▼                                                                 │
  │    Layout Engine (C++ or TS plugin)                                      │
  │    compute() or invalidateFrom()                                         │
  │         │ writes LayoutAttributes                                         │
  │         ▼                                                                 │
  │    LayoutCache (C++, thread-safe)  ◀── State Persistence restore         │
  │         │                              on cold start                      │
  │         │                                                                 │
  │  On every scroll frame (UI thread):                                      │
  │         │                                                                 │
  │         ▼                                                                 │
  │    Window Controller (C++, UI thread)                                    │
  │    scrollY → getAttributesInRect(visibleRect + window margins)           │
  │    → classify each item into tier                                        │
  │    → emit tier-change events:                                            │
  │         · item entering render tier → React mounts component            │
  │         · item leaving render tier → React unmounts component           │
  │         · item entering visible tier → Activity mode="visible"          │
  │         · item entering layout tier → layout pass if not cached         │
  │         · item entering data tier → onPrefetch(keys) callback           │
  │         │                                                                 │
  │         ▼                                                                 │
  │    CellContainer (React)                                                 │
  │    · render-tier:  <Activity mode="hidden">  (fiber alive, no paint)    │
  │    · visible-tier: <Activity mode="visible"> (flip — near-zero cost)    │
  │    · outside render window: unmounted entirely                          │
  │                                                                          │
  └──────────────────────────────────────────────────────────────────────────┘

  C++ TurboModule (CollectionViewModule)
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  · owns LayoutCache  (shared_ptr)                                        │
  │  · owns ListLayout   (shared_ptr)                                        │
  │  · owns WindowController (future — currently Reanimated worklet in POC) │
  │  · owns DiffEngine   (future)                                            │
  │  · all exposed as JSI objects — lazy-initialised on first JS access      │
  │  · configure(windowConfig) — all tuning values arrive from JS           │
  └──────────────────────────────────────────────────────────────────────────┘
```

---

## 6. State Persistence — Restore Sequence

```
App launch / navigation back to screen:

  1. [Native, pre-first-frame]
     Read scroll position from native persistence store.
     Set UIScrollView contentOffset synchronously before first Fabric commit.
     → User never sees Y=0 flash.

  2. [JS, before first render]
     Hydrate LayoutCache from MMKV FlatBuffers snapshot.
     Cache key = hash(listId + dataSourceId + viewportWidth + layoutConfigHash)
     → Window controller has accurate frames from frame 0.

  3. [JS, first render]
     Compute initial visible rect from restored scrollY.
     Items in visible + render window: enter their tiers immediately.
     Items with cached layout: skip compute, go straight to Render tier.
     Items without cached layout: Layout tier → compute → Render tier.

  4. [JS, async / background]
     Validate restored cache against current data snapshot via Diff Engine.
     If data changed: partial invalidation (changed items + downstream only).
     Re-fire onPrefetch for items in data window.
```

---

## 7. iOS Benchmark Results (M1.3b, 2026-03-22)

10 000 items, estimated heights (50–300px random), pivot at index 5 000.

| Operation | C++ | TS (TSLayoutCache) | Note |
|---|---|---|---|
| computeListLayout (estimated) | 7.89ms | 14.09ms | C++ ~1.8× faster |
| invalidateFrom (tail 5 000) | 3.87ms | 12.24ms | C++ ~3.2× faster |
| getAttributesInRect (390×844) | 2.54ms | 4.42ms | C++ ~1.7× faster |
| getAll (10 000 items) | 23.80ms | 1.09ms | TS ~22× faster — JSI marshal cost |

`getAll` through JSI costs 23ms for 10k objects. The scroll-frame hot path is
`getAttributesInRect` (~15–30 items returned) — fast on both paths.
**Neither path calls `getAll` on a scroll frame.**

Android + other platform benchmarks pending.

---

## 8. Open Decisions

| # | Question | Status |
|---|---|---|
| 1 | Default layout engine for built-in layouts: C++ or TS? | Open — iOS data collected, Android pending |
| 2 | Layout cache serialization: FlatBuffers (preferred) vs JSON (POC fallback) | Open |
| 3 | Spatial index algorithm for `getAttributesInRect` (M1.4) | Next up — sorted-Y interval structure in C++ |
| 4 | Diff engine: C++ Myers diff vs JS worker | Open |
| 5 | Animated mutations (insert/delete with spring/fade) | Open — separate design needed |
| 6 | Shared element transitions | Open |
| 7 | Infinite bidirectional scroll (chat-style) | Open |
| 8 | Web platform: WASM equivalents for C++ modules | Phase 3 |
