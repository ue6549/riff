# Phase 5: JS Integration Plan

## Context

The ShadowNode (Phases 1-4) handles child positioning, content sizing, and scroll offset correction — all within a single Fabric commit cycle. Phase 5 wires everything together: the native `RNCollectionViewContainer` replaces the ScrollView, the ShadowNode reads full LayoutAttributes from the C++ LayoutCache, applies them to cell wrappers via `child->setLayoutMetrics()`, and dead JS measurement code is removed.

## Key Design Decisions

### D1: ShadowNode ↔ LayoutCache bridge via static registry
ShadowNodes are cloned by Fabric (value semantics) — they can't hold `shared_ptr`. Solution: `CollectionViewModule` registers its `shared_ptr<LayoutCache>` in a static map keyed by integer ID. JS passes `layoutCacheId` as a prop. ShadowNode looks up the cache during `layout()`.

### D2: Three-tier height resolution
Heights come from three sources, each overriding the last:
1. **`estimatedHeight`** (single number) — initialize all items. For grid/masonry: `estimatedSize`.
2. **`heightForItem(index)`** / **`sizeForItem(index)`** — per-item estimates from consumer. For complex layouts: `layoutAttributesForItem(index)`. Called for first ~10-20 items synchronously (first screenful+buffer), then lazily/batched for the rest.
3. **Yoga actuals** (measured mounted children) — always wins. ShadowNode writes these back to cache.

### D3: Progressive layout cache seeding
Seeding happens in stages, each enriching the LayoutCache:
1. **Initialize**: seed all items with `estimatedHeight` (tier 3) — instant, enables first render
2. **First screenful**: call `heightForItem` for ~10-20 items (tier 2) — synchronous, before first paint
3. **ShadowNode measures**: Yoga computes actual heights for mounted children (tier 1) — writes back to cache
4. **Background enrichment**: lazily call `heightForItem` for remaining items, batch updates to cache
5. **Notify ShadowNode**: `layoutCacheVersion` prop bump triggers Fabric re-commit → ShadowNode recomputes with better data
- Can batch notifications to avoid excessive re-commits
- No 10K-element height arrays as props — cache is the shared data structure

### D4: Range computation stays on JS thread via JSI fast path
Range computation is already C++ (`WindowController`), called from JS via JSI — synchronous result on JS thread. This is the fast path: JS gets the range in the same frame as the scroll event, mounts children immediately, and React batches the commit.

Moving range computation to ShadowNode would add a round-trip (ShadowNode computes → emits event → JS mounts → next commit) for zero benefit. The ShadowNode's job is positioning + content size, not range decisions.

### D5: Three-layer scroll simplification
- `scrollViewProps`: Key props forwarded as direct props on `RNCollectionViewContainer` (scrollEnabled, bounces, etc.)
- `ScrollViewComponent` / `renderScrollView`: Not supported in ShadowNode mode (POC limitation — native view owns the scroll). Log warning if provided.

### D6: Eventual consistency for thread safety
LayoutCache is already mutex-guarded. If ShadowNode reads mid-update, it gets partially correct data — the next `layoutCacheVersion` bump triggers another layout pass. Worst case: one frame with stale estimates (strictly better than current 2-frame JS roundtrip).

### D7: Layout owns wrapper, cell is free (NEW)
The layout determines what constraints go on the cell wrapper. The consumer's cell component is a normal React component that fills its wrapper — no special styles required.

**Wrapper receives from layout:** frame (x, y, width, height), zIndex, alpha, transform.
**Cell is unconstrained:** consumer returns a normal component, it fills the wrapper via flex.

**Per layout type:**
- **List:** wrapper gets `{ x: insetLeft, y: accumulated, width: containerWidth - insets }`. Height = Yoga-measured or layout-estimated.
- **Grid:** wrapper gets `{ x: columnX, y: rowY, width: columnWidth }`. Same height story.
- **Masonry:** wrapper gets `{ x: columnX, y: shortestColumnY, width: columnWidth }`. Height = Yoga-measured.
- **Flow:** wrapper gets `{ x: accumulatedX, y: rowY, width: intrinsic, height: intrinsic }`. Layout reads Yoga measurements to position next item.

### D8: State-based position application (revised from adopt() attempt)
The ideal approach would be `child->setLayoutMetrics()` (adopt pattern, like ScrollViewShadowNode). However, this **doesn't work** for our use case: on scroll-triggered state updates, Fabric shares (doesn't clone) unchanged children — they're sealed. `setLayoutMetrics()` crashes with "Attempt to mutate a sealed object."

