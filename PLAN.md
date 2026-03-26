# RNCollectionView — Implementation Plan (Performance-First)

Platform: iOS first, then Android. RN New Architecture (Fabric + JSI). RN 0.83.4 (React 19.2).
Graceful degradation: RN 0.76+ (new arch, Activity absent).

**Ordering principle:** Performance, speed, memory, stability, metrics, and traces FIRST.
Features second. Research last. Documentation closes it out.

---

## ✅ Completed Milestones

### Phase 0 — Project Foundation (DONE)
- **M0.1** Package scaffold — buildable package, example app
- **M0.2** Core TypeScript types — Rect, Size, Point, LayoutAttributes, etc.
- **M0.3** C++ JSI module boilerplate — `ping()→"pong"` synchronous JSI call

### Phase 1 — Layout Engine (DONE)
- **M1.1** LayoutCache (C++) — CRUD, version, getAll, getTotalContentSize, getSectionOffsets
- **M1.2** ListLayout: fixed height — 10k items × 72px in < 1ms
- **M1.3** ListLayout: estimated + invalidation — variable heights, invalidateFrom pivot
- **M1.3b** TS layout parity — TSLayoutCache, TSListLayout, CustomLayoutPlugin
- **M1.4** SpatialIndex — getAttributesInRect, bucket-based, < 0.05ms for 10k items
- **M1.5** ListLayout: multi-section — 10 sections × 1k items, headers, footers

### Phase 2 — Scroll + Rendering (DONE)
- **M2.1** CollectionView shell + pluggable ScrollView
- **M2.2** Native scroll bridge — UIScrollViewDelegate → C++ window controller on UI thread
- **M2.3** Render all cells (absolute positioning, no virtualization)
- **M2.4** Window controller — visible/render tiers, velocity-adaptive, mountedWindowSize budget

### Phase 3 — Virtualization (DONE)
- **M3.1** Activity-based cell suspension (CellWrapper with Activity=hidden/visible)
- **M3.3** Cold eviction — unmount outside render window, remount at correct position
- **M3.4** Velocity-adaptive window — render range expands toward direction of travel
- **M3.5** Cell budget (mountedWindowSize) — mounted content capped in viewport multiples

### Phase 4 — Sizing Strategies (DONE)
- **M4.1** Estimated sizing — variable-height mode, RAF-batched scroll corrections, measure range
- **M4.2** RNMeasuredCell Fabric component — native `layoutSubviews` fires `onMeasured` before paint
- **M4.3** Self-sizing cells — tap to expand/collapse, dynamic resize, automatic scroll correction

### JS Optimizations Applied (within M4.1/M4.2)
1. Activity mode fix — render-range=visible, only measure-range=hidden
2. Microtask flush for off-screen cells
3. Running average height fallback for unmeasured items
4. Measure range in scroll handler (same frame as render range)
5. Skip startTransition for measure range on fast scroll
6. Phantom correction fix — measure-only cells removed from RAF batch
7. `initialNumToRender` — first screenful on first frame
8. `useLayoutEffect` for layout pass — committed before paint
9. Eager initial range in `onContainerLayout` — 3-render init chain → 2

---

## 🔥 Phase P1 — C++ Window Controller on UI Thread

> **Priority: HIGHEST.** The single hottest path. Every scroll event flows through here.

### P1.1 — Window controller → C++ JSI module

Port window boundary computation from JS to native C++. Not optional.

**Why:** JS window controller runs in Hermes on the main thread. Even with synchronous JSI,
the JS-side computation pays interpreter overhead (~2–5ms). C++ is sub-microsecond.

**Deliverable:** `cpp/WindowController.h/.cpp`
- Registered as synchronous JSI module
- Scroll position fed from UIScrollView delegate callback (C++ → C++, no JS)
- Window boundary computation in C++ (arithmetic + clamp)
- Notifies React via batched async dispatch when tier assignments change
- React processes tier changes via startTransition (non-urgent)

**Acceptance:**
- Window boundary update: < 0.5ms from UIScrollView delegate to boundary update
- Instruments Time Profiler: zero JS frames in scroll hot path
- All M2.4 + M3.x test cases pass unchanged
- Blank area at 2000px/s fling: same or better than JS baseline

**Deps:** M2.4 (behavioral reference), M0.3 (C++ JSI infrastructure)

---

## 🔥 Phase P2 — YGMeasureFunc: Native Cell Measurement

> **Priority: HIGH.** Eliminates the JS roundtrip for cell measurement entirely.

