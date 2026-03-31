# Context Exchange: Sticky Footer + MVC Size-Change Fixes
**Date:** 31-03-26 22:46

---

## Summary of Work Done This Session

Three categories of bugs fixed and committed to `main`:

1. **MVC scroll correction key mismatch** — delete caused ~16px scroll jump even without prior inserts.
2. **Sticky footer position corrupted after insert/delete** — footer jumped to middle of screen.
3. **MVC correction missing for size-change mutations** — visible rows shifted when resizing an above-viewport cell.

---

## Fix 1: MVC Key Mismatch (`measuredHeightForItem`)

### Symptom
With MVC on, deleting an item caused a ~16px visible jump even without any prior inserts. The jump was the size of the height estimation error (estimated 44px vs actual ~60px for measured cells).

### Root Cause
`measuredHeightForItem()` in `CollectionView.tsx` was reading from the LayoutCache using **positional keys** (`item-0-0`, `item-0-1`…). But when a `keyExtractor` is provided, the ShadowNode's `applyMeasurements()` writes Yoga-measured heights under **identity keys** (`s0:cell-animation-1`). Every lookup missed → fell back to estimate → `computeSections()` produced positions based on estimates → `applyMeasurements()` saw a "delta" (estimate vs Yoga) on every commit → false correction.

### Fix
`packages/rn-collection-view/example/components/CollectionView.tsx` (~line 980):

```typescript
measuredHeightForItemRef.current = (index, section) => {
  const sec = propSections?.[section];
  const item = sec?.data[index];
  const key = (sec && propKeyExtractor && item !== undefined)
    ? `${sec.key}:${propKeyExtractor(item, index)}`  // identity key
    : `item-${section}-${index}`;                     // positional fallback
  const attr = nativeLayoutCache.getAttributes(key);
  return attr ? attr.frame.height : undefined;
};
```

**Committed:** `fix(mvc): preserve measured heights across prepare() and silence logs` (branch `mvc-js-driven-correction`)

---

## Fix 2: Sticky Footer Corrupted After Insert/Delete

### Symptom
- MVC on, scroll=0: delete → footer jumps to middle of screen (fixes on scroll).
- MVC off: insert → footer goes off-screen; delete → footer jumps up. Always.
- Headers NOT affected.

### Root Cause A: `applyPositionsFromState` using wrong transform detection
`applyPositionsFromState()` in `RNCollectionViewContainerView.mm` checked `child.transform` (2D `CGAffineTransform`) to decide how to read/write child positions. But sticky views use `child.layer.transform` (3D `CATransform3D`). The check was **always NO** for sticky views.

When `hasActiveTransform = NO`:
- **Read:** `frame.origin.y` returns VISUAL position (natural + translateY), not natural position.
- **Write:** `child.frame = CGRectMake(...)` sets center accounting for the CURRENT layer transform — corrupting center.y.

**Fix:** `ios/RNCollectionViewContainerView.mm` (~line 360):
```objc
const BOOL hasActiveTransform = !CGAffineTransformIsIdentity(child.transform) ||
    !CATransform3DIsIdentity(child.layer.transform);
```
When `hasActiveTransform = YES`, the existing path correctly uses `center.y - bounds.height/2` for reads and sets `bounds` + `center` for writes.

### Root Cause B: `updateLayoutMetrics:` leaving `layer.transform` stale
After `applyPositionsFromState` correctly places the footer, Fabric calls `updateLayoutMetrics:` with the Yoga-computed natural position. The base class sets `center/bounds` from Yoga but **does NOT touch `layer.transform`**. The footer's visual position becomes `yogaNaturalY + staleTranslateY` = middle of screen.

`updateLayoutMetrics:` directly sets center/bounds via the Fabric mounting path, bypassing `layoutSubviews`, so `_applyTransform` (which is called from `layoutSubviews`) never fires to correct it.

**Fix:** Override `updateLayoutMetrics:oldLayoutMetrics:` in `RNScrollCoordinatedViewView.mm` and call `_applyTransform` after `[super ...]`:

```objc
- (void)updateLayoutMetrics:(const LayoutMetrics &)layoutMetrics
           oldLayoutMetrics:(const LayoutMetrics &)oldLayoutMetrics
{
  [super updateLayoutMetrics:layoutMetrics oldLayoutMetrics:oldLayoutMetrics];
  // Fabric sets natural position but leaves layer.transform stale.
  // Re-apply so visual position is correct immediately.
  [self _applyTransform];
}
```