ScrollViewShadowNode gets away with it because its RTL correction only runs on initial mount. We need to reposition on every layout pass including scroll-triggered ones.

**Actual approach:** ShadowNode stores `[x,y,w,h,...]` in state. Native view reads state and applies `child.frame` in `applyPositionsFromState:`. This works reliably because state updates don't require child mutation.

### D9: LayoutAttributes comprehensive + extras map (NEW)
The C++ `LayoutAttributes` struct covers the full UICollectionView attribute set (frame, transform3D, alpha, zIndex, isHidden, cornerRadius). A `std::unordered_map<std::string, double> extras` field provides an escape hatch for layout-specific data without requiring native releases.

---

## Completion Status

- [x] **5f**: Thread Safety Audit
- [x] **5a**: Wire ShadowNode to LayoutCache (static registry, three-tier heights, write-back)
- [x] **5b**: Replace ScrollView with RNCollectionViewContainer
- [x] **5c**: Connect Render Range + Simplify JS Scroll Handler
- [x] **5d**: Connect Measure Range
- [x] **5e**: Remove Dead Code (JS fallback functions, unused imports, stale comments)
- [x] **5h**: Comprehensive LayoutAttributes + extras map (transform3D, isHidden, extras)
- [x] **5i**: ~~adopt() attempt~~ → reverted to state-based (sealed children crash). Now applies full frame [x,y,w,h] via state, reads width/x from LayoutCache.
- [ ] **5g**: Extend to All Layout Types

---

## Implementation Steps (remaining)

### 5h: Comprehensive LayoutAttributes + extras map
**Files:** `cpp/LayoutCache.h`, `cpp/LayoutCache.cpp`

**5h.1: Extend LayoutAttributes struct:**
```cpp
struct LayoutAttributes {
  // Identity
  std::string key;
  int         section       = 0;
  int         index         = -1;

  // Geometry (layout-computed)
  Rect        frame;                              // x, y, width, height
  int         zIndex        = 0;
  double      alpha         = 1.0;
  bool        isHidden      = false;

  // Transform (3D — covers rotation, scale, translation)
  // Stored as a flat 4x4 matrix (column-major, like CATransform3D).
  // Identity by default. Only non-identity transforms need serialization.
  std::array<double, 16> transform3D = {
    1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1
  };

  // Supplementary view metadata
  bool        isSupplementary = false;
  std::string supplementaryKind;

  // Sizing state (three-tier tracking)
  SizingState sizingState   = SizingState::Placeholder;
  bool        isDirty       = false;

  // Window tier
  WindowTier  tier          = WindowTier::Outside;

  // Sticky behavior
  bool        isSticky      = false;

  // Animation state
  bool        isAnimating   = false;

  // Escape hatch for layout-specific data (no native release needed)
  std::unordered_map<std::string, double> extras;
};
```

**5h.2: Update JSI bridge (`attrsFromJSI`/`attrsToJSI`):**
- Add `transform3D` serialization (as 16-element JS array, skip if identity)
- Add `isHidden` field
- Add `extras` serialization (JS object ↔ map)
- Backward-compatible: missing fields get defaults

**5h.3: Update SpatialIndex if needed:**
- SpatialIndex only uses `frame` — no changes needed for new fields

**Verification:** Run Phase 5a test screen — cache bridge still works with new fields at defaults.

### 5i: ShadowNode adopt() — apply layout via child->setLayoutMetrics()
**Files:**
- `cpp/CollectionViewContainerShadowNode.cpp` — rewrite `correctChildPositionsIfNeeded()` to use `child->setLayoutMetrics()`
- `cpp/CollectionViewContainerShadowNode.h` — remove `correctedPositions_` scratch vector
- `cpp/CollectionViewContainerState.h` — remove `positions` vector from state
- `ios/RNCollectionViewContainerView.mm` — remove `applyPositionsFromState:`, simplify `layoutSubviews`

**5i.1: Rewrite `correctChildPositionsIfNeeded()`:**
```cpp
void CollectionViewContainerShadowNode::correctChildPositionsIfNeeded() {
  const auto& props = *std::static_pointer_cast<const RNCollectionViewContainerProps>(getProps());
  auto children = getLayoutableChildNodes(); // returns mutable pointers

  // ... read props (containerWidth, insets, rowSpacing, etc.)
  auto cache = CollectionViewModule::getLayoutCacheForId(props.layoutCacheId);

  Float y = insetTop;
  for (size_t i = 0; i < children.size(); ++i) {
    auto* child = children[i];
    auto metrics = child->getLayoutMetrics();
    const auto yogaHeight = metrics.frame.size.height;
    const auto yogaWidth = metrics.frame.size.width;

    // Three-tier height resolution (unchanged logic)
    Float effectiveHeight = estimatedItemHeight;
    Float effectiveWidth = itemWidth;
    Float effectiveX = insetLeft;

    if (cache) {
      const auto dataIndex = renderRangeStart + static_cast<int32_t>(i);
      auto cached = cache->getAttributes("item-0-" + std::to_string(dataIndex));
      if (cached) {
        if (cached->frame.height > 0) effectiveHeight = cached->frame.height;
        if (cached->frame.width > 0) effectiveWidth = cached->frame.width;
        effectiveX = cached->frame.x;  // layout may set non-insetLeft x (grid columns)
      }
    }

    // Tier 1: Yoga wins if valid and differs
    if (yogaHeight > 0 && std::abs(yogaHeight - estimatedItemHeight) > 0.5f) {
      effectiveHeight = yogaHeight;
    }

    // Apply layout-computed frame to child's LayoutMetrics
    metrics.frame.origin = {effectiveX, y};
    metrics.frame.size = {effectiveWidth, effectiveHeight};
    child->setLayoutMetrics(metrics);

    y += effectiveHeight + rowSpacing;
  }

  correctedContentHeight_ = y - rowSpacing + insetBottom;

  // Write-back to cache (unchanged)
  // ...
}
```

**5i.2: Remove positions from state:**
- Remove `std::vector<Float> positions` from `CollectionViewContainerState`
- `updateStateIfNeeded()` no longer compares/stores positions — only contentSize, contentOffset, correction, revision
- Offset correction: use `correctedPositions_` as before for the correction computation within `layout()`, but don't persist to state. OR store old child metrics locally for correction computation.

**5i.3: Simplify native view:**
- Remove `applyPositionsFromState:` entirely
- `layoutSubviews` only handles: scroll view frame, content size from state, offset correction
- Children's frames are set by Fabric automatically from the modified LayoutMetrics

**5i.4: Handle offset correction without positions in state:**
- The correction algorithm needs old vs new Y positions to compute delta
- Option A: Store only the correction delta in state (computed during `layout()`). The ShadowNode has access to old child metrics during `layout()` via `getStateData().positions` — but we're removing that.
- Option B: Compute correction during layout by comparing old `getLayoutMetrics()` of children with new. But children are the NEW children after reconciliation — old ones may be gone.
- **Best option**: Keep a small `std::vector<Float>` of old Y positions as a member variable on ShadowNode (NOT in state). Populated at end of each layout pass, compared at start of next. This is scratch data, not shared state.

**Verification:**
- Phase 1: items positioned with correct spacing and insets
- Phase 3: items have correct width (not extending past screen)
- Phase 4: scroll offset correction still works
- Phase 5a: three-tier cache bridge still works
- Main CollectionView: cells render at correct positions

### 5j: Remove JS cell wrapper positioning
**Files:** `example/components/CollectionView.tsx`

**5j.1: Simplify cell wrapper styles in `renderCell()`:**
The wrapper `<View>` currently sets explicit `position: absolute`, `left`, `top`, `width`, `height`. Since the ShadowNode now applies the full frame via `setLayoutMetrics()`, JS no longer needs to compute or set any positioning on the wrapper.

Before:
```tsx
const containerStyle = [
  {
    position: 'absolute' as const,
    left,
    right: useLayoutProtocol ? undefined : sectionInsetRight,
    top,
    ...(viewportWidth > 0 ? { width: cellWidth, right: undefined } : {}),
  },
  cellHeight != null && !measureOnly && { height: cellHeight },
];
```

After:
```tsx
const containerStyle = { flex: 1 };
// or simply no explicit style — the ShadowNode sets the frame
```

**5j.2: Remove position-related computations from `renderCell()`:**
- Remove `estimatedTop`, `cellLeft`, `cellWidth`, `cellHeight` calculations
- Remove `computedPositions` useMemo (positions come from ShadowNode, not JS)
- Remove `itemPositionsRef` (no longer needed for JS-side position tracking)

**5j.3: Simplify scroll handler:**
- JS no longer needs `computedPositions` or `itemPositionsRef` for range computation
- Variable-height range computation uses `nativeLayoutCache.getItemHeights()` → positions computed inline (or move to C++ `computeVariableRanges` to accept cache directly)

**5j.4: Measure-range cells:**
- Cells in measure range (Activity=hidden, parked at top:-9999) still need to be positioned off-screen
- ShadowNode distinguishes render-range vs measure-range children: render-range gets layout positions, measure-range gets off-screen position
- OR: measure-range cells keep their Yoga-computed position (which is relative to parent) and the ShadowNode only overrides render-range children

