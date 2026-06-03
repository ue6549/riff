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
    { range: 4,       layout: masonry({ bins: 2 }) },
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

Riff maintains three concentric windows around the current scroll position:

- **Render window** (`renderMultiplier`, default ±0.5× viewport): items are mounted and painted — `Activity=visible`.
- **Measure window** (`measureAhead`, default disabled): items beyond the render window are mounted off-screen as `Activity=hidden`. Fabric measures their Yoga height without painting them or triggering `useEffect`. When they scroll into the render window, they promote in-place — no remount, no blank frame.
- **Mounted window** (`mountedWindowSize`, default 2× viewport): hard cap on total mounted content. Items beyond this cap are unmounted.

Beyond the mounted window, the **slot pool** (`recyclePoolSize`, configurable per widget type, default auto-tracks window size) keeps recently-evicted slots alive as `Activity=hidden` Fibers. When an item re-enters the window, if its slot is still in the pool it returns as a prop update — zero cold-mount cost. If the pool slot was evicted, it remounts as a fresh Fiber.

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

When a cell changes height via a local `setState` (expand/collapse, image load resolving), call `ref.current.invalidateItem(section, index)` alongside the state update. Riff re-renders the window so Fabric re-measures the changed cell, then runs `invalidateFrom(i)` in C++ — only items from index i onward reflow. FlashList requires an `extraData` change which re-renders the full list.

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

**Device:** iPhone 15 Pro, iOS 17, ProMotion display (up to 120Hz).

**Widgets:** Fully coded React Native components simulating real e-commerce UI — product cards, banners, carousels, editorial strips. No mock views or simplified placeholders. Each product card renders approximately 40 React nodes (image, title, rating, price, badge, call-to-action). Image loading was excluded to isolate layout and scroll performance from network variability.

**Scroll scenarios per page:** slow scroll down and up (20px/frame), fast scroll down and up (100px/frame), fling gesture down and up. Numbers below are aggregated across all scroll scenarios.

**Riff configuration:** default windowing settings — `renderMultiplier=0.5`, `mountedWindowSize=2.0`, `measureAhead=0` (measure window disabled; measure = render in this bench).

**Page types:**

| Page | Profile |
|---|---|
| **Homepage** | Widest widget-type variety — hero banners, product cards, category chips across different section types (H carousels, editorial strips, recommendation lists). Closest to a real app home feed. |
| **Storefront** | Widest section-layout variety (horizontal carousel, masonry, flow, vertical grid, horizontal grid, vertical list) with a single widget type — every individual item is a product card. |
| **Search results** | Predominantly product cards — the most uniform content profile. A few horizontal widget sections interspersed. Maximum slot-recycling opportunity for FlashList's card pool. |