### Root Cause C: Footer push boundary and direction wrong
The footer's `boundaryY` prop was set to the **next** section's start (immediately after the footer → maxTranslate ≈ 0 or negative). Should use the **current** section's start (header Y or first item Y).

Additionally, the push clamp used `MIN(desiredTop - naturalY, maxTranslate)` which picks the MORE negative value, exaggerating upward pull. Should be `MAX(...)` to constrain (pick less negative).

**Fix in:** `example/components/CollectionView.tsx` — stickyConfigMap footer boundary:
```typescript
if (stickyKind === 'footer') {
  const sectionHeader = nativeMod.layoutCache.getAttributes(`item-${fiDesc.sectionIndex}-header`);
  boundaryY = sectionHeader ? sectionHeader.frame.y : (effectiveLayout.attributesForItem(0, fiDesc.sectionIndex)?.frame.y ?? 999999);
} else {
  // header: use next section start (existing logic)
}
```

**Fix in:** `ios/RNScrollCoordinatedViewView.mm` — `_applyTransform` footer branch:
```objc
CGFloat minTranslate = _boundaryY - naturalY;
translateY = MIN(0.0, MAX(desiredTop - naturalY, minTranslate));
```

**Debugging aid that revealed the issue:** Added `updateLayoutMetrics:` logging. Key log showed:
```
updateLayoutMetrics AFTER super postNaturalY:1897.3 layerTransY:-1680.7
```
Visual = 1897.3 + (-1680.7) = 216.6 → middle of screen. ✓ confirmed.

**Committed:** `fix(sticky): correct footer position after insert/delete mutations` (branch `mvc-js-driven-correction`, merged to `cur-section-footer-test` and `main`)

---

## Fix 3: MVC Correction Missing for Size-Change Mutations

### Symptom
With MVC on, resizing a cell (s0,0) while scrolled past it caused visible rows to shift. The footer moved correctly (positions cascaded), but `scrollY` never changed — no MVC correction applied. Stops happening once s0,0 grows large enough to be visible in viewport.

**Evidence from logs:** scrollY stayed at 538.7 even as footer naturalY jumped from 2179→2241 (+62).

### Root Cause
`snapshotAnchor()` is only called inside the `useMemo` that depends on `layoutContext`:

```typescript
useMemo(() => {
    if (maintainVisibleContentPosition) { nativeLayoutCache.snapshotAnchor(); }
    effectiveLayout.prepare(layoutContext);
}, [effectiveLayout, layoutContext]);
```

`layoutContext` depends on viewport dimensions, section structure, item count. For a **pure size change** (content changes height, but item count / section structure unchanged), `layoutContext` doesn't change → `useMemo` doesn't fire → `snapshotAnchor()` not called.

The ShadowNode detects the height change via Yoga, calls `applyMeasurements()` to cascade positions, commits new state. In `updateState:`, `computeCorrection()` runs — but `_hasAnchor = false` (no snapshot) → returns 0 → no correction.

### Fix

**Step 1:** Add `snapshotAnchorIfNeeded()` to `LayoutCache` — snapshots only if no anchor set yet, and only if MVC is enabled:

```cpp
// LayoutCache.h
void setMVCEnabled(bool enabled);
void snapshotAnchorIfNeeded();

// LayoutCache.cpp
void LayoutCache::setMVCEnabled(bool enabled) {
    std::lock_guard<std::mutex> lock(_mutex);
    _mvcEnabled = enabled;
}

void LayoutCache::snapshotAnchorIfNeeded() {
    std::lock_guard<std::mutex> lock(_mutex);
    if (_hasAnchor) return;    // JS already snapshotted before prepare()
    if (!_mvcEnabled) return;  // MVC disabled
    _snapshotAnchorLocked();   // same logic as snapshotAnchor()
}
```

Private helper `_snapshotAnchorLocked()` holds the anchor-finding logic (no mutex acquisition); called by both `snapshotAnchor()` and `snapshotAnchorIfNeeded()`.

**Step 2:** Call from ShadowNode before `applyMeasurements()`:

```cpp
// CollectionViewContainerShadowNode.cpp
if (!deltas.empty() && engine && cache) {
    cache->snapshotAnchorIfNeeded();  // ← NEW
    engine->applyMeasurements(deltas, *cache);
    ...
}
```