**Verification:**
- Consumer cells render correctly with no positioning styles
- Variable-height cells measure and position correctly
- Measure-range cells don't flash on screen
- Scroll handler still computes correct ranges

### 5g: Extend to All Layout Types (after list verified with adopt approach)
**Files:**
- `cpp/CollectionViewContainerShadowNode.cpp` — layout-type-aware attribute application
- `example/components/CollectionView.tsx` — seeding flow for each layout type

The ShadowNode's `correctChildPositionsIfNeeded()` reads full `LayoutAttributes` from cache (not just height). Each layout type writes different attributes:

**5g.1: Grid layout:**
- LayoutCache entries have `frame.x` = column position, `frame.width` = column width
- ShadowNode reads `frame.x`, `frame.width` from cache → applies to child LayoutMetrics
- No special ShadowNode logic — it just trusts the cache's frame

**5g.2: Masonry layout:**
- Items aren't Y-sorted by index. LayoutCache entries have full frame from `MasonryLayout::compute()`.
- ShadowNode reads complete frame from cache
- Height resolution: Yoga > cache > estimate (same three-tier)
- Range computation: `LayoutCache::getAttributesInRect()` spatial query

**5g.3: Flow layout:**
- Variable-width + variable-height. Layout needs Yoga measurements first.
- Two-pass: (1) Yoga measures cells, ShadowNode writes sizes to cache. (2) FlowLayout reads sizes, computes positions, writes back. (3) ShadowNode re-reads positions, applies to children.
- May require a second layout pass or deferred positioning on next commit.

**5g.4: Custom layouts (layout protocol):**
- Consumer's JS layout writes full `LayoutAttributes` to LayoutCache via JSI
- ShadowNode reads them during `layout()` — same as built-in layouts
- `extras` map available for layout-specific data

**5g.5: Applying non-frame attributes:**
- `zIndex`: set on child LayoutMetrics or handled by native view (UIView.layer.zPosition)
- `alpha`: applied by native view (UIView.alpha) from a new state field or LayoutCache read
- `transform3D`: applied by native view (CATransform3D) from LayoutCache
- `isHidden`: DisplayType::None on child LayoutMetrics

**5g.6: Verification per layout type:**
- Grid: uniform + variable-height grid, scroll + insert/remove
- Masonry: 2-3 columns, variable heights, scroll + insert/remove
- Flow: mixed-width items, wrapping, scroll
- Each verified against existing test screens before moving on

---

## Verification Plan

### Per-step verification:
- **5h**: Run Phase 5a test — cache bridge works with new fields at defaults
- **5i**: Run all Phase 1-5a test screens — items positioned correctly by Fabric, no `applyPositionsFromState`, scroll correction works
- **5j**: Run main CollectionView — cells render correctly without explicit positioning styles
- **5g**: Per-layout-type verification (grid, masonry, flow)

### End-to-end:
- Fixed-height list: 1000 items, scroll smoothly, no jumps
- Variable-height list: items measure correctly on first mount, no 2-frame jump
- Scroll correction: insert/remove items above viewport, content stays stable
- Performance: HUD shows no regression vs current implementation
- Consumer cells: no special positioning styles required — just normal React components

## Critical Files
- `packages/rn-collection-view/cpp/CollectionViewContainerShadowNode.h/.cpp`
- `packages/rn-collection-view/cpp/CollectionViewModule.h/.cpp`
- `packages/rn-collection-view/cpp/LayoutCache.h/.cpp`
- `packages/rn-collection-view/cpp/CollectionViewContainerState.h`
- `packages/rn-collection-view/src/specs/RNCollectionViewContainerNativeComponent.ts`
- `packages/rn-collection-view/example/components/CollectionView.tsx`
- `packages/rn-collection-view/ios/RNCollectionViewContainerView.mm`

## Existing utilities to reuse
- `LayoutCache::getAttributes(key)` / `setAttributes(attrs)` — for ShadowNode read/write
- `LayoutCache::getAttributesInRect()` — for complex layout range computation
- `ListLayout::compute()` — unchanged, still seeds the cache from JS
- `WindowController::computeRanges()` / `computeVariableRanges()` / `applyBudget()` / `computeMeasureRange()` — still called from JS via JSI
- `child->setLayoutMetrics()` — Fabric API for modifying child layout (used by ScrollViewShadowNode)
- `getLayoutableChildNodes()` — returns mutable child pointers via const_cast (standard Fabric pattern)