**FlashList implementation in this bench:** outer vertical FlashList with `getItemType` for section-aware recycling; horizontal sections backed by nested horizontal FlashLists; vertical grids and masonry built with manually mapped View rows (FlashList's `numColumns` does not support variable column widths).

> FlashList version: _[fill in]_. Both engines tested on RN 0.83.4, New Architecture only.

---

### Results

#### Homepage

| Metric | Riff | FlashList | Winner |
|---|---|---|---|
| Avg FPS | 70 | 71 | Tied |
| Min FPS | 60 | 59 | Tied |
| p5 FPS | 60 | 59 | Tied |
| JS Idle | 100% | 100% | Tied |
| **Avg CPU** | **11%** | **25%** | **Riff 2.3×** |
| p75 CPU | 16% | 34% | Riff 2.1× |
| p90 CPU | 17% | 36% | Riff 2.1× |
| **Avg Memory** | **63 MB** | **128 MB** | **Riff 2.0×** |
| p75 Memory | 65 MB | 136 MB | Riff 2.1× |
| p90 Memory | 79 MB | 137 MB | Riff 1.7× |
| Peak Memory | 79 MB | 137 MB | Riff 1.7× |
| **Active components (avg)** | **14** | **86** | **Riff 6.1×** |
| Active components (p75) | 20 | 90 | Riff 4.5× |
| Active components (peak) | 24 | 90 | Riff 3.8× |
| Total mounts (session) | 1,006 | 629 | FlashList 1.6× |

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

The React tree has three concentric size bounds:

| Window | Prop | Default | Behavior |
|---|---|---|---|
| **Render** | `renderMultiplier` | 0.5× viewport | Items mounted as `Activity=visible`. Painted, interactive. |
| **Measure** | `measureAhead` | 0 (disabled) | Items mounted as `Activity=hidden` ahead of the render window. Yoga measures them before they enter the render window — no blank frame on first scroll-in. |
| **Mounted cap** | `mountedWindowSize` | 2× viewport | Hard cap on total mounted content. Items beyond this threshold are evicted to the pool. |

Beyond the mounted cap, the **slot pool** (`recyclePoolSize`, configurable per item type, defaults to auto-track window size) keeps recently-evicted Fibers alive. When an item re-enters the window:

- **Pool hit:** same React Fiber → prop update, zero cold-mount cost.
- **Pool miss:** fresh mount.

The pool is **LIFO per item type** — segregated by the `getItemType` return value. Separate widget types (product cards, banners, chips) each have their own pool. Pool excess above `maxPoolSize` is unmounted immediately.

**First paint:** `initialNumToRender` (default 10) controls how many items mount before the viewport size is known. Set it to the fewest items needed to fill the visible screen — typically 3–5 — for the fastest cold start. Once the container reports its size, the windowed range takes over.

**Per-section windowing overrides:** each section can carry its own `renderMultiplier`, `measureAhead`, and `mountedWindowSize`. Horizontal sections use `hRenderMultiplier` as a fallback before `renderMultiplier`. Precedence: `section.renderMultiplier ?? hRenderMultiplier ?? renderMultiplier`.

**Visibility callback:** `onViewableRangeChange` fires when the set of items in the visible range changes. It receives `{ visible: { first, last }, render: { first, last } }` — the `visible` range reflects what the user can actually see; the `render` range reflects the broader painted buffer. Use this for analytics impression tracking or lazy-loading triggers rather than parsing scroll offsets manually.

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

After `applyPositionsFromState:` has set a cell's frame, Fabric applies its own computed layout metrics to the cell. `RNMeasuredCellView` overrides `updateLayoutMetrics:`. When `_shadowNodePositioned = YES` (set by `applyPositionsFromState:`), it replaces Fabric's computed origin with `self.frame.origin` while passing Yoga's size through unchanged. Yoga wins on **size** (actual content dimensions); LayoutCache wins on **position** (layout engine placement). These two authorities do not conflict — they govern different parts of the layout metrics.

**A note on Fabric view flattening**

Fabric has a second optimisation that intersects with absolute positioning: **view flattening**. Layout-only views — `<View>` components with no visual properties, no event handlers, no accessibility role — are candidates to be removed from the native UIView hierarchy entirely. Their layout is computed in the ShadowNode tree but no UIView is created; their children are re-parented directly under the nearest non-flattened ancestor. This reduces UIView count substantially for deeply-nested React trees.

Riff's boundary views (`RNCollectionViewContainerView`, `RNMeasuredCellView`, `RNScrollCoordinatedView`, `RNCollectionSubContainer`) are all registered native components — they always produce UIViews and are never candidates for flattening. This matters because `applyPositionsFromState:` sets `child.frame` directly on these views, and `updateLayoutMetrics:` intercepts Fabric's layout delivery to them; both require an actual UIView to exist. The boundary is intentional and explicit: flattening is disabled at Riff's container and cell-wrapper level, and normal Fabric flattening applies freely inside user-provided cell content (inside `RNMeasuredCellView`) and in the outer React tree above the container. User-provided cells with deeply-nested layout-only views still benefit from Fabric's flattening optimisation for all the React content they contain.

**④ UIScrollViewDelegate — UI thread, before JS**

`RNCollectionViewContainerView` is the UIScrollView's delegate. `scrollViewDidScroll:` fires on the UI thread — before the scroll event is delivered to JavaScript. Riff uses this to call C++ `processScroll` via JSI synchronously, computing the render range and cache version number immediately. If neither has changed, no further work happens (band-skip). If the render window boundary has moved, a synthetic event is dispatched to JS. The full delegate chain — `willBeginDragging`, `didEndDragging:willDecelerate:`, `willBeginDecelerating`, `didEndDecelerating`, `didEndScrollingAnimation` — gives Riff precise knowledge of scroll phase for MVC snapshotting and for knowing when to flush deferred corrections.

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
| **Windowing model** (JS) | React/RN | Concept universal; `Activity` API is RN 0.80+ |
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

**Horizontal mode** — set `horizontal: true` inside the config (or via `compositional` `horizontal` flag). Primary axis becomes X; `estimatedItemHeight` seeds item width; `estimatedCrossAxisHeight` (default 200) seeds the list's height. The list's cross-axis height snaps to the tallest measured item.

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

**Horizontal mode** — set `horizontal: true`. Column layout becomes column-major (items tile top-to-bottom within a column, then advance left-to-right — mirrors `UICollectionViewFlowLayout` horizontal default). `columns` controls the number of rows (cross-axis count). `estimatedCrossAxisHeight` seeds item width.

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

**Web / React Native Web** — the JS windowing model and SlotManager work without native code. A web target would replace the C++ layout path with a TS equivalent and use `IntersectionObserver` + CSS transforms for native-free positioning.

### Performance

**Transform-based cell positioning** — replace `child.frame` assignment with `CATransform3D` translation. Avoids triggering UIKit layout passes per cell; aligns with how GPU compositing prefers to receive position changes.

**Direct native callback for static invalidation** — replace the current double-RAF version poll (used when `invalidateItem` fires while the user is not scrolling) with a direct native callback from the ShadowNode commit. Removes the ~33ms detection lag for in-place cell resizes that happen without active scroll.

**C++ diff engine** — compute insert/delete/move diffs in C++ rather than via JS `Array.from` diffing. Required for coordinated batch animations and for correctness on very large mutation batches.

### State persistence

Serialize the LayoutCache to JSON (or FlatBuffers) so a re-opened list restores scroll position, measured heights, and first-frame positions instantly — no cold-start correction cycle. Pair with iOS scroll position persistence (`UIScrollView.contentOffset` save/restore) for full list state restoration across app launches.

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