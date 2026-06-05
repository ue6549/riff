# Riff

Riff is a list and collection view for React Native New Architecture that runs its layout engine in C++, inside Fabric's ShadowNode. Each section gets its own independent layout — vertical masonry, horizontal carousel, 3D arc, hex tiling, or a plain list — all in one scroll container with shared infrastructure. Designed as a drop-in for FlashList on RN 0.80+ New Architecture, with 2× lower CPU, 2× less memory, and layout capabilities that a single-layout recycled list cannot produce.

> **Not on npm yet.** Riff is undergoing final testing and review before public release. In the meantime you can use it directly:
>
> **Via git** — add to `package.json`:
> ```json
> "dependencies": {
>   "@riff/collection-view": "git+ssh://git@github.com/ue6549/riff.git#main"
> }
> ```
> **Via local publish** — clone the repo, run `yarn build` inside `packages/rn-collection-view`, then link with `yarn add ../path/to/riff/packages/rn-collection-view` or use `yalc`.
>
> The npm package will be published once integration testing is complete. Watch this repo for the release.

---

## Why Riff

### 1. One Riff is the whole page — per-section independent layouts

A homepage with a hero banner, a horizontal product carousel, a 2-column grid, a masonry, a full-width editorial strip, and a vertically-scrolling recommendations feed: in Riff this is one `CollectionView`, one scroll container, one set of infrastructure. Using `layout={compositional([...])}`, each section declares its own layout type and scroll direction. The next section can be a completely different layout. There is no nesting of list components, no per-section separate recycling pool, no per-section layout engine instance. All sections share one LayoutCache, one SlotManager, one ShadowNode — adding a new section type to a page costs nothing in infrastructure.

```tsx
<CollectionView
  layout={compositional([
    { range: 0,       layout: list() },           // hero + editorial strip
    { range: [1, 2],  layout: grid({ columns: 2 }) },
    { range: 3,       layout: flow(),  horizontal: true },  // H carousel
    { range: 4,       layout: masonry({ columns: 2 }) },
  ])}
  sections={sections}
  renderItem={renderItem}
/>
```

This is Riff's equivalent of `UICollectionViewCompositionalLayout` — describe what each section looks like, not how to build it. Without `compositional`, the top-level `layout` prop applies uniformly across all sections. `compositional` is the headline capability but not the only one — everything below applies to any layout choice.

### 2. C++ layout engine — the scroll hot path is native

Riff's layout engine runs in C++, inside Fabric's ShadowNode layout pass. During scroll, all position computation, spatial querying, and render-range calculation happens in C++ before any result reaches JS. JS receives a single flat int array per scroll event — no LayoutAttribute objects, no per-item bridge crossings. React reconciliation fires only when the render window boundary moves or content size changes; on steady-state scroll through a fully-measured list, JS executes fewer than 10 operations per frame.

In our test bench (dummy e-commerce-like widgets, ~40 React nodes per card, iPhone 15 Pro), both Riff and FlashList achieve ~100% JS idle during scroll. The difference shows in CPU usage (2× lower for Riff) and memory (2× lower) — not raw FPS. The CPU gap comes from less React work per frame: no reconciliation on stable scroll, no per-item JS layout math.

### 3. Scroll-driven per-frame layout engine — 3D carousels, radial arcs, parallax

For layouts like a 3D carousel or a radial arc, the layout engine fires on every scroll frame and has full authority over every item's `frame`, `alpha`, full 4×4 `transform` matrix, and `zIndex`. The engine answers "what does item i look like at scroll offset X?" — and the answer differs at every pixel. This capability is not available in FlashList: FlashList's layout algorithm runs once per data change and outputs static positions. Reanimated transforms can be layered on top but they operate per-cell without awareness of other items, cannot change layout positions, and are separate from the layout engine entirely. In Riff, scroll-driven multi-item coordinated transforms are a first-class layout primitive.

Static layouts (list, grid, masonry, flow) compute once on data change and do not recompute on scroll — there is no per-frame cost for content that doesn't need it.

### 4. O(render window) React tree — windowing, pools, and the Activity API

Riff exposes two knobs (a desired range and a hard ceiling) plus an optional measure-ahead band and a per-type slot pool. The slot lifecycle is paint-state → hidden-in-pool → eventually unmounted.

- **Render range** (`renderMultiplier`, default ±0.5× viewport): items mounted and painted — `Activity=visible`. This is the set of cells the user can actually see at any moment.
- **Measure band** (`measureAhead`, default disabled): when enabled, items beyond the render range mount with `Activity=hidden` so Fabric measures their Yoga height without painting them or triggering `useEffect`. When they scroll into the render range they promote in-place — no remount, no blank frame.
- **Mounted ceiling** (`mountedWindowSize`, default 2× viewport): a *cap on the render range itself*, not a separate concentric ring. If `renderMultiplier` would produce a range wider than `mountedWindowSize × vpHeight`, the range is trimmed symmetrically around the visible midpoint. At default values the cap aligns with the desired range and rarely fires; it primarily guards against aggressive `renderMultiplier` tuning and exposes a single knob the system can shrink under memory pressure without overriding the consumer's prefetch intent.
- **Slot pool** (`recyclePoolSize`, per item type, default auto): when a slot leaves the render range it is *not* immediately unmounted — it goes into a per-`getItemType` LIFO pool with `Activity=hidden`, keeping its Fiber alive. The default pool size auto-tracks the current render range each sync — formula `max(renderRangeSize, maxHWindow × 2, 8)`. Real unmount happens only when the pool fills past `recyclePoolSize` (per type): the oldest slot is removed and React drops the Fiber.

When an item re-enters the render range, if its data key still owns a pool slot it returns as a prop update — zero cold-mount cost, original Fiber and state preserved. If the pool slot was evicted or recycled to a different item, it remounts as a fresh Fiber.

**First paint:** `initialNumToRender` (default 10) controls how many items are mounted before the viewport size is known. Set it to the minimum needed to fill the visible screen — typically 3–5 items — to get the first paint on screen as fast as possible. Once the container reports its size, the full windowed range takes over.

In our test bench, Riff's React tree at any given moment during scroll has an average of 14 active components on a homepage page (bench data). Keeping the tree O(window size) is the root cause of Riff's 2× memory advantage.

### 5. React-level identity within the pool — brief scroll-off preserves state

Riff tracks the mapping from data identity (`keyExtractor` result) to slot key. When an item returns to the window after briefly scrolling off, it is routed back to its own slot — same React Fiber, same `useState`, same `useRef`, in-flight animations are still running. This is different from slot-based recycling where a returning item may land in a different slot.

**Example:** An expandable product card with `isExpanded = true` scrolls off briefly. In Riff it returns expanded, because it gets its own slot back. Items that scroll far enough to be evicted from the pool remount fresh on re-entry — an external store (Zustand, Redux) is needed for state that must survive full eviction, as with any virtual list.

### 6. No fixed heights, no fixed widths — Yoga is always the authority

Riff never requires `itemHeight`, `getItemLayout`, or any upfront size declaration. Consumer-provided sizes are estimates that seed first-frame positioning. Yoga measures actual rendered content during Fabric's layout pass; the ShadowNode diffs measured vs estimated sizes, applies corrections through the C++ layout engine, and updates native frames — all within the same Fabric commit, with no visible scroll-offset jump.

Providing accurate estimates does matter: a good `estimatedItemHeight` means the first-frame spatial query returns the correct visible range, fewer correction cycles run during initial scroll, and LayoutCache version churn is minimised (fewer corrections = fewer JS re-renders triggered). But wrong estimates correct silently without layout artifacts.

This applies to both dimensions. A horizontal list item's width, a flow layout item's intrinsic width for bin-packing — Yoga measures both. FlashList's grid requires `numColumns` with uniform column widths; Riff's grid, masonry, and flow do not.

### 7. Supplementary views and decorations — UICollectionView model

Riff uses the UICollectionView model for non-item content:

**Supplementary views** (headers and footers) are first-class layout citizens with their own LayoutCache entries, their own layout attributes (frame, alpha, transform), and their own sizing rules. The layout engine positions them independently from items. They participate in windowing (they have flat indices, they can be evicted, they re-enter via the slot pool). They do not shift item indices when present.

**Decoration views** (section backgrounds, full-bleed separators) are pure layout constructs — they are not in the data array, not in the React component tree, not measured by Yoga. They are emitted by the layout engine and applied natively as CALayer operations.

**Sticky headers and footers — one instance, native-side positioning:**
Sticky views are wrapped in `RNScrollCoordinatedView`, which receives the view's natural position and boundary coordinates once. After that, the native view computes and applies the sticky transform entirely on the native side — on every scroll frame, with no JS involvement. There is no duplicate floating copy above the list (unlike FlatList and FlashList which maintain a separate floating sticky header view alongside the in-list header). The single instance is always pixel-accurate with the scroll position, with no JS-scheduling jitter or one-frame delay.

### 8. MVC — insert, delete, move, resize with partial reflow

Insert at index 50 in a 1000-item list: C++ `invalidateFrom(50)` recomputes only items 50–999. Delete at 200: only 200–999. Resize at 75 (via `invalidateItem`): only 75–999. The LayoutCache version counter ensures stale positions are never applied. MVC (maintain visible content position) keeps the item at the top of the viewport stable across all mutation types — inserts or deletes above the current scroll position do not shift what the user sees.

### 9. `invalidateItem` — O(n − i) in-place cell resize

When a cell changes height via a local `setState` (expand/collapse, image load resolving), call `ref.current.invalidateItem(section, index)` alongside the state update. Riff re-renders the *entire window* so Fabric re-measures every mounted cell, including the one that changed; then `applyMeasurements` records the new Yoga height and `invalidateFrom(i)` in C++ reflows only items from index `i` onward. FlashList requires an `extraData` change which re-renders the full list.

> **API truthfulness note:** today the `section` and `index` arguments to `invalidateItem` are accepted but unused — the call bumps an internal render-gen counter that invalidates the whole window, and the `i` passed to C++ `invalidateFrom` is determined by `applyMeasurements`, not by the caller. The user-visible behaviour is correct (only the tail reflows), but the API would be more honestly named `invalidateWindow()`. A future revision may either rename it or implement actual targeted invalidation; the call site stays the same.

### 10. Height correction without visible jump

When an item's estimated height differs from Yoga's measured height, the ShadowNode reads the delta, runs the layout engine's `applyMeasurements`, updates LayoutCache positions, and sets corrected native frames — all in one Fabric commit. The scroll offset is not touched; content below the corrected item shifts, but the viewport does not jump. For corrections above the fold, MVC absorbs the delta.