### P2.1 — Custom YGMeasureFunc for cell height

Same mechanism as `ParagraphShadowNode` for text measurement. Heights known during
Yoga's layout pass, not after.

**Why:** Currently `RNMeasuredCell` fires `onMeasured` from `layoutSubviews` → JS → layout
update → re-render. With YGMeasureFunc, Yoga calls our C++ callback during its own pass.
The height is known before the first commit — no correction, no re-render, no flicker.

**Deliverable:**
- Custom `ShadowNode` for cell container that registers a `YGMeasureFunc`
- Callback reads child intrinsic size during Yoga pass
- Height flows into LayoutCache synchronously (C++ → C++)
- Eliminates `onMeasured` JS event for initial measurement
- `onMeasured` kept as fallback for dynamic resizes (self-sizing cells)

**Acceptance:**
- Variable-height cells: correct height on first paint (no correction pass)
- Instruments: no JS frames during initial cell measurement
- M4.1 test: zero scroll corrections for initial layout (all heights known pre-commit)
- Fallback: self-sizing cells (M4.3) still work via `onMeasured` event

**Deps:** P1.1, M4.2

---

## 🔥 Phase P3 — Offscreen Pre-rendering via Fabric

> **Priority: HIGH.** Pre-build shadow trees for upcoming cells before they scroll into view.

### P3.1 — Fabric commit pre-rendering

Pre-create shadow trees for cells in the measure/prefetch window using Fabric's
commit pipeline, so they are ready to display instantly when scrolled into view.

**Why:** Currently, cells mount cold when entering the render window — React creates
the component, Fabric builds the shadow tree, Yoga layouts, then native views appear.
Pre-rendering moves this work ahead of time so the cell is "warm" on first display.

**Deliverable:**
- Measure-range cells built as Fabric shadow trees ahead of time
- When cell enters render window, shadow tree already exists — skip creation
- Integration with Activity mode: pre-rendered cells use `mode="hidden"` until visible
- Budget cap: max N pre-rendered cells (configurable, default 20)

**Acceptance:**
- Fast fling (2000px/s): blank area < 2% (down from current ~5%)
- Cold mount rate: < 5% during sustained scroll
- Memory: pre-rendered cells within budget, LRU eviction for excess
- No visible jank from pre-rendering work (deferred via startTransition or idle callback)

**Deps:** P2.1, M3.1

---

## Phase P4 — Memory Optimization

### P4.1 — Mounted cell budget refinement _(deferred — do after P5.1 so metrics can quantify impact)_

Optimize memory footprint of mounted cells. Tighter LRU eviction, smarter budget
allocation based on device memory pressure.

**Deliverable:**
- Memory-pressure-aware budget: reduce mounted cells on low-memory devices
- `os_proc_available_memory()` integration (iOS) for dynamic budget adjustment
- Eviction priority: furthest-from-viewport cells evicted first
- Metric: peak mounted cell count, memory delta per 1000 items scrolled

**Acceptance:**
- 10k item list: peak mounted cells < 2× budget at all times
- Memory pressure event: budget reduced within 1 frame, excess cells evicted
- No OOM on iPhone 12 with 10k complex cells (images + text)

**Deps:** M3.5

---

## Phase P5 — Instrumentation & Metrics

### P5.1 — Metric collection infrastructure

Core metric pipeline baked into the component.

**Deliverable:** `src/metrics/MetricCollector.ts`
- Frame time: CADisplayLink callback (native) → circular buffer (C++) → JS read
- Blank area: computed from visibleRect vs cells in visible tier each frame
- Cell render time: timestamp at mount → timestamp at visible flip
- Cold mount rate, scroll correction count, pre-render hit rate
- All metrics collected always (low overhead), ring buffer storage

**Acceptance:**
- Frame time accurate to ±0.5ms (CADisplayLink hardware timer)
- Blank area ratio updates every frame during scroll
- Overhead: < 0.5ms/frame on iPhone 12

**Deps:** M3.3, M2.2

---

### P5.2 — Debug Perf HUD

Live metrics overlay in the sample app.

**Deliverable:** `src/debug/CollectionViewHUD.tsx`
- Toggle via shake gesture or programmatic API
- Displays: FPS, blank area %, mounted cells, cold mount rate, corrections, memory
- Color overlay mode: tints cells by tier (visible/render/measure)
- Works in release builds