**Step 3:** Expose `setMVCEnabled` as JSI binding and call from JS on prop change:

```typescript
// CollectionView.tsx
useEffect(() => {
    nativeLayoutCache.setMVCEnabled(maintainVisibleContentPosition);
}, [maintainVisibleContentPosition, nativeLayoutCache]);
```

### Correctness

| Scenario | snapshotAnchor() caller | Behavior |
|---|---|---|
| `prepare()` ran (layoutContext changed) | JS (before prepare) | ShadowNode skips (anchor already set) |
| Size change only (layoutContext unchanged) | ShadowNode (before applyMeasurements) | Captures pre-cascade positions |
| MVC off | Neither | `snapshotAnchorIfNeeded()` is no-op |

**Branch:** `cur-size-change-mvc` (not yet committed at time of writing)

---

## Key Architecture Notes

### Key system (identity vs positional)
- `computeSections()` (C++) stores items under identity keys (`s0:cell-animation-1`) when `p.keys[]` is provided via JS `layoutContext.sections[].itemKeys`.
- The ShadowNode's `correctChildPositionsIfNeeded()` reads/writes using each child's `cacheKey` prop — also the identity key.
- Headers/footers always use positional keys: `item-{sectionIndex}-header`, `item-{sectionIndex}-footer`.
- `measuredHeightForItem()` (JS) must read identity keys, not positional keys.

### MVC protocol
Three-step, split across JS thread and main thread:
1. **JS** (before `prepare()`): `snapshotAnchor()` — records anchor item's Y from current cache.
2. **Fabric layout thread**: ShadowNode `applyMeasurements()` cascades positions; **NEW**: `snapshotAnchorIfNeeded()` covers size-change path.
3. **Main thread** (in `updateState:`): `computeCorrection()` — compares anchor's new Y to snapshot. Stores as `_pendingMVCCorrection`.
4. **Main thread** (in `layoutSubviews`): `_pendingMVCCorrection` applied to `UIScrollView.contentOffset`. Fires `onScroll` to JS.

### Sticky view transform invariant
- Sticky views (`RNScrollCoordinatedView`) use `self.layer.transform` (3D `CATransform3D`) for KVO-driven sticky translation.
- `self.center` and `self.bounds` always reflect the **natural** (layout) position — independent of transform.
- `self.layer.transform.m42` = current Y translation.
- Any code that sets the view's position must use `bounds + center`, not `frame`, when a transform is active.
- Fabric's `updateLayoutMetrics:` now calls `_applyTransform` after `[super ...]` to prevent stale transform.

---

## Files Changed (this session)

| File | Change |
|---|---|
| `example/components/CollectionView.tsx` | `measuredHeightForItem` identity keys; footer `boundaryY` fix; `setMVCEnabled` useEffect; TS type |
| `ios/RNScrollCoordinatedViewView.mm` | `updateLayoutMetrics:` override + `_applyTransform`; footer `MAX` push clamp; removed dead ivars |
| `ios/RNCollectionViewContainerView.mm` | `hasActiveTransform` checks `layer.transform` |
| `cpp/LayoutCache.h` | `setMVCEnabled()`, `snapshotAnchorIfNeeded()`, `_snapshotAnchorLocked()` |
| `cpp/LayoutCache.cpp` | Implement above; JSI binding for `setMVCEnabled` |
| `cpp/CollectionViewContainerShadowNode.cpp` | `cache->snapshotAnchorIfNeeded()` before `applyMeasurements()` |

---

## What's Pending

### Immediately (this branch `cur-size-change-mvc`)
- Build + test size-change MVC correction
- Commit and merge to main

### List Layout Demo (Phase L2 from `ethereal-seeking-willow.md`)
See that file for the full breakdown. Summary:
- **Section 1 "Sticky Identity":** animated shimmer + millisecond timer on header AND footer (same instance, repositioned natively). Proves identity preservation vs FlashList re-render.
- **Section 2 "Cell Animation Identity":** variable-height cells, every 4th has animated shimmer background. Proves Activity=hidden preserves animation state.
- **Section 3 "Insets + Spacing":** large insets + 16px spacing with visual ruler annotations.
- **Controls bar:** scroll-to-item buttons (Top/42/Bottom), Insert/Delete/Resize mutation buttons, MVC toggle.

### Remaining Phase 5
- 5g: Extend ShadowNode to all layout types (grid, masonry, flow).
- 5j: Remove JS cell wrapper absolute positioning.