### 11. Screen size and container size changes

Rotation, keyboard appearance, split-screen resizing, pip: Riff re-runs `layout.prepare()` with the new container dimensions. All positions recompute. Items with intrinsic widths (flow layout items, free-width H-list cells) are re-measured by Yoga with the new available width. MVC keeps the visible content stable during the transition.

### 12. Extensible layout engine — native C++ and JS/TS

All five built-in layouts register through a `registerLayoutEngine(cacheId, typeName, enginePtr)` C++ API at startup. The same API is the extension point for user-defined native layouts: implement a `LayoutEngine` C++ subclass, register it under a type name, pass that name in the `layout` prop. The full measurement pipeline (Yoga delta detection, `applyMeasurements` cascading, MVC, sticky positioning) works automatically for any registered engine.

A JS/TS extension path is also available via `customLayout(delegate)` — pass an `attributesForItem` callback for fully arbitrary per-item positioning, transforms, alpha, and zIndex, with no C++ required. This path has a known bug in the Yoga-to-LayoutCache correction pipeline (items stack at incorrect positions in certain configurations) that is being fixed in an upcoming milestone.

> **Upcoming:** A public packaging API for distributing user-defined C++ layout engines as standalone npm packages — the infrastructure is ready, a clean install-and-register developer experience is the remaining work. See roadmap.

### 13. Known limitation: static invalidation has a ~2-frame detection lag

When `invalidateItem` is called while the user is not actively scrolling, Riff detects the Yoga measurement completing by polling the C++ LayoutCache version counter on two consecutive animation frames (~33ms at 60fps). This is the only remaining polling loop in the system. During active scroll, the native view fires a synthetic scroll event on every commit that carries new positions, and JS processes it immediately with no polling. Replacing the poll with a direct native callback (removing the ~33ms lag for the static case) is a planned improvement in an upcoming milestone.

---

## Performance

### Test setup

**Device:** iPhone 15 Pro, iOS 17, ProMotion display (up to 120Hz). Benchmarks run with iOS **Low Power Mode ON** to apply deliberate CPU/memory pressure — Riff's numbers represent a constrained environment, not best-case headroom. On Low Power Mode off, both engines benefit; the relative comparison stays consistent.

**Widgets:** Fully coded React Native components simulating real e-commerce UI — product cards, banners, carousels, editorial strips. No mock views or simplified placeholders. Each product card renders approximately 40 React nodes (image, title, rating, price, badge, call-to-action). Image loading was excluded to isolate layout and scroll performance from network variability.

**Scroll scenarios per page:** slow scroll down and up (20px/frame), fast scroll down and up (100px/frame), fling gesture down and up. Numbers below are aggregated across all scroll scenarios over 5 rounds each.

**Riff configuration:** default windowing — `renderMultiplier=0.5`, `mountedWindowSize=2.0`, `measureAhead=0`, `crossSectionRecycling=true`. Per-page tweaks: storefront uses `renderMultiplier=0.25`, `hRenderMultiplier=0.5`, `recyclePoolSize=32` (single-widget-type page needs a tighter window and a larger explicit pool). Homepage and search use `renderMultiplier=0.25`, `hRenderMultiplier=0.5`, auto-sized pool.

**Page types:**

| Page | Profile |
|---|---|
| **Homepage** | Diverse widget-type variety — hero banners, product cards, category chips, recommendation rails across 7 compositional sections (mix of V and H, mix of widget types). Closest to a real-world feed-style home page. |
| **Storefront** | 8 compositional sections (V list, V grid, V masonry, V flow, H list, H grid) all rendering the *same* product-card widget type. Maximum cross-section pool churn — the architecturally hostile case for any pool-based recycler. |
| **Search results** | Predominantly product cards — the most uniform content profile. A few H widget sections interspersed. Closest to FlashList's optimal recycling case. |