**Acceptance:**
- HUD appears within 100ms of toggle
- Metrics update at 10Hz (not 60Hz)
- HUD is a separate React root (doesn't affect CV perf)

**Deps:** P5.1

---

### P5.3 — Traces in sample app

Instrument the example app with structured traces for release-build profiling.

**Deliverable:**
- `os_signpost` integration for scroll handler, layout pass, cell mount/unmount
- Instruments trace template for CollectionView analysis
- Sample app screens annotated with trace regions
- Export capability: trace summary as JSON for comparison

**Acceptance:**
- Instruments shows named signpost regions for all critical paths
- Trace data available in release builds (signpost, not NSLog)
- Example app produces reproducible trace sessions

**Deps:** P5.1

---

## Phase P6 — FlashList Comparison (Release Build)

### P6.1 — FlashList comparison demo

Demonstrate correctness and performance wins over FlashList.

**Deliverable:** `example/screens/Comparison.tsx` (extend existing)
- **Tab 1: State bleed** — Like button with useState. FlashList recycles = state on wrong items.
  CollectionView = identity-preserving, always correct.
- **Tab 2: Animation identity** — Cell mid-animation. FlashList recycles = animation resets.
  CollectionView = animation survives scroll out and back.
- **Tab 3: Performance** — Side-by-side metrics: FPS, blank area, mount count, memory
- Metrics overlay per tab

**Acceptance:**
- State bleed artifact reproducible on device with FlashList in < 5 seconds
- CollectionView zero state bleed across 1000 scroll events
- Release build metrics captured and comparable

**Deps:** M3.3, M4.3, P5.1

---

### P6.2 — Device measurement session

Objective performance characterization on real hardware.

**Deliverable:** Documented benchmark results
- Instruments Time Profiler: JS thread occupancy during fast scroll (CV vs FlashList)
- Blank area ratio at 1000/2000/4000 px/s fling
- Memory: heap delta after scrolling 10k items
- Frame drop count per 1000 frames (CADisplayLink)
- Devices: iPhone 15 Pro (A17) + iPhone 12 (A14) minimum

**Acceptance:**
- All measurements recorded and committed
- Release build comparison documented
- Clear win/loss/parity assessment per metric

**Deps:** P5.1, P5.3, P6.1

---

## Phase F1 — Data Layer (Features)

### F1.1 — Diff engine (C++)

Key-based diff, runs off main thread.

**Deliverable:** `cpp/DiffEngine.h/.cpp`
```
diff(oldKeys, newKeys) → { inserted, removed, moved }
```
- Identity diff: same key = same item
- O(n) for pure insertions/deletions; O(n log n) for moves

**Acceptance:**
- 1k item diff (50 inserts, 20 deletes, 5 moves): < 2ms incl. JSI string marshalling
  (JSI utf8() costs ~0.65µs/string; pure C++ diff algorithm is sub-ms at any realistic size)
- Correctness: diff(A, B) applied to A produces B exactly

**Deps:** M0.3

---

### F1.2 — Snapshot API

Consumer-facing mutation API modelled after `NSDiffableDataSourceSnapshot`.
All mutation methods are **identity-based** (keys, not indices) — matching Apple's
design that eliminated the index-ordering bugs of the old `performBatchUpdates` era.

**Deliverable:** `example/components/CollectionSnapshot.ts` + CollectionView `handle` prop
```typescript
// Identity-based mutations (UICollectionView-style)
const snap = listRef.current.snapshot()
snap.appendItems(items)
snap.deleteItems(keys)                           // array of keys
snap.moveItem(key, { after: anchorKey })         // single move per call (sequential)
snap.reloadItems(keys)
listRef.current.apply(snap)                      // diff + LayoutAnimation + startTransition
// — or for simple refresh (FlashList-style): just change data prop, no snapshot needed
```

Move is intentionally singular (not array) — each move changes relative positions
for subsequent moves, so ordering is sequential. Same design as Apple's snapshot API.

**Acceptance:**
- Append 100 items: only new items computed in layout
- Delete item at index 50 of 1000: items 51–999 recomputed, 0–49 unchanged
- Apply during active scroll: no interruption (startTransition)
- Move/shift animations via LayoutAnimation on apply()

**Deps:** F1.1, M3.3

---

### F1.2b — Enter/exit cell animations _(follow-up)_

Per-item mount/unmount animations for snapshot transitions.

**Deliverable:**
- Deleted cells: keep mounted briefly, animate opacity→0 + collapse, then unmount
- Inserted cells: mount at opacity 0, animate to 1 + expand
- "Pending removal" queue in the cell renderer

**Acceptance:**
- Delete visually fades out before unmounting
- Insert visually fades in after mounting
- Interruptible: new snapshot applied mid-animation cancels gracefully

**Deps:** F1.2

---

### F1.2c — UICollectionView-parity animations _(follow-up)_

Full coordinated batch animations matching UICollectionView's native behavior.

**Deliverable:**
- Per-item animation types (fade, slide, custom)
- Interruptible spring physics
- Coordinated batch: inserts, deletes, and moves animate simultaneously
- Animation completion callbacks

**Acceptance:**
- Visual parity with `UICollectionViewDiffableDataSource.apply(snapshot, animatingDifferences: true)`
- Animations interruptible mid-flight by new snapshot apply
- Custom animation configuration per operation type

**Deps:** F1.2b

---

### F1.3 — Prefetch callbacks

Notify consumer as items enter/leave the data window.

**Deliverable:**
```typescript
dataSource.onPrefetch = (keys) => { /* fetch */ }
dataSource.onEvict = (keys) => { /* cancel, release */ }
```

**Acceptance:**
- `onPrefetch` fires ~12× viewport ahead
- `onEvict` fires after cell leaves render window + budget

**Deps:** M3.4, M2.4

---

## Phase F2 — Supplementary Views & Sticky Headers

### F2.1 — Non-sticky supplementary views

Section headers and footers, same tiering as cells.

**Deliverable:**
- `SupplementaryRegistry`: register(kind, Component)
- Layout cache includes supplementary LayoutAttributes (from M1.5)
- Rendered at layout positions, enters/leaves Activity tiers
- Budget: default 20

**Acceptance:**
- 10-section list: headers at correct Y positions
- Headers participate in windowing

**Deps:** M3.3, M1.5

---

### F2.2 — Sticky headers (basic)

Headers stick at top while their section is visible.

**Deliverable:**
- C++ sticky position calculation on UI thread:
  `stickyY(section, scrollY) = max(header.y, scrollY)`
- Separate native view positioned in viewport space
- C++ updates Y every scroll frame

**Acceptance:**
- Section header sticks at top during scroll
- Returns to natural position when scrolling back
- Zero JS involvement during scroll

**Deps:** F2.1, M2.2

---

### F2.3 — Sticky push behavior

Incoming header pushes current sticky header upward (UICollectionView correctness).

**Deliverable:**
```cpp
float stickyY(int section, float scrollY) {
  float naturalY = headers[section].frame.y;
  float nextHeaderY = headers[section + 1].frame.y;
  float clampedY = nextHeaderY - headerHeight[section];
  return max(naturalY, min(scrollY, clampedY));
}
```

**Acceptance:**
- Section 1 header pushed up exactly as section 2 header arrives at top
- Multiple sections in rapid succession: all push correctly

**Deps:** F2.2

---

### F2.4 — Decoration views

Data-free views: section backgrounds, separators.

**Deliverable:**
- Layout engine emits decoration LayoutAttributes (kind + frame, no data)
- `layout.registerDecoration(kind, NativeComponent)` — native, not React
- Not in Activity budget (simple static views, no fiber)

**Acceptance:**
- Section background matches section's total frame
- Decorations not in React DevTools (native views)

**Deps:** F2.1

---

## Phase F3 — Additional Layout Types

### F3.1 — GridLayout (C++)

Fixed-column equal-width grid.

**Deliverable:** `cpp/layouts/GridLayout.h/.cpp`
```
columns, columnSpacing, rowSpacing, estimatedItemHeight, sectionInsets
```
Item width = (viewportWidth - insets - spacing) / columns.

**Acceptance:**
- 3-column grid, 100 items: < 1ms, correct frames
- Integrates with selfSizing (row height = tallest item)

**Deps:** M1.5

---

### F3.2 — MasonryLayout (C++)

Variable-height column-packing.

**Deliverable:** `cpp/layouts/MasonryLayout.h/.cpp`
- Place each item in shortest column
- `invalidateFrom`: recompute masonry from that item onward

**Acceptance:**
- 2-column, 50 items (100–400px heights): no gaps, no overlaps
- `totalContentSize.height` = max column height

**Deps:** M4.2

---

### F3.3 — CompositionalLayout

Sections with independent layout objects.

**Deliverable:** `src/layouts/CompositionalLayout.ts`
```typescript
new CompositionalLayout({
  sections: (sectionIndex, environment) => SectionLayoutDescriptor
})
```

**Acceptance:**
- 3 sections: list + grid + masonry — correct frames, sections stacked

**Deps:** F3.1, F3.2

---

### F3.4 — Orthogonal scrolling sections

Horizontal sections within vertical list.

**Deliverable:**
- `OrthogonalSection.tsx`: horizontal CollectionView with own window controller
- Parent treats it as single item of fixed/selfSized height
- Saves/restores own scroll position

**Acceptance:**
- App Store–style layout works
- Orthogonal section outside parent render window: all cells unmounted

**Deps:** F3.3, M3.3

---

## Phase F4 — State Persistence & Restoration

### F4.1 — Layout cache serialization (JSON scaffold)

Serialize LayoutCache to disk. Correctness focus.

**Deliverable:** `cpp/LayoutCacheSerializer.h/.cpp`
- JSON format (temporary — F4.4 replaces with FlatBuffers)
- MMKV via JSI storage
- Cache key: SHA1(listId + dataHash + viewportWidth + layoutConfig)

**Acceptance:**
- 10k items: round-trip byte-identical
- Cache key invalidates on viewport width change

**Deps:** M1.1

---

### F4.2 — Scroll position persistence (native iOS)

Restore scroll position before first Fabric commit.

**Deliverable:**
- On dealloc/viewWillDisappear: write contentOffset to NSUserDefaults
- On viewWillAppear: `setContentOffset:animated:NO` synchronously

**Acceptance:**
- Navigate away + back: exact previous position, zero flash at y=0
- Viewport size changed: stored position cleared

**Deps:** M2.1

---

### F4.3 — Full restoration sequence

Wire F4.1 + F4.2 with data validation.

**Deliverable:** `src/hooks/useStateRestoration.ts`
1. Read scroll offset from native storage → set UIScrollView contentOffset
2. Hydrate LayoutCache from MMKV
3. Compute initial visibleRect from restored scrollY
4. Enter cells into tiers
5. Validate cache: diff current vs cached keys
6. If data changed: invalidateFrom, re-layout

**Acceptance:**
- Full nav cycle (unchanged data): position exact, no layout recomputation
- Full cycle (data changed): position corrected for insertion delta
- Process death + relaunch: restored from MMKV + NSUserDefaults

**Deps:** F4.1, F4.2, F1.2

---

### F4.4 — FlatBuffers layout cache serialization

Replace JSON with FlatBuffers. Zero-copy mmap hydration.

**Why:** JSON parse of 10k LayoutAttributes ≈ 30–50ms. FlatBuffers mmap is zero-copy.

**Deliverable:**
- `fbs/LayoutCache.fbs` — FlatBuffers schema
- MMKV stores raw FlatBuffers bytes
- On restore: mmap MMKV value directly, wrap with FlatBuffers accessor
- Retire JSON serializer

**Acceptance:**
- Serialize 10k items: < 3ms
- Deserialize (mmap, no parse): < 0.1ms
- Layout cache available on frame 0

**Deps:** F4.1

---

## Phase F5 — Cross-Platform

### F5.1 — Android port

Port C++ modules and React component to Android (new architecture).

**Deliverable:**
- `android/` with CMakeLists wired to existing `cpp/` (no C++ duplication)
- `CollectionViewModule.kt` — TurboModule registration
- Scroll observer equivalent for Android
- All M1–M3 test screens pass on Android emulator

**Acceptance:**
- M1.1–M1.5 layout tests: green on Android
- M2.2 scroll bridge: scrollY tracking confirmed
- M3.3 cold eviction: cells unmount/remount as on iOS
- No iOS-only code in `cpp/`

**Deps:** M3.5. **Platform: Android new architecture (RN 0.76+).**

---

## Phase R1 — Research

### R1.1 — UICollectionView host architecture (design + prototype)

Decouple JS component identity from native UIView allocation using UICollectionView
as the physical scroll and layout host.

**Architecture:**
- Native: UICollectionView owns scroll + pool of ~20 UICollectionViewCell shells
- JS/React: one component per item, stable identity, full local state
- Bridge: React component's UIView reparented into whichever cell slot displays it
- Activity mode="hidden": React component stays mounted, UIView held in holding container

**Open questions:**
1. Fabric shadow tree ownership when moving UIView out of shadow-tree parent
2. Scroll ownership: UICollectionView vs RN ScrollView gesture conflict
3. Concurrent React interaction: Fabric may reposition "borrowed" views

**Deliverable:** Design document + working prototype (not production-ready)

**Deps:** P6.2

---

### R1.2 — Virtual-to-physical ShadowNode mapping

Custom Fabric ComponentDescriptor: N virtual ShadowNodes → M physical UIViews (M << N).
React sees N unique components. UIKit sees M reused views.

**Status:** Research. Implement only if R1.1 proves insufficient.

**Deliverable:** Feasibility report + proof-of-concept if feasible

**Deps:** R1.1

---

## Phase DOC — Documentation

### DOC.1 — Solution document (HLD, LLD, optimizations)

Comprehensive technical document covering the entire implementation.

**Deliverable:** Solution document with:
- **High-Level Design (HLD):** Architecture overview, component relationships, data flow,
  platform strategy (iOS-first, Android port), technology choices and rationale
- **Low-Level Design (LLD):** C++ module internals (LayoutCache, ListLayout, SpatialIndex,
  WindowController), Fabric component (RNMeasuredCell), JS component (CollectionView.tsx),
  memory management, threading model
- **All optimizations:** Numbered list of every optimization applied, why it was needed,
  what it fixed, before/after impact (from JS optimizations #1–9 through P1–P3)
- **Design decisions log:** Key architectural decisions with alternatives considered,
  trade-offs, and reasoning (no-recycling, C++ vs TS layout, Activity API usage,
  dual-RN-instance workaround, YGMeasureFunc, etc.)
- **Problem-solving log:** All significant bugs/issues encountered, root cause analysis,
  and solutions (codegen pipeline, RCTThirdPartyComponentsProvider, Folly coroutine headers,
  slow init, phantom corrections, etc.)
- **Performance comparison:** FlashList vs CollectionView benchmark results and analysis

**Acceptance:**
- Complete, accurate, reviewable by someone unfamiliar with the project
- All design decisions and optimizations documented with rationale
- Can serve as onboarding material for new contributors

**Deps:** All prior milestones complete (or near-complete)

---

## Execution Order

```
COMPLETED:  M0.1–M0.3 → M1.1–M1.5 → M2.1–M2.4 → M3.1–M3.5 → M4.1–M4.3
                                                                    ↓
PERFORMANCE:  P1.1 (C++ window ctrl) → P2.1 (YGMeasureFunc, blocked) → P3.1 (pre-render)
              + React.memo (MemoizedCellContent) — unplanned, 1fps→40-50fps win
                                                                    ↓
METRICS:      P5.1 (collection) → P5.2 (HUD) → P5.3 (traces)
              [needed to quantify everything that follows]
                                                                    ↓
FEATURES:     F1.1 (diff engine) ✅ → F1.2 (snapshot API) ✅ → F1.3 (prefetch) ✅
              F2.1 (supplementary) ✅ → F2.2 (sticky) ✅ → F2.3 (sticky push) ✅ → F2.4 (decorations) ✅
              F3.1 (grid) → F3.2 (masonry) → F3.3 (compositional) → F3.4 (orthogonal)
              F4.1–F4.4 (persistence)
              F5.1 (Android)
                                                                    ↓
MEMORY:       P4.1 (budget refinement) ← after features+metrics so impact is measurable
                                                                    ↓
COMPARISON:   P6.1 (full demo: state/animation/form/media/layout/sticky/snapshot/perf)
              → P6.2 (device benchmarks on release build)
              [all features complete — the money shot]
                                                                    ↓
RESEARCH:     R1.1 (UICollectionView host) → R1.2 (virtual ShadowNode)
                                                                    ↓
DOCS:         DOC.1 (solution document)
```

---

## POC Checkpoints

| After | What you can show |
|---|---|
| M4.3 ✅ | Variable height, self-sizing, scroll correction — all working |
| P1.1 ✅ | C++ window controller — JS scroll path largely native |
| P3.1 ✅ | Pre-rendering at real position — single Activity flip on viewport arrival |
| memo ✅ | React.memo on cell content — JS FPS 1→40-50fps on simulator |
| P5.2 | Perf HUD — live FPS, blank area, cold mount rate, memory overlay |
| F1.2 | Snapshot API — insert/delete/move with per-item animation, O(delta) reconciliation |
| F2.3 | Sticky headers, UICollectionView-style — one instance repositioned, no duplication |
| F3.3 | CompositionalLayout — list + grid + masonry + carousel in one scroll view |
| F4.3 | State restoration — navigate away and back, exact position on frame 0 |
| P6.2 | **Full FlashList comparison on release build — the money shot** |
| F5.1 | Android port — same C++ engine, cross-platform |
| DOC.1 | Complete solution document with all optimizations and design decisions |