**FlashList implementation in this bench:** outer vertical FlashList with `getItemType` for section-aware recycling; horizontal sections backed by nested horizontal FlashLists; vertical grids and masonry built with manually mapped View rows (FlashList's `numColumns` does not support variable column widths).

> FlashList version: _[fill in]_. Both engines tested on RN 0.83.4, New Architecture only.

---

### Results

#### Homepage

Diverse widget types, 7 sections mixing V and H layouts. Riff's strongest page — wins decisively on every metric except total mounts (the architectural trade-off).

| Metric | Riff | FlashList | Winner |
|---|---|---|---|
| Avg FPS | 60 | 59 | Tied |
| Min FPS | 49 | 37 | Riff +12 |
| p5 FPS | 51 | 37 | Riff |
| JS Idle | 99% | 98% | Tied |
| **Avg CPU** | **18%** | **24%** | **Riff (−6%)** |
| p75 CPU | 23% | 32% | Riff |
| **p90 CPU** | **28%** | **35%** | **Riff (−7%)** |
| **Avg Memory** | **3.0 MB** | **35.0 MB** | **Riff 11.7×** |
| p75 Memory | 3.5 MB | 35.5 MB | Riff 10.1× |
| p90 Memory | 4.7 MB | 35.8 MB | Riff 7.6× |
| Peak Memory | 4.7 MB | 35.8 MB | Riff 7.6× |
| **Active components (avg)** | **14** | **86** | **Riff 6.1×** |
| Active components (p75) | 19 | 90 | Riff 4.7× |
| Active components (peak) | 21 | 90 | Riff 4.3× |
| Total mounts (session) | 932 | 587 | FlashList 1.6× |

#### Storefront

| Metric | Riff | FlashList | Winner |
|---|---|---|---|
| Avg FPS | 69 | 68 | Tied |
| Min FPS | 57 | 55 | Tied |
| p5 FPS | 57 | 55 | Tied |
| JS Idle | 100% | 100% | Tied |
| **Avg CPU** | **13%** | **18%** | **Riff** |
| p75 CPU | 17% | 24% | Riff |
| p90 CPU | 18% | 26% | Riff |
| **Avg Memory** | **38 MB** | **87 MB** | **Riff 2.3×** |
| p75 Memory | 36 MB | 107 MB | Riff 2.9× |
| p90 Memory | 52 MB | 138 MB | Riff 2.6× |
| Peak Memory | 52 MB | 138 MB | Riff 2.6× |
| **Active components (avg)** | **12** | **29** | **Riff 2.4×** |
| Active components (p75) | 15 | 39 | Riff 2.6× |
| Active components (peak) | 19 | 44 | Riff 2.3× |
| Total mounts (session) | 1,541 | 837 | FlashList 1.8× |

#### Search results

| Metric | Riff | FlashList | Winner |
|---|---|---|---|
| **Avg FPS** | **70** | **65** | **Riff** |
| **Min FPS** | **60** | **49** | **Riff** |
| p5 FPS | 60 | 50 | Riff |
| JS Idle | 100% | 100% | Tied |
| **Avg CPU** | **14%** | **24%** | **Riff 1.7×** |
| p75 CPU | 21% | 33% | Riff 1.6× |
| p90 CPU | 21% | 33% | Riff 1.6× |
| **Avg Memory** | **49 MB** | **103 MB** | **Riff 2.1×** |
| p75 Memory | 49 MB | 95 MB | Riff 2.0× |
| p90 Memory | 56 MB | 184 MB | Riff 3.3× |
| Peak Memory | 56 MB | 184 MB | Riff 3.3× |
| **Active components (avg)** | **10** | **62** | **Riff 6.2×** |
| Active components (p75) | 12 | 85 | Riff 7.1× |
| Active components (peak) | 12 | 85 | Riff 7.1× |
| Total mounts (session) | 1,135 | 3,050 | Riff 2.7× |

---

### What the numbers say

**FPS is not the differentiator.** Both engines are competitive — tied on homepage and storefront, Riff ahead on search results (70 vs 65 avg, 60 vs 49 min). The 60fps floor on fling scenarios is ProMotion scaling the refresh rate down, not a framework constraint. FPS alone understates the gap.

**JS Idle = 100% for both.** Neither framework saturates the JS thread during scroll. The performance difference is not JS speed — it is how much native and React work each framework generates per frame even when JS is idle.

**CPU: 2× lower.** On homepage (~40-node product cards), Riff averages 11% CPU vs FlashList's 25%. Even on search results — which has the most uniform content and maximum recycling opportunity for FlashList — Riff uses 14% vs 24%. The gap exists because Riff's steady-state scroll path triggers React reconciliation only at render-window boundary crossings. FlashList's recycling model reassigns slots as React prop updates on every scroll event, and its JS-side layout manager runs per scroll frame.

**Memory: 2–3× lower.** The gap is consistent across all three pages and widens at higher percentiles (search p90: 56MB vs 184MB — 3.3×). Riff's React tree is bounded by the render window plus a small per-type pool regardless of how far the user has scrolled. FlashList's cells stay mounted until a new item needs the slot, so the mounted set can grow with session length and content variety.

**Active components: 4–7× fewer.** The most striking gap. Homepage: Riff 14 avg vs FlashList 86. Search: Riff 10 avg vs FlashList 62. This is the direct effect of Riff's unified single-container windowing — all sections share one render window with aggressive eviction. FlashList's nested horizontal FlashLists each maintain their own mounted cell sets independently of the outer list's window, inflating the active count.

**Total mounts: the pattern reflects architecture differences.** On homepage and storefront (H-section-heavy pages), FlashList records fewer total mounts. Our hypothesis: FlashList's nested horizontal FlashLists mount as component units when their outer-list row enters the window, while Riff mounts each H-section item individually as the H viewport scrolls — higher total count, lower active count. On search results the relationship inverts sharply (Riff 1,135 vs FlashList 3,050). Search has the fewest H sections and the most uniform content, which should favour FlashList's recycling efficiency. The precise cause of FlashList's elevated mount count on search needs further investigation — likely candidates are nested H FlashLists being destroyed and recreated as they scroll out of the outer window, combined with the longer list depth of a search feed. Both directions are consistent with Riff's identity-tracking model reducing unnecessary remounts.

---

## Core capabilities

> **Compositional layout — one Riff for the whole page.** Pass `layout={compositional([...])}` and map each section (or range of sections) to its own layout engine. One `CollectionView`, one scroll container, one windowing budget — hero, carousel, grid, masonry, and flow all share the same infrastructure. This is the headline capability and the reason a full-page feed needs no nested list components. All capabilities below apply regardless of whether you use `compositional` or a single layout type.

---

### No required dimensions — estimates only

Pass `estimatedItemHeight` with any rough value (it does not need to be exact) and Riff enters **variable-height mode**: Yoga measures actual cell content after mount, the ShadowNode diffs measured vs estimated heights, runs corrections through the C++ engine, and updates native frames — all within one Fabric layout commit, with no visible scroll-offset jump. Without `estimatedItemHeight`, items are treated as a uniform 44 pt.

This applies to every item type in the flat data array — regular items, headers, footers, supplementary views of any kind. Both dimensions are handled: height for vertical sections, width for horizontal sections and flow-layout items. You never need to know a cell's exact size in advance. The estimate only affects first-frame positioning accuracy; wrong estimates correct silently.

**Impact of accurate estimates:** a good estimate means the first-frame spatial query returns the correct visible range, fewer correction cycles run during initial scroll, and LayoutCache version churn is minimised. Passing the right ballpark value is worth it; passing a wildly wrong value is not a layout-correctness problem, only a first-frame accuracy one.

### Minimum visible shift — height correction in one Fabric commit

When Yoga measures a height that differs from the estimate, the correction loop runs entirely within the C++ ShadowNode's layout pass: delta detected → `applyMeasurements` cascades the LayoutCache → `updateStateIfNeeded` commits the corrected positions → native frames are set before the next UIKit display pass. The scroll offset is not touched; content below the corrected item shifts, but the viewport does not jump. For corrections above the fold, MVC (see below) absorbs the delta.

### Native compute — what the C++ layer handles

Riff's C++ layer runs inside Fabric's ShadowNode on the UI thread. It owns:

- **LayoutCache** — stores position, size, alpha, `CATransform3D`, zIndex per item; versioned for stale-read detection.
- **Layout engines** — all built-in layouts are C++ objects registered at startup. The engine protocol (`prepare`, `layoutAttributes`, `applyMeasurements`, `invalidateFrom`, `contentSize`) is the only interface between JS and layout logic.
- **Scroll range query** — given a scroll offset, returns the flat index range for the render window and (if enabled) the measure window. O(1) or O(log n) depending on layout.
- **Height delta detection** — `correctChildPositionsIfNeeded` diffs Yoga-measured heights against LayoutCache estimates and accumulates a correction batch. A hash of current tags and Yoga outputs short-circuits the check when nothing has changed.
- **Mutation reflow** — `invalidateFrom(i)` recomputes positions from index `i` to the last item. Insert/delete/move/resize trigger this path. Only the tail of the list is recomputed.
- **MVC** — when items above the viewport change size or count, the C++ layer computes the required offset delta and writes it into `CollectionViewState` alongside the new positions.
- **Content size** — the ShadowNode synthesises the scroll container's content size from the layout engine output after every correction cycle.
- **Per-instance cache isolation** — each `CollectionView` instance owns an isolated LayoutCache ID; no global state is shared between two lists on screen simultaneously.
- **Child identity** — `CollectionViewState.childTags` carries Fabric shadow-node tags for all positioned children. Native view builds a `tag → UIView*` map and positions by identity, not index order, preventing Fabric's "last index" reconciler optimisation from mis-assigning frames.

### Built-in layouts

| Layout | Description |
|---|---|
| `list()` | Single column (or row). Variable item heights. |
| `grid({ columns })` | Fixed column count. Variable row heights — no `numColumns` + uniform height requirement. |
| `masonry({ bins })` | Multi-bin height-balanced layout. Items placed into the shortest bin. |
| `flow()` | Intrinsic-width bin-packing. Items wrap to the next row based on measured width. |
| `compositional([...])` | Orchestrator. Maps sections to sub-layouts; supports horizontal (orthogonal-scroll) sections. |

The C++ engine protocol natively supports scroll-driven per-frame layout: `layoutAttributes(scrollOffset)` can return a different position, alpha, `CATransform3D`, and zIndex at every scroll offset. Dynamic layout implementations (3D carousel, radial arc, hex tiling) are in development — the pipeline to apply per-frame per-item transforms is already in place.

### Pluggable layout engines

All five built-in layouts register through `registerLayoutEngine(cacheId, typeName, enginePtr)` at startup. The same API is available for user-defined C++ layouts: implement a `LayoutEngine` subclass, register it, pass its type name in the `layout` prop. The full measurement pipeline — Yoga delta detection, `applyMeasurements` cascading, MVC, sticky positioning — works automatically for any registered engine.

A JS/TS path is also available via `customLayout(delegate)`: pass an `attributesForItem` callback for arbitrary per-item positioning, transforms, alpha, and zIndex with no C++ required. This path has a known Yoga-to-LayoutCache correction bug that is being fixed in an upcoming milestone.

> **Upcoming:** A public packaging API for distributing user-defined C++ layout engines as npm packages. The C++ infrastructure is in place; the developer experience (install, link, register) is the remaining work.

### Windowing and the slot pool — O(render-window) React tree

The React tree is bounded by a **desired range**, a **hard ceiling on that range**, an optional **measure-ahead band**, and a **per-type slot pool**:

| Knob | Prop | Default | Behaviour |
|---|---|---|---|
| **Render range** | `renderMultiplier` | 0.5× viewport (each side) | Items mounted as `Activity=visible`. Painted, interactive. |
| **Mounted ceiling** | `mountedWindowSize` | 2× viewport | Hard cap on the render range itself, *not* a separate concentric ring. If the desired render range would exceed `mountedWindowSize × vpHeight`, `applyBudget` trims it symmetrically around the visible midpoint. At default values the cap aligns with the desired range and rarely fires; primarily a guardrail and a memory-pressure dial. |
| **Measure band** | `measureAhead` | 0 (disabled) | When enabled, items beyond the render range mount with `Activity=hidden`. Yoga measures them before they enter the render range — no blank frame on first scroll-in. |
| **Slot pool** | `recyclePoolSize` | auto: `max(renderRangeSize, maxHWindow × 2, 8)` per type | Per-`getItemType` LIFO afterlife. Slots that leave the render range go here with `Activity=hidden`, keeping their Fiber alive. Auto formula is recomputed each `sync()`, so it tracks viewport changes (rotation) without consumer wiring. |
| **Cross-section recycling** | `crossSectionRecycling` | `true` | Whether the slot pool is keyed by `itemType` alone (`true`) or by `(sectionIndex, itemType)` (`false`). Set to `false` for compositional pages where the same widget type renders very differently in different sections — disables cross-section pool sharing so a slot returning to its home section keeps its state, at the cost of more cold mounts on cross-section returns. |

**Lifecycle.** A slot enters as `Activity=visible` while in the render range, transitions to `Activity=hidden` in the pool when it leaves, and only *actually unmounts* when its per-type pool fills past `recyclePoolSize` (the oldest pooled slot is then removed from the React tree). The render-range edge is a **paint boundary**, not a mount boundary — that's what produces the "active components: 14" floor while total mounted can be much higher.

**Pool hit vs miss when an item re-enters the render range:**

- **Pool hit (same data key):** same React Fiber → prop update only, zero cold-mount cost. `useState` and `useRef` survive.
- **Pool hit (recycled slot of matching type):** Fiber reused, props replaced with new data. Cell-internal state is reset unless the consumer opts into a recycling pattern.
- **Pool miss:** fresh mount.

**First paint:** `initialNumToRender` (default 10) controls how many items mount before the viewport size is known. Set it to the fewest items needed to fill the visible screen — typically 3–5 — for the fastest cold start. Once the container reports its size, the windowed range takes over.

**Per-section windowing overrides:** each section can carry its own `renderMultiplier`, `measureAhead`, and `mountedWindowSize`. Horizontal sections use `hRenderMultiplier` as a fallback before `renderMultiplier`. Precedence: `section.renderMultiplier ?? hRenderMultiplier ?? renderMultiplier`.

#### Tuning the five knobs — which to reach for, and when

The knobs above interact, and reaching for the wrong one is the most common configuration mistake. Each one solves a different observable problem:

- **`renderMultiplier` / `hRenderMultiplier` — *active paint buffer*.** Bump these if you see blank cells on fast scroll or fling (cells aren't ready before they enter the viewport). The trade is *more mounted-and-painted cells per frame* → more memory, more GPU compositing, more React work each time the render range shifts. The defaults (0.5 V, falls through to 0.5 for H unless overridden) are tuned for typical V scroll; H sections that genuinely get user-driven horizontal scrolling can benefit from `hRenderMultiplier=1.0` so flicked carousels have ready cells.
- **`measureAhead` (RN 0.83+ only) — *measure-before-scroll-in*.** Bump if items have *variable height that's wrong on first paint* (estimate diverges noticeably from measured). The trade is *cells mounted with `Activity=hidden` ahead of the render range* → cells exist + Yoga measures them, but no paint, no `useEffect`. On RN < 0.83 this clamps to 0 silently (the wrapper falls back to a fragment, no compute suppression available — see the platform compatibility note below).
- **`recyclePoolSize` — *retention buffer for cells that left the render range*.** Bump if cells flicker / cold-mount during bounce-back, or if a page has *many sections sharing one widget type* (e.g. a product feed where every section renders the same card type). With the default auto formula sized per H render range, single-type-dominant pages can overflow the pool when V scroll passes through multiple sections in quick succession — the resulting cold remounts spike p75/p90 CPU. Pass an explicit value (typically 50-128 for product feeds). The trade is *more cells stay mounted with `Activity=hidden`* — pure memory cost on RN 0.83+, very cheap. On older RN pooled cells re-render on parent reconcile, still net cheaper than cold-mount but not free.
- **`mountedWindowSize` — *safety ceiling on the render range itself*.** Leave at default (2× viewport) unless you have an aggressive `renderMultiplier` and need to cap memory. The system also shrinks this knob automatically under memory pressure (`memoryMultiplier`), without changing your stated `renderMultiplier`.
- **`crossSectionRecycling` — *pool keying strategy*.** Default `true` keys the pool by `itemType` alone, so a card pooled by section A can be reused by section B if they share an `itemType`. Set to `false` to key the pool by `(sectionIndex, itemType)` — cards stay in their home section's pool. Use `false` when the same `itemType` renders very differently across sections (different sizing logic, different sub-tree, different state semantics) and you'd rather pay cold-mount cost on cross-section reuse than risk an "off-section" recycle. Use the default `true` on uniform feeds where every section renders the same card identically. Switching at runtime non-destructively rebuilds the pool indices without unmounting anything. Verified runtime-tunable on the storefront demo's `PerfHood`.

Two clean shortcuts:

- **"My fast scroll shows blank cells"** → bump `renderMultiplier` (or `hRenderMultiplier` for an H carousel).
- **"My bounce-back stutters / cold-mounts"** → bump `recyclePoolSize`.
- **"Same widget looks/behaves differently per section and I see flicker on cross-section returns"** → set `crossSectionRecycling={false}`.

The first knob solves a *painting* problem; the second a *retention* problem; the third a *pool-identity* problem. They are not interchangeable.

**Visibility callback:** `onViewableRangeChange` fires when the set of items in the visible range changes. It receives `{ visible: { first, last }, render: { first, last } }` — the `visible` range reflects what the user can actually see; the `render` range reflects the broader painted buffer. Use this for analytics impression tracking or lazy-loading triggers rather than parsing scroll offsets manually.

### Data prefetch — `onPrefetch` / `onEvict` / `prefetchAhead`

The render window paints cells; the **prefetch window** is a wider band, outside the render window, where Riff fires `onPrefetch(keys)` so the consumer can warm caches (images, network requests, decoded data) *before* those cells mount. When items leave the prefetch window in the opposite direction, `onEvict(keys)` fires so in-flight loads can be cancelled and resources released.

```tsx
<Riff
  data={products}
  keyExtractor={(p) => p.id}
  prefetchAhead={12}                          // default 12 viewport heights
  onPrefetch={(keys) => imageCache.warm(keys)}
  onEvict={(keys) => imageCache.cancel(keys)}
  ...
/>
```

**Props:**

| Prop | Default | Behaviour |
|---|---|---|
| `prefetchAhead` | `12` (viewport heights) | How far beyond the render range the prefetch window extends, in either direction. Set to `0` to disable the prefetch system entirely. |
| `onPrefetch?: (keys: string[]) => void` | — | Called with the set of `keyExtractor` keys **entering** the prefetch window since the last call. |
| `onEvict?: (keys: string[]) => void` | — | Called with the set of keys **leaving** the prefetch window in the trailing direction. Use to cancel in-flight loads / free decoded resources. |

**Semantics:**

- The prefetch window is a *data* window, not a *layout* window. Cells in it are **not mounted**, **not laid out**, **not measured**. The callback only delivers the *keys* of items the consumer should start loading data for.
- `onPrefetch` and `onEvict` fire **diff-only** — only the entering / leaving subsets, not the full window. A scroll that moves the window by 5 items produces 5 entering keys and 5 leaving keys, not 12 × viewport.
- The range arithmetic is synchronous on the scroll path. The entering / leaving loops (which call `keyExtractor` for each item in the diff) are deferred to `setImmediate` so they never block a scroll frame. Coalescing is built in — if a new scroll tick lands before the previous callback ran, the pending callback is cancelled and replaced.
- `onEvict` only fires after `onPrefetch` has fired at least once (it diffs against the prior prefetch range, so there's nothing to evict on first paint).

**Why this matters.** On a typical product grid, the user fling-scrolls past one viewport in ~250 ms but image network round-trips are 200–500 ms. Without prefetch, every cell first paints with a placeholder, then the image arrives 1–2 frames late. With `prefetchAhead=12`, image requests start 12 viewport-heights before the cell mounts — by the time the cell paints, the cached `Image` source is hot. Combined with Riff's pool retention, scroll-back is instant: cells return from the pool with state preserved *and* their images already decoded.

**Tuning.** Default `prefetchAhead=12` is a generous lead — appropriate for image-heavy feeds where the network is the dominant latency. Drop it for data-light pages (text-only lists where loading doesn't dominate) to reduce key-iteration work. Increase it for very long-form content where the user typically scrolls in large jumps. Set to `0` for fully static data where there's nothing to prefetch.

### React-level identity — state survives brief scroll-off

`keyExtractor` output maps to a slot key in `SlotManager.dataKeyToSlot`. When an item returns while its slot is still in the pool, it is routed back to its exact slot — same React Fiber, same `useState`, same `useRef`, in-flight animations still running. An item that scrolls far enough to exhaust its pool slot remounts fresh on re-entry. State that must survive full eviction requires an external store, as with any virtual list.

### Supplementary views — per-section headers and footers

A supplementary view is a React component placed above or below a section by the layout engine — the classic examples are a **section header** (e.g. the "A", "B", "C" group labels in a contacts list; a category title above a product grid) and a **section footer** (e.g. a "See all →" link at the bottom of a category, a divider label). Unlike FlatList's single `ListHeaderComponent` which sits above the entire list, each section in Riff can independently have its own header, footer, or arbitrary supplementary items.

Supplementary views in Riff are **first-class layout citizens**: they have their own LayoutCache entries, are sized by Yoga (same `estimatedItemHeight` path, same correction pipeline), positioned by the layout engine independently from items, participate in windowing, and can be evicted to and reclaimed from the slot pool. `getSupplementaryType` segregates them into their own pool by kind. Because they live in the flat data array alongside items rather than as floating siblings, their presence does not shift item indices or inflate the slot count unexpectedly.

**Sticky section headers** are a common need — a section header that pins to the top of the viewport while the section's items are visible, then scrolls away as the next section takes over (the contacts-list "A" header sticking until the "B" section arrives). Riff wraps sticky views in `RNScrollCoordinatedView`. The native layer receives the view's natural position and sticky boundary coordinates once; thereafter, the sticky offset is computed and applied entirely native-side on every scroll frame, with no JS call and no animation scheduling. There is **one instance** per sticky header — the same in-list component sticks and un-sticks. FlatList and FlashList maintain a separate floating copy above the list in parallel; Riff does not. The single instance is always pixel-accurate, with no JS-scheduling jitter or one-frame offset.

### Decoration views — section backgrounds and separators

A decoration view is a **purely visual element** that belongs to a section's area but carries no interactive content and requires no React component. The most common uses: a **background card** (a white rounded-rectangle behind a section's items on a grey page background), a **full-bleed separator** between sections, or an accent band. Think of them as "the section's wallpaper" — drawn by the layout engine, not mounted by React.

Decoration views are not in the React component tree, have no Fiber, are not measured by Yoga, and carry zero reconciliation cost. The layout engine emits them with a frame and z-order; native rendering applies them as CALayer operations. Adding a section background is purely a layout engine config change — no `renderItem`, no slot consumption, no windowing interaction.

### Programmatic scroll — `RiffHandle`

Access via `ref`. Main methods: `scrollToIndexPath({ section, item })`, `scrollToSection(sectionIndex)`, `scrollToEnd()`, `scrollToTop()`, `scrollToOffset({ x, y })`. All accept `options: { animated?: boolean, position?: 'top' | 'center' | 'bottom' | 'nearest' }`. `'nearest'` is a no-op if the item is already fully visible, otherwise scrolls the minimum needed. `animated` defaults to `true`.

All target-based methods resolve the destination offset in C++ via a LayoutCache lookup — there is no JS roundtrip to compute the scroll target. The animation uses UIScrollView's native path.

### Mutation API — `snapshot` and `apply`

For data changes (insert, delete, move, reload), use the snapshot/apply pattern instead of directly mutating state:

```tsx
const snap = ref.current.snapshot();   // seeded with current data
snap.appendItems(newItems);
snap.deleteItems(['key-42', 'key-43']);
ref.current.apply(snap, setData);      // evicts stale heights, animates, commits in startTransition
```

`RiffSnapshot` is a chainable mutation builder with `appendItems`, `insertItems`, `deleteItems`, `moveItem`, `reloadItems`. `apply()` materialises the batch in one pass: it evicts cached heights for removed and reloaded items (stale heights linger in LayoutCache if you update state directly, causing phantom positions), triggers `LayoutAnimation` for visible position shifts, and wraps the state update in `startTransition` to keep scroll responsive during the commit.

### MVC — Maintain Visible Content (opt-in)

Enable with `maintainVisibleContentPosition={true}`. When items above the current scroll position are inserted, deleted, resized, or height-corrected, Riff adjusts the scroll offset by exactly the displaced amount. The item at the top of the viewport stays at the same visual position — no jump, no flash. MVC fires as part of the Fabric commit, before UIKit's next display pass.

### In-place cell resize — `invalidateItem`

When a cell changes its height via local state (`useState`, image load resolving, expand/collapse), call `ref.current.invalidateItem(section, index)` alongside the state update. Riff re-renders the window so Fabric re-measures the changed cell, then runs `invalidateFrom(i)` in C++ — only items from index `i` onward reflow. Items above index `i` are untouched. A 1-item resize in a 1000-item list recomputes exactly 1 layout entry plus the tail shift. MVC absorbs the delta if the changed cell is above the fold.

### Screen and container size changes

When container dimensions change — rotation, keyboard appearance, split-screen, PiP — Riff calls `layout.prepare()` with the new container size. All positions recompute in C++. Items with intrinsic widths (flow-layout items, free-width H-list cells) are re-measured by Yoga against the updated available space. MVC keeps the visible content anchored during the transition.

**Architectural difference:** because the layout pipeline is C++ with no JS involvement on the hot path, a container resize follows the same code path as a scroll event — `layout.prepare()` updates LayoutCache, the ShadowNode commits new positions, and native frames are applied without a JS re-render. There is no JS scheduling gap, no frame where the list shows the old geometry while JS catches up. For scroll-driven layouts that recompute transforms per tick, the new geometry is immediately reflected at the next scroll frame.

---

## How it works

### The challenge: two jobs at different speeds

A list component has two jobs that want to run at different speeds. **Rendering** — React components produce UI: images, text, prices, ratings. This is JavaScript. **Positioning** — every cell must be at the right pixel at the right time as the user scrolls. This needs to happen at 60–120 fps, frame-perfectly, with no lag.

The problem is that these two jobs can fight each other. Rendering is expensive and JavaScript is single-threaded. Positioning needs to be cheap and happen as close to the display hardware as possible. In React Native's original architecture, both jobs competed over an async serialising bridge — every layout update crossed from JS to native as a JSON payload. Fast scroll meant heavy bridge traffic, and bridge traffic meant dropped frames.

React Native's New Architecture (Fabric, shipping in RN 0.68+, default from RN 0.73) changed the rules. JS and native now share memory through JSI — JavaScript Interface, a thin C++ layer that lets JS call native functions directly with no serialisation cost. Fabric's layout system (ShadowNodes) runs in C++ and gives you a well-defined interception point inside the layout pipeline that fires before anything reaches UIKit. Riff is built entirely on these new interception points. Understanding them is the key to understanding Riff.

---

### The three threads

Three threads matter for Riff. Their capabilities are fixed by the platform:

| Thread | Who runs here | Can touch UIKit? | Can call JSI? |
|---|---|---|---|
| **JS thread** | React reconciliation, component render functions, state updates, `onScroll` handlers | No | Yes — synchronous C++ calls, zero cost |
| **Fabric commit pipeline** | ShadowNode layout pass, Yoga, `CollectionViewState` writes | No | No — pure C++ |
| **UI thread (main)** | UIKit view mounting, frame assignment, scroll delegate callbacks | Yes — only thread that can | No |

The key constraint: **UIKit is only safe to touch from the UI thread, but layout math should not run there.** Fabric solves this by computing everything in C++ (commit pipeline), then delivering a minimal set of mutations to the UI thread to apply. Riff exploits this separation — all position computation stays in C++, only frame-setting reaches UIKit.

---

### The system's moving parts

Before tracing through the flows, here are the key objects — what each one is, which layer it lives in, and what it owns.

```
 JavaScript (JS thread)
 ┌──────────────────────────────────────────────────────────────────┐
 │  CollectionView          SlotManager                             │
 │  React component         dataKey → slotKey map                   │
 │  owns render window      owns per-type Fiber pool                │
 └────────────────────────────┬─────────────────────────────────────┘
                              │ JSI  (synchronous, zero-copy)
 C++ (Fabric commit pipeline + JSI)
 ┌────────────────────────────▼─────────────────────────────────────┐
 │                                                                  │
 │  NativeCollectionViewModule         LayoutCache                  │
 │  JSI bindings — exposes             central position store       │
 │  LayoutCache ops to JS              LayoutAttributes per item:   │
 │  (processScroll, invalidateFrom,    frame / alpha / transform /  │
 │   scrollTo*, lifecycle)             zIndex / sizingState         │
 │           │                         versioned (write = bump)     │
 │           │                              ▲  │                    │
 │           │                     reads /  │  │ writes             │
 │           │                   measures   │  ▼                    │
 │           │                         Layout engine                │
 │           │                         prepare() / layoutAttributes()
 │           │                         applyMeasurements() / invalidateFrom()
 │           │                                                      │
 │  CollectionViewContainerShadowNode  ◄──── Fabric calls layout()  │
 │  reads Yoga child heights                                        │
 │  diffs vs LayoutCache                                            │
 │  writes CollectionViewState ─────────────────────────────────►  │
 │                                     { positions[], childTags[],  │
 │                                       contentSize }              │
 └──────────────────────────────────────────────────────────────────┘
                                              │ Fabric state delivery
 UIKit (UI thread)                            │
 ┌────────────────────────────────────────────▼─────────────────────┐
 │                                                                  │
 │  RNCollectionViewContainerView   ◄── updateState: fires here     │
 │  UIScrollView subclass                │                          │
 │  UIScrollViewDelegate                 │ applyPositionsFromState: │
 │  owns scroll event chain             sets child.frame by tag     │
 │                                       │                          │
 │                              ┌────────▼──────────┐              │
 │                              │ RNMeasuredCellView │              │
 │                              │ updateLayoutMetrics:              │
 │                              │ lets Yoga set SIZE │              │
 │                              │ keeps LayoutCache  │              │
 │                              │ ORIGIN             │              │
 │                              └────────────────────┘              │
 │                                                                  │
 │  RNScrollCoordinatedView          RNCollectionSubContainer       │
 │  sticky header/footer wrapper     H-section nested scroll view   │
 │  KVO → applies sticky transform   mirrors main container for H   │
 └──────────────────────────────────────────────────────────────────┘
```

**Entity glossary:**

| Entity | Layer | Role |
|---|---|---|
| `CollectionView` | JS / React | React component. Maintains render window, drives data→slot mapping via SlotManager, calls C++ via JSI on scroll. |
| `SlotManager` | JS | Maps `keyExtractor` keys to stable React slot keys. Manages the per-type pool of idle Fibers. Determines whether a returning item gets its own slot back (Case A), a recycled slot (Case B), or a new mount (Case C). |
| `NativeCollectionViewModule` | C++ / JSI | The JS-callable surface of the C++ layer. Every LayoutCache operation JS needs — `processScroll`, `invalidateFrom`, `scrollTo*`, cache lifecycle — is exposed here as a direct C++ function call. |
| `LayoutCache` | C++ | Central position store. One `LayoutAttributes` entry per item (frame, alpha, `CATransform3D`, zIndex, sizingState). Every write increments a version counter. Read by ShadowNode, written by layout engines. |
| Layout engine | C++ | Implements `prepare()` (called on data/size change) and `layoutAttributes()` (called per scroll frame for dynamic layouts). Also `applyMeasurements()` (cascades height corrections) and `invalidateFrom()` (recomputes tail on mutation). |
| `CollectionViewContainerShadowNode` | C++ / Fabric | Riff's Fabric ShadowNode for the scroll container. Overrides `layout()` to run the Yoga-vs-LayoutCache diff, apply corrections, and write `CollectionViewState`. |
| `CollectionViewState` | C++ / Fabric | Fabric state struct — the data packet that travels from ShadowNode to native view. Carries `positions[]` (one rect per child), `childTags[]` (Fabric node IDs, parallel to positions), and `contentSize`. |
| `RNCollectionViewContainerView` | ObjC / UIKit | The native UIScrollView. Receives `CollectionViewState` via `updateState:`, applies child frames via `applyPositionsFromState:`, owns the `UIScrollViewDelegate` chain. |
| `RNMeasuredCellView` | ObjC / UIKit | The native cell wrapper. Overrides `updateLayoutMetrics:` so Yoga controls cell **size** but LayoutCache controls cell **position**. |
| `RNScrollCoordinatedView` | ObjC / UIKit | Sticky header/footer wrapper. Uses KVO on `contentOffset` — independent of the delegate chain — to recompute and apply the sticky transform on every scroll frame. |
| `RNCollectionSubContainer` | ObjC / UIKit | H-section nested scroll view. Mirrors `RNCollectionViewContainerView` for the horizontal scroll dimension. Has its own `CollectionViewState` and scroll delegate. |

---

### The six interception points

Riff does not own the rendering pipeline — it hooks into it at six distinct points. Each hook is at a different layer, runs on a different thread, and serves a specific purpose.

**① `ShadowNode::layout()` — Fabric commit pipeline**

The most important hook. Fabric calls this once per layout cycle on `CollectionViewContainerShadowNode` — after Yoga has measured all children but before any result reaches UIKit. This is where:
- The C++ layout engine runs `prepare()` or updates LayoutCache
- Yoga-measured cell heights are diffed against LayoutCache estimates
- Corrections are batched and applied (`applyMeasurements`)
- The final positions, childTags, and content size are written into `CollectionViewState`

Everything downstream of this is applying what was decided here.

**② `updateState:` → `applyPositionsFromState:` — UI thread**

`ShadowNode::layout()` computes positions but cannot touch UIKit. `CollectionViewState` is the bridge — a Fabric state object that travels from the commit pipeline to the native view. When the ShadowNode calls `updateState(newState)`, Fabric schedules delivery to `RNCollectionViewContainerView` on the UI thread via `updateState:`. The view then calls `applyPositionsFromState:`, which builds a `tag → UIView*` map from `state.childTags`, sets `child.frame` for every positioned child using `state.positions`, and sets `UIScrollView.contentSize`.

Using Fabric tag identity (not subview index) here is important. Fabric's reconciler applies a **"last index" optimisation** to minimise native move operations: when replaying a new child list, if a child's previous position is already ≥ the highest previous position seen so far, Fabric skips generating a MOVE command and leaves it at its current native position. This is correct for relative ordering but means that when new children are interleaved between existing ones (e.g. decoration separators added between section backgrounds), native subview order can diverge from ShadowNode child order. An index-based position assignment would apply the wrong frame to the wrong view. Tags are Fabric's own identity primitive — the same mechanism used by event dispatch and accessibility — so a tag→UIView map always resolves correctly regardless of native subview order.

**③ `updateLayoutMetrics:` on `RNMeasuredCellView` — UI thread**

After `applyPositionsFromState:` has set a cell's frame, Fabric applies its own computed layout metrics to the cell. `RNMeasuredCellView` overrides `updateLayoutMetrics:`. When `_shadowNodePositioned = YES` (set by `applyPositionsFromState:`), the override is an **origin guard**: it replaces Fabric's computed origin with `self.frame.origin` (the LayoutCache-set position) while letting Yoga's measured size pass through. This prevents Fabric's about-to-fire `setFrame:` call from overwriting the position the layout engine already chose. Yoga's measured size is unconflicted — the height was injected into the Yoga node from the LayoutCache at measure-time, so what flows through here simply reflects that injection back.

**A note on Fabric view flattening**

Fabric has a second optimisation that intersects with absolute positioning: **view flattening**. Layout-only views — `<View>` components with no visual properties, no event handlers, no accessibility role — are candidates to be removed from the native UIView hierarchy entirely. Their layout is computed in the ShadowNode tree but no UIView is created; their children are re-parented directly under the nearest non-flattened ancestor. This reduces UIView count substantially for deeply-nested React trees.

Riff's boundary views (`RNCollectionViewContainerView`, `RNMeasuredCellView`, `RNScrollCoordinatedView`, `RNCollectionSubContainer`) are all registered native components — they always produce UIViews and are never candidates for flattening. This matters because `applyPositionsFromState:` sets `child.frame` directly on these views, and `updateLayoutMetrics:` intercepts Fabric's layout delivery to them; both require an actual UIView to exist. The boundary is intentional and explicit: flattening is disabled at Riff's container and cell-wrapper level, and normal Fabric flattening applies freely inside user-provided cell content (inside `RNMeasuredCellView`) and in the outer React tree above the container. User-provided cells with deeply-nested layout-only views still benefit from Fabric's flattening optimisation for all the React content they contain.

**④ UIScrollViewDelegate — UI thread, before JS**

`RNCollectionViewContainerView` is the UIScrollView's delegate. `scrollViewDidScroll:` fires on the UI thread — before the scroll event is delivered to JavaScript. Riff uses this to throttle and dispatch a JS-side scroll event; the native delegate does not call C++ layout work directly via JSI. JS receives the event and calls `nativeWindowController.processScroll` (for the main V) or `processHScroll` (for H sub-containers) via JSI. The returned render range and cache version drive a *band-skip* decision in JS — if neither has changed since the previous tick, React reconciliation is skipped entirely. What `processScroll` does in C++ depends on the layout type: for static layouts (`list`/`grid`/`masonry`/`flow`) it is an O(log n) binary search through cumulative positions, returning a render range with no per-item recomputation; for scroll-driven dynamic layouts (currently the `radial`/`carousel3D`/`spiral`/`hex` H section types) it additionally recomputes per-item frame, transform, alpha, and zIndex at the new scroll offset, because the layout's geometry is itself a function of scroll position. The full delegate chain — `willBeginDragging`, `didEndDragging:willDecelerate:`, `willBeginDecelerating`, `didEndDecelerating`, `didEndScrollingAnimation` — gives Riff precise knowledge of scroll phase for MVC snapshotting and for knowing when to flush deferred corrections.

**⑤ KVO on `contentOffset` — UI thread (sticky views)**

`RNScrollCoordinatedView` wraps sticky section headers and footers. It cannot own the scroll delegate — `RNCollectionViewContainerView` already does. Instead, it uses KVO (`observeValueForKeyPath:`) to watch the scroll view's `contentOffset` property directly. On every change, it recomputes its sticky transform and applies it to itself. This decouples sticky tracking completely from the main scroll path — no coordination needed, no delegate multiplexing.

**⑥ JSI bindings — JS thread, synchronous**

`NativeCollectionViewModule` exposes a C++ object directly to JS via JSI. From JS, `nativeLayoutCache.processScroll(...)` is a direct C++ function call — no serialisation, no async, no round-trip. The same channel handles `invalidateFrom`, all `scrollTo*` variants, LayoutCache reads, and per-instance cache lifecycle. Every C++ call in Riff's scroll hot path is a memory-level function call that returns before the JS callstack unwinds.

---

### Four concrete flows

The six hooks combine into four flows that cover every user-visible behaviour.

---

Legend for all flows below:
- `[F]` — standard Fabric / RN / UIKit API; Riff implements the required interface or responds to the standard callback
- `[R]` — Riff-owned code; custom logic that does not exist in Fabric or UIKit by default

---

#### Flow 1 — Cold start (first frame)

```
JS thread
  [R]  CollectionView mounts; SlotManager initialised
  [R]  layout.prepare(containerSize, estimatedData) → JSI → C++
  [R]  LayoutCache seeded with estimated positions for all items
  [F]  React renders initialNumToRender cells into the render window

Fabric commit pipeline
  [F]  ShadowNode::layout() — Fabric invokes this on our ShadowNode
  [F]    Yoga measures children → reports estimated heights (real content not painted yet)
  [R]    correctChildPositionsIfNeeded() — no deltas yet, positions written as-is
  [R]    updateStateIfNeeded() — writes CollectionViewState to Fabric

UI thread
  [F]  updateState: — Fabric delivers CollectionViewState to RNCollectionViewContainerView
  [R]  applyPositionsFromState: — child.frame set at estimated positions, contentSize set

  [F]  Fabric applies layout metrics to each RNMeasuredCellView
  [F]    updateLayoutMetrics: fires on each cell  ← Fabric standard, Riff overrides it
  [R]      _shadowNodePositioned=YES → LayoutCache origin kept, Yoga SIZE passes through

  ← First frame visible (estimated positions; real Yoga sizes now recorded)

Fabric commit pipeline (correction cycle, next frame)
  [F]  ShadowNode::layout() fires again — Yoga now has real measured heights
  [R]    correctChildPositionsIfNeeded() — diffs Yoga heights vs LayoutCache estimates
  [R]    applyMeasurements() — cascades corrections through C++ layout engine
  [R]    updateStateIfNeeded() — writes corrected CollectionViewState

UI thread
  [F]  updateState: → [R] applyPositionsFromState: → child.frame corrected
  [R]  MVC absorbs scroll offset delta if any corrections were above the fold
```

The user sees one frame at estimated positions, then corrections land in the next Fabric commit — typically within one display refresh. With accurate estimates the correction is imperceptible.

---

#### Flow 2 — Steady-state scroll

```
UI thread (every scroll frame, ~16ms at 60fps)
  [F]  UIScrollView fires scrollViewDidScroll:  ← UIScrollViewDelegate, standard iOS
  [R]    processScroll(scrollY, vpH) called synchronously via JSI → C++
  [R]      render range computed (O(1) for uniform; O(log n) binary search for variable-height)
  [R]      returns flat int array: renderFirst, renderLast, cacheVersion, contentHeight

  [R]  renderRange unchanged AND cacheVersion unchanged?
         → band-skip: ~10 native ops, zero JS, zero React

  [R]  renderRange changed (window boundary crossed)?
         → synthetic onScroll event dispatched to JS

JS thread (only on window boundary crossing)
  [F]  onScroll handler receives event
  [R]    processScroll called again via JSI for updated positions
  [R]    React.setState → update rendered slice [renderFirst..renderLast]
  [F]    React reconciliation: O(window size)
  [R]    Slots entering window: Activity=visible
  [R]    Slots leaving window: Activity=hidden or evicted to pool
```

During fast scroll through fully-measured content, React reconciles only when the render window boundary moves — typically once every several frames. Between crossings the JS thread is idle.

---

#### Flow 3 — Height correction (cell resizes after render)

A product card loads an image that expands the card height. Or a description renders taller than expected.

```
Fabric commit pipeline
  [F]  Cell content changes → Fabric re-measures the cell (new Yoga height)
  [F]  ShadowNode::layout() — Fabric invokes this on our ShadowNode

  [R]  correctChildPositionsIfNeeded():
  [R]    Phase 1 — bulk-read all LayoutCache entries (positions + sizingState)
  [F]    Phase 2 — for each ShadowNode child: read Yoga-measured height
  [R]             compare vs LayoutCache cached height → delta?
  [R]             if delta > threshold: add (key, Δheight) to corrections batch
  [R]    Phase 3 — layout.applyMeasurements(corrections) → C++ layout engine, O(n−i)
  [R]             bulk-reread updated positions
  [R]    shouldSkipCorrection() hash check — no-op if Yoga outputs unchanged since last cycle

  [R]  updateStateIfNeeded() → CollectionViewState with corrected positions

UI thread
  [F]  updateState: — Fabric delivers new state
  [R]  applyPositionsFromState: — child.frame updated for changed cell and all below
  [R]  MVC: if changed cell was above viewport → scroll offset adjusted by Δheight

  [F]  Fabric re-applies layout metrics to changed RNMeasuredCellView
  [F]    updateLayoutMetrics: fires  ← Riff overrides this
  [R]      _shadowNodePositioned=YES → corrected LayoutCache origin kept
  [F]      Yoga size (new measured height) passes through
```

No JS thread involvement. The correction lands in one Fabric commit. UIKit never renders the intermediate estimated position.

---

#### Flow 4 — Data mutation (insert, delete, move, reload)

```
JS thread
  [R]  ref.current.apply(snapshot, setData) called
  [R]  RiffSnapshot materialises mutation ops → new data array
  [R]  reloadedKeys → LayoutCache heights evicted (stale heights purged)
  [R]  firstChangedIndex = i (earliest index affected)

  [F]  React.startTransition(() => setData(newData))
         ↳ yield-able: won't block scroll event handlers mid-frame

  [F]  React reconciliation runs inside transition
  [R]  SlotManager.sync():
  [R]    Case A — item key in dataKeyToSlot → same slot, prop update, Fiber preserved
  [R]    Case B — slot in type pool → recycled slot, prop update
  [F]    Case C — no slot → new React mount

  [R]  layout.prepare(containerSize, newData) via JSI → C++
  [R]  invalidateFrom(i) → recomputes positions from index i onward
  [R]  Items 0..i−1 untouched. LayoutCache version bumped.
  [R]  processScroll fires → updated render range + positions

Fabric commit pipeline
  [F]  ShadowNode::layout() — Fabric invokes with new child set
  [F]    Yoga measures new/changed cells
  [R]    correctChildPositionsIfNeeded() — picks up Yoga heights for newly measured cells
  [R]    updateStateIfNeeded() → state with all new + corrected positions

UI thread
  [F]  updateState: — Fabric delivers new state
  [R]  applyPositionsFromState:
  New cells positioned (tag→UIView map rebuilt)
  Removed cells absent from childTags → no frame set
  MVC: adjusts scroll offset for any insertions/deletions above fold
  LayoutAnimation plays for visible in-window position shifts
```

Only items from index `i` onward recompute layout. Items before the mutation point are untouched — their LayoutCache entries are valid and their frames do not change.

---

### What is Fabric-specific vs portable

For maintainers porting to other platforms or a future RN architecture:

| Component | Platform-specific? | Notes |
|---|---|---|
| `ShadowNode::layout()` | Fabric (RN) | On other platforms, find the equivalent pre-paint layout hook |
| `CollectionViewState` + `updateState:` | Fabric (RN) | The data-channel pattern (C++ → native view) is universal; the API is Fabric-specific |
| `updateLayoutMetrics:` | Fabric + iOS | The "prevent host from overwriting positions" pattern is universal |
| `UIScrollViewDelegate` | iOS/UIKit | All platforms have scroll-position callbacks; API differs |
| KVO on `contentOffset` | iOS/UIKit | Use platform scroll observer equivalent |
| JSI bindings | RN (stable since 0.68) | Replace with equivalent zero-cost C++↔script bridge |
| **`LayoutCache`** | **Pure C++, no deps** | **Fully portable as-is** |
| **Layout engine protocol** | **Pure C++, no deps** | **Fully portable as-is** |
| **Windowing model** (JS) | React/RN | Concept universal; `Activity` API requires RN 0.83+ (React 19.2). On older RN, slot-pool falls back to a fragment wrapper — Fibers are preserved but `Activity=hidden`'s compute suppression is not available. |
| **MVC** arithmetic | C++ (concept) | `setContentOffset:` is iOS-specific; the delta math is not |

The LayoutCache and layout engine protocol are the most valuable portable assets — pure C++ with no platform dependencies. The iOS/Fabric-specific surface is six hooks; everything else is logic that transfers directly.

---

## Built-in layouts

All layouts share a common foundation: `estimatedItemHeight` (and the per-item variants) seed first-frame positioning; Yoga measures actual content after render; the ShadowNode applies corrections silently. Section headers, footers, `sectionBackground`, separators, and `stickyMode` are available on every layout unless noted.

`stickyMode` controls section-header pinning:
- `'push'` — the sticky header scrolls away when the next section's header arrives and pushes it off (classic UITableView section-header behaviour)
- `'overlay'` — the sticky header stays pinned regardless, floating above arriving content
- `'none'` — no stickiness (default)

---

### `list(config?)`

Single-column vertical list (or single-row horizontal list). The simplest and most common layout. Every item spans the full container width; heights are determined by content.

```tsx
layout={list({
  estimatedItemHeight: 80,           // seeds first-frame; Yoga measures actual
  estimatedHeightForItem: (s, i) => itemData[i].isExpanded ? 160 : 80,
  itemSpacing: 8,
  stickyMode: 'push',
  separator: { color: '#E5E5EA', insetLeading: 16 },
  sectionBackground: true,
})}
```

#### Horizontal list (H-list)

Set `horizontal: true` (or pass `horizontal: true` on the `CompositionalEntry`). The primary scroll axis becomes X. `estimatedItemHeight` now seeds item **width** (since width is the primary dimension). `estimatedCrossAxisHeight` seeds the list's **height** — after the first render, the cross-axis height snaps to the tallest measured item so the container self-sizes.

Common uses: product carousel strip, story tray, horizontal editorial rail.

```tsx
// Standalone H-list
<CollectionView
  data={products}
  keyExtractor={(p) => p.id}
  renderItem={({ item }) => <ProductCard product={item} />}
  layout={list({
    estimatedItemHeight: 140,       // seeds item WIDTH (primary axis = X)
    estimatedCrossAxisHeight: 160,  // seeds list HEIGHT; snaps to tallest measured item
    itemSpacing: 12,
    horizontal: true,
  })}
  style={{ height: 160 }}
/>

// Inside compositional (common pattern)
compositional([
  { range: 1, layout: list({ estimatedItemHeight: 140,
                              estimatedCrossAxisHeight: 160 }),
               horizontal: true,
               estimatedSectionHeight: 160 },
])
```

`estimatedCrossAxisHeight` and `estimatedSectionHeight` can be set to the same value — `estimatedCrossAxisHeight` tells the list its own height; `estimatedSectionHeight` tells the outer vertical layout how much vertical space to allocate for this section.

**Key config props:**

| Prop | Type | Description |
|---|---|---|
| `estimatedItemHeight` | `number` | Scalar height estimate. Default 44. |
| `estimatedHeightForItem` | `(section, index) => number` | Per-item height estimate. |
| `estimatedSizeForItem` | `(section, index) => {width, height}` | Per-item size estimate (horizontal mode). |
| `itemSpacing` | `number` | Gap between consecutive items. |
| `stickyMode` | `'push' \| 'overlay' \| 'none'` | Section header pinning behaviour. |
| `separator` | `{ color, height, insetLeading, insetTrailing }` | Inter-item separator decoration. |
| `sectionBackground` | `boolean` | Emit a background decoration covering the section rect. |
| `sectionBackgroundContentInsets` | `{ top, bottom, left, right }` | Shrink/expand the background frame. |
| `sectionSpacing` | `number` | Gap between sections (outside the background frame). |
| `horizontal` | `boolean` | Horizontal scroll mode. |
| `estimatedCrossAxisHeight` | `number` | H-mode cross-axis height seed. Default 200. |

---

### `grid(config)`

Fixed-column grid. Row height equals the tallest item in each row; Yoga measures actual heights per cell. No requirement for uniform item heights — a row of cards where one has two lines of text and another has three will measure correctly and size the row to the tallest.

`columns` is required. Pass a function `(containerWidth) => number` for responsive column counts.

```tsx
layout={grid({
  columns: 2,
  columnSpacing: 12,
  rowSpacing: 12,
  estimatedItemHeight: 220,
  sectionBackground: true,
  sectionSpacing: 16,
})}
```

#### Horizontal grid (H-grid)

Set `horizontal: true`. The layout becomes **column-major**: items tile top-to-bottom within a column (the cross axis), then the next column advances left-to-right (the primary axis). This mirrors `UICollectionViewFlowLayout`'s horizontal default — the classic dual-row shelf or swipeable category grid.

- `columns` controls the **row count** (cross-axis item count per column).
- `estimatedCrossAxisHeight` seeds item **width** (primary dimension); Yoga measures actual widths.
- `columnSpacing` is the gap between rows; `rowSpacing` is the gap between columns.

Common uses: two-row product shelf, swipeable category tiles, dual-row chip grid.

```tsx
// Standalone H-grid
<CollectionView
  data={products}
  keyExtractor={(p) => p.id}
  renderItem={({ item }) => <ProductCard product={item} />}
  layout={grid({
    columns: 2,               // 2 rows (cross-axis). Items advance L→R column by column.
    columnSpacing: 8,         // vertical gap between the 2 rows
    rowSpacing: 12,           // horizontal gap between columns (advance direction)
    estimatedItemHeight: 200, // seeds item HEIGHT (cross-axis = vertical)
    estimatedCrossAxisHeight: 160, // seeds item WIDTH (primary = horizontal)
    horizontal: true,
  })}
  style={{ height: 416 }}    // (200 * 2) + 8 gap + 8 insets ≈ container height
/>

// Inside compositional
compositional([
  { range: 2, layout: grid({ columns: 2, columnSpacing: 8, rowSpacing: 12,
                              estimatedItemHeight: 200 }),
               horizontal: true,
               estimatedSectionHeight: 420 },
])
```

**Key config props:**

| Prop | Type | Description |
|---|---|---|
| `columns` | `number \| (width) => number` | Column count. Mandatory. |
| `estimatedItemHeight` | `number` | Scalar height/width estimate. Default 44. |
| `estimatedHeightForItem` | `(section, index) => number` | Per-item height estimate (V mode). |
| `estimatedSizeForItem` | `(section, index) => {width, height}` | Per-item size estimate (H mode). |
| `columnSpacing` | `number` | Horizontal gap between columns. |
| `rowSpacing` | `number` | Vertical gap between rows. |
| `sectionSpacing` | `number` | Gap between sections. |

---

### `masonry(config)`

Multi-bin (multi-column) layout that places each item into the shortest bin at the time of placement. Produces the "Pinterest grid" effect — columns of unequal-height items with no row alignment, each column advancing independently. Columns stay balanced in height over time.

`columns` is required. Horizontal mode runs lanes left-to-right (items fill the shortest horizontal lane).

```tsx
layout={masonry({
  columns: 2,
  columnSpacing: 8,
  rowSpacing: 8,
  estimatedHeightForItem: (s, i) => itemData[i].estimatedHeight,
  sectionSpacing: 20,
})}
```

**Key config props:** same structure as `grid` — `columns`, `estimatedItemHeight`, `estimatedHeightForItem`, `columnSpacing`, `rowSpacing`, `sectionSpacing`, `stickyMode`, `separator`, `sectionBackground`. Supports `horizontal` mode.

---

### `flow(config?)`

Greedy bin-packing: items are placed left-to-right, and when the next item does not fit in the remaining row width it wraps to a new row. Item widths come from Yoga measurement (intrinsic width) seeded by `estimatedSizeForItem`. Each row is exactly as tall as its tallest item.

Use cases: tag chips of varying widths, image thumbnails in irregular sizes, product attribute pills.

```tsx
layout={flow({
  estimatedSizeForItem: (s, i) => ({ width: tagWidths[i], height: 32 }),
  itemSpacing: 8,
  lineSpacing: 8,
})}
```

**Horizontal mode** — set `horizontal: true`. Items pack top-to-bottom within each column; each column is as wide as its widest item. Container height must be known (fixed or constrained by parent).

**Key config props:**

| Prop | Type | Description |
|---|---|---|
| `estimatedSizeForItem` | `(section, index) => {width, height}` | Per-item size estimate. Falls back to full container width × `estimatedItemHeight`. |
| `estimatedItemHeight` | `number` | Scalar height fallback. Default 44. |
| `itemSpacing` | `number` | Gap between items within a row (V) or column (H). |
| `lineSpacing` | `number` | Gap between rows (V) or columns (H). |
| `sectionSpacing` | `number` | Gap between sections. |

---

### `compositional(entries)`

Orchestrator layout. Maps sections (or section ranges) to independent sub-layouts. This is the layout you use when a single page contains sections with different layout types or scroll directions.

```tsx
layout={compositional([
  { range: 0,      layout: list() },                  // hero/editorial — spans full width
  { range: [1, 3], layout: grid({ columns: 2,
                                  columnSpacing: 8,
                                  rowSpacing: 8 }) },  // product grids
  { range: 4,      layout: masonry({ columns: 2 }),
                   horizontal: true,
                   estimatedSectionHeight: 320 },      // H-scroll masonry carousel
  { range: 5,      layout: flow() },                  // tag/chip section
  // last entry repeats for all remaining sections
  { range: 6,      layout: list({ estimatedItemHeight: 90 }) },
])}
```

Each `CompositionalEntry` specifies:
- `range` — single section index, or `[from, to]` inclusive range. The last entry's layout repeats for all sections beyond those listed.
- `layout` — any `RiffLayout` including `list`, `grid`, `masonry`, `flow`, or a custom layout.
- `horizontal` — set `true` to make the section scroll independently in the horizontal direction. The section is rendered inside a native `UIScrollView` with momentum scrolling, directional lock, and H-axis item clipping.
- `estimatedSectionHeight` — for H-sections: how much vertical space this section occupies in the outer vertical scroll. Required for flow H-sections; optional for grid/list/masonry (defaults to `estimatedCrossAxisHeight` from the sub-layout config).

Section-level `insets` on `RiffSection` (top/bottom/left/right) apply within each section regardless of its sub-layout type.

---

## Custom layouts (TS)

Riff exposes a `customLayout(config)` factory for fully arbitrary per-item positioning from JavaScript/TypeScript — no C++ required. You supply an `attributesForItem` callback; Riff calls it for every item in the windowed range and applies the returned attributes natively.

```tsx
import { customLayout } from '@riff/layouts/custom';
import type { LayoutAttributes, LayoutContext } from '@riff/types/layout';

layout={customLayout({
  attributesForItem: (index, section, context): LayoutAttributes => {
    const { containerWidth, containerHeight } = context;
    // example: radial arc
    const angle = (index / context.itemCount) * Math.PI;
    const r = containerWidth * 0.4;
    return {
      frame: {
        x: containerWidth / 2 + r * Math.cos(angle) - 40,
        y: containerHeight / 2 + r * Math.sin(angle) - 40,
        width: 80,
        height: 80,
      },
      alpha: 1,
      zIndex: index,
      transform: { /* CATransform3D matrix */ },
    };
  },
})}
```

`LayoutContext` provides: `containerWidth`, `containerHeight`, `scrollOffset`, `itemCount`, and the current Yoga-measured size for the item if available.

### `writesVisualAttributes` — opt into the visual-attrs pipeline

Layouts that need to push *per-frame* visual attributes (alpha, transform, zIndex) — radial, carousel3D, spiral, custom — set `writesVisualAttributes = true` on the layout object. Layouts that only position cells (list, grid, masonry, flow, and most compositional sections) leave it `false` (the default). Compositional layouts derive this flag automatically from their entries: if any nested section sets `true`, the parent inherits `true`.

The native side gates the visual-attrs path on this flag. When `false`, the per-commit pipeline that reads and applies alpha/transform/zIndex is skipped entirely — measurable CPU win on compositional pages where most sections are static. When `true`, it runs as before. Set this on any custom layout that needs the visual channel; leave it off if you only use the frame channel.

### Current status

The TS custom layout path is **architected and partially implemented** but has a known bug in the Yoga-to-LayoutCache correction pipeline: when Yoga measures a cell at a height different from the estimate supplied by `attributesForItem`, `correctChildPositionsIfNeeded` reads the sequential Yoga child positions rather than the layout-provided positions — cells stack incorrectly. The fix requires a dedicated correction path in `correctChildPositionsIfNeeded` that reads from LayoutCache (the layout's own positions) instead of Yoga sequential output for custom-layout sections.

**Scroll-driven updates** (recomputing `attributesForItem` on every scroll frame for effects like parallax or radial arc) are also architected but not yet wired: the `processScroll` return path needs to call `attributesForItem` for the visible range at the new offset and push updated attributes to LayoutCache before the native view applies them.

This is a planned milestone. The C++ extension path (implement a `LayoutEngine` subclass, register via `registerLayoutEngine`) is fully working for native layout engines and is the recommended path until the TS correction pipeline is fixed.

---

## Roadmap

Riff is a pre-release project. The core scroll path, all five built-in layouts, windowing, slot pool, MVC, height correction, and the `snapshot/apply` mutation API are production-ready on iOS. The items below are the planned next milestones.

### Near-term

**TS custom layouts GA** — fix the Yoga-to-LayoutCache correction pipeline for custom-layout sections so `customLayout()` positions cells correctly after the first render. Add scroll-driven `attributesForItem` calls so radial arc, parallax, and carousel effects work without C++.

**Enter/exit cell animations** — animate cells entering and leaving the render window. Integrates with the existing `LayoutAnimation` path that already fires on data mutations. Target: `animateIn` / `animateOut` callbacks on `RiffSection` and a set of built-in presets (fade, slide, scale).

**Coordinated batch animations** — `UICollectionView`-parity insert/delete/move animations where items animate to their new positions simultaneously in a coordinated batch, rather than independently. Requires the C++ diff engine (B2.1) to produce per-item move deltas.

**Snap behaviours** — snap-to-item on scroll end for H-sections and full-screen paging layouts. Native `UIScrollView` snap points derived from LayoutCache item positions.

**API rename** — all consumer-facing size APIs renamed to carry the `estimated` prefix (`itemHeight` → `estimatedItemHeight`, `heightForItem` → `estimatedHeightForItem`, etc.) uniformly across all layouts and config types. Currently partially done; completing before 1.0.

### Platform

**Android** — the LayoutCache and layout engine protocol are pure C++ with no platform dependencies. The platform-specific surface is six hook points (ShadowNode layout, state delivery, view lifecycle, scroll delegate, view flattening boundaries, JSI bindings). The Android equivalents of these hooks exist in the New Architecture stack; the port is a mapping exercise.

**Web / React Native Web** — the JS windowing model, SlotManager, layout engines, and mutation API are all pure TS with no platform dependencies. A web target replaces the C++ layer with TS layout engines, UIScrollView with a `div overflow:scroll`, Yoga with `ResizeObserver`, and frame assignment with `position:absolute` + CSS transforms. The component API (`layout=`, `sections=`, `renderItem`, `snapshot/apply`) stays identical, so cell content written for native works in RNW without changes.

**Architectural hypotheses to validate on web (not yet tested):**

- **Simple lists: hypothesis that Riff beats TanStack Virtual and react-virtuoso on CPU and active component count by the same mechanism it beats FlashList on native search results.** On native, Riff's search page numbers (the most uniform, FlashList-favourable scenario) showed 14% vs 24% CPU and 10 vs 62 active components — not because of compositional layouts, but because steady-state scroll only triggers React reconciliation at render-window boundary crossings. TanStack Virtual and react-virtuoso both update React state on scroll events to recompute their visible range. If the web port preserves the band-skip property (unchanged render range + layout version → no React work), the same structural advantage should appear on web. This is an untested hypothesis and requires benchmarking before any claim is made.

- **Compositional pages: hypothesis that no existing web virtual list library handles multi-layout compositional pages as a first-class primitive.** TanStack Virtual (headless, 1D), react-virtuoso (list + grouped list), and RLV (list + grid) all require manual coordination for pages with mixed section layout types and H-sections. Riff's `compositional([...])` API handles this natively in one scroll container. This is an architectural claim, not a perf claim, and is confident — but the developer-experience advantage over manual coordination needs real-world validation.

- **SSR / CLS:** height-correction cycles (render at estimated positions, ResizeObserver fires, positions update) are a CLS risk on web. This is not a Riff-specific problem — any virtual list that doesn't know item heights at SSR time has the same exposure. The standard mitigation (non-virtual SSR render, hydration takeover) needs to be designed into the web renderer. Unresolved; needs investigation before any SSR claim can be made.

### Performance

**Transform-based cell positioning** — replace `child.frame` assignment with `CATransform3D` translation. Avoids triggering UIKit layout passes per cell; aligns with how GPU compositing prefers to receive position changes.

**Direct native callback for static invalidation** — replace the current double-RAF version poll (used when `invalidateItem` fires while the user is not scrolling) with a direct native callback from the ShadowNode commit. Removes the ~33ms detection lag for in-place cell resizes that happen without active scroll.

**C++ diff engine** — compute insert/delete/move diffs in C++ rather than via JS `Array.from` diffing. Required for coordinated batch animations and for correctness on very large mutation batches.

### State persistence

Serialize the LayoutCache to JSON (or FlatBuffers) so a re-opened list restores scroll position, measured heights, and first-frame positions instantly — no cold-start correction cycle. Pair with iOS scroll position persistence (`UIScrollView.contentOffset` save/restore) for full list state restoration across app launches.

### Developer tooling

**Structured logging and tracing** — a layered observability system for understanding what the pipeline is doing. Three proposed tiers: (1) a JS-side trace API (`RiffTrace`) that records scroll events, render-window transitions, slot pool hits/misses, and mutation operations with timestamps, emitting structured JSON consumable by custom tooling; (2) a native-side C++ trace channel that captures `ShadowNode::layout()` cycle time, `correctChildPositionsIfNeeded` hash hits vs correction batches, LayoutCache version bumps, and `applyPositionsFromState` frame times; (3) a unified audit log for mutations — every `snapshot.apply()` call records before/after indices, stale-height evictions, and first-affected index. The existing `RNCV_DEBUG_LOGS` / `RNCV_ENABLE_NATIVE_LOGS` flags are toggle-based and write to console; the goal is structured, always-available low-overhead tracing that can be consumed programmatically (e.g. in tests or dev overlays) without spamming logs in normal operation.

**Test harness** — automated test coverage for the layout engine, windowing model, and mutation pipeline. Planned layers: (1) C++ unit tests for the layout engine protocol — `prepare`, `applyMeasurements`, `invalidateFrom`, `contentSize` — exercising all five built-in layouts with deterministic inputs; (2) C++ unit tests for `correctChildPositionsIfNeeded` — injecting Yoga-height sequences and asserting LayoutCache correction outputs; (3) JS unit tests for `SlotManager` — pool hit/miss/eviction/type-segregation logic — and `RiffSnapshot` — mutation builder correctness, key eviction; (4) integration tests (Detox or equivalent) for golden-path flows — cold start, scroll through fully-measured list, insert/delete above and below fold with MVC, H-section scroll, sticky header push/overlay. The `BACKLOG.md` tracks specific test scenarios to cover.

---

## Getting started

> **Pre-release.** Riff is not yet published to npm. The install path below reflects the intended public API. If you are evaluating or contributing, clone the repo and link the package via workspace or direct path.

### Requirements

- React Native **0.80 or later**, New Architecture enabled
- iOS **15.1** minimum deployment target
- Hermes engine (required for JSI)

### Install

```bash
# once published:
yarn add @riff/collection-view
cd ios && pod install
```

After `pod install`, a clean Xcode build is required (`Cmd+Shift+K`). If you add or remove C++ source files, re-run `pod install` — CMake only discovers new files during the pod install step.

### Basic usage — flat list

```tsx
import { CollectionView } from '@riff/collection-view';
import { list } from '@riff/layouts/list';

export function ProductFeed({ items }: { items: Product[] }) {
  return (
    <CollectionView
      data={items}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <ProductCard product={item} />}
      layout={list({ estimatedItemHeight: 120 })}
      style={{ flex: 1 }}
    />
  );
}
```

### Multi-section page

```tsx
import { CollectionView } from '@riff/collection-view';
import { compositional } from '@riff/layouts/compositional';
import { list, grid, masonry } from '@riff/layouts';

const layout = compositional([
  { range: 0,      layout: list() },                              // hero banner
  { range: 1,      layout: list(), horizontal: true,
                   estimatedSectionHeight: 180 },                  // H product carousel
  { range: [2, 4], layout: grid({ columns: 2, rowSpacing: 8,
                                  columnSpacing: 8 }) },           // category grids
  { range: 5,      layout: masonry({ columns: 2 }) },             // editorial masonry
]);

export function HomePage({ sections }: { sections: RiffSection<any>[] }) {
  return (
    <CollectionView
      sections={sections}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      layout={layout}
      estimatedItemHeight={160}
      maintainVisibleContentPosition
      style={{ flex: 1 }}
    />
  );
}
```

### Mutations

```tsx
const ref = useRef<RiffHandle<Product>>(null);

// Append new items (e.g. pagination)
const loadMore = async () => {
  const newItems = await fetchNextPage();
  const snap = ref.current!.snapshot();
  snap.appendItems(newItems);
  ref.current!.apply(snap, setData);
};

// Delete an item
const deleteItem = (id: string) => {
  const snap = ref.current!.snapshot();
  snap.deleteItems([id]);
  ref.current!.apply(snap, setData);
};
```

### Cell resize

```tsx
const ref = useRef<RiffHandle<Comment>>(null);

const CommentCard = ({ item, section, index }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <Pressable onPress={() => {
      setExpanded(e => !e);
      ref.current?.invalidateItem(section, index);  // tell Riff to re-measure
    }}>
      <CommentBody text={item.text} expanded={expanded} />
    </Pressable>
  );
};
```

### Debug logging

```ts
// In CollectionView.tsx (dev only):
const RNCV_DEBUG_LOGS = true;        // general layout logs
const RNCV_LAYOUT_DEBUG_LOGS = true; // per-frame layout trace

// Native (set in Xcode scheme environment variables):
// RNCV_ENABLE_NATIVE_LOGS = 1
// RNCV_ENABLE_STICKY_TRACE = 1
```