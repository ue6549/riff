# Session Handoff — MVC Offset Correction Fix
**Date:** 2026-03-31

## Status: All code changes complete, pending clean Xcode build + verification

---

## What Was Fixed

`correctionY` was always `0.0` despite visible rows jumping on resize/insert/delete. Two root causes:

### Root Cause 1: scrollY always 0
`LayoutCache::setScrollOffset()` was never called. The native scroll delegate only emitted a
Fabric/JS event. The JS `updateScrollPosition()` call was intentionally removed. A UI-thread
observer path was referenced but never implemented.

**Fix:** `RNCollectionViewContainerView.mm` now calls `layoutCacheForId(_layoutCacheId)->setScrollOffset(x, y)`:
- In `scrollViewDidScroll:` — before the throttle check (so ShadowNode always has fresh data)
- After applying offset correction — so the corrected offset becomes the new truth

### Root Cause 2: Wrong anchor in correction search
`correctedPositions_` is in JSX mount order: `{stickyHeaders}{stickyFooters}{cells}`.
Headers appear at indices 0, 1, 2… in the array regardless of Y position.
When scrollY=491, the old sequential break-on-first search found s1-header at y=2219 (index 1)
instead of the actual first visible cell at y=~491.

**Fix:** Changed to scan ALL children and pick minimum-Y child whose bottom > scrollY.

### Root Cause 2b: Key-based anchor lookup
Even with correct anchor scan, windowed insert/delete changes child indices. Added key-based
anchor lookup: find anchor's stable cache key in old positions, locate same key in new positions,
use that Y as new anchor Y.

---

## Files Changed

### C++ / ShadowNode
- **`cpp/CollectionViewContainerState.h`** — added `std::vector<std::string> keys` parallel to `positions`
- **`cpp/CollectionViewContainerShadowNode.h`** — added `correctedKeys_` ivar, updated `computeOffsetCorrection` signature to accept old/new key vectors
- **`cpp/CollectionViewContainerShadowNode.cpp`**:
  - Phase 1 loop: `correctedKeys_.push_back(key)` alongside position pushes
  - `computeOffsetCorrection`: min-Y anchor scan + key-based lookup (index fallback preserved)
  - `updateStateIfNeeded`: removed `hadMeasurementDeltas_ || childCountChanged` gate; correction runs whenever positions change; passes `state.keys` and `correctedKeys_`
  - Added `#include <limits>`
- **`cpp/LayoutCacheRegistry.h`** — NEW thin header: forward-declares `LayoutCache`, declares `layoutCacheForId(int32_t)` free function
- **`cpp/CollectionViewModule.cpp`** — added `layoutCacheForId` free function wrapping `CollectionViewModule::getLayoutCacheForId`

### iOS Native View
- **`ios/RNCollectionViewContainerView.mm`**:
  - Removed `#import "CollectionViewModule.h"` (caused ObjC++ transitive dep failures)
  - Added inline C++ forward-declaration of `layoutCacheForId` (avoids header search path issues)
  - Added `int32_t _layoutCacheId` ivar
  - `updateProps:`: caches `_layoutCacheId = newProps.layoutCacheId`
  - `scrollViewDidScroll:`: writes scroll offset to LayoutCache (before throttle, after correction guard)
  - `layoutSubviews` (after offset correction): updates LayoutCache with corrected offset

### JS / TypeScript
- **`src/types/protocol.ts`** — added `itemKeys?: readonly string[]` to `SectionInfo`
- **`src/layouts/list.ts`** — added `lastSectionKeys` storage; `prepare()` passes `params.keys`; `attributesForItem` uses stable key
- **`example/components/CollectionView.tsx`**:
  - `layoutContext` useMemo: computes `itemKeys` per section using `propKeyExtractor`
  - `flattenResult` useMemo: post-processes `keyToFlatIndex` with stable→flat index entries
  - `renderCell` cacheKey: uses `sectionKeys[ik]` when available (stable key)
  - `stickyConfigMap`: replaced hardcoded `getAttributes('item-${nextSection}-0')` with `effectiveLayout.attributesForItem(0, nextSection)`

---

## Build Error That Was Fixed

**Error:** `'CollectionViewModule.h' file not found` / `Use of undeclared identifier 'CollectionViewModule'`

`CollectionViewModule.h` has heavy transitive deps (`WindowController.h`, `DiffEngine.h`,
`MetricCollector.h`, etc.) that fail when pulled into ObjC++ via `#import`.

**Solution:** `LayoutCacheRegistry.h` (thin header, no heavy deps) + free function impl in
`CollectionViewModule.cpp`. The `.mm` file uses an inline C++ forward-declaration instead of
importing any header, avoiding all search-path issues.

---

## Next Steps

1. **Clean build in Xcode** (`Cmd+Shift+K` → `Cmd+B`)
2. Scroll list to s0[5], resize s0[0] → rows should NOT shift
3. Scroll to s0[1], insert 3 → rows should NOT shift
4. Check Xcode logs for: `applying offset correction=XX.X scrollY=YYY.Y` with non-zero values
5. If working: **re-silence native logs** (`RNCV_ENABLE_NATIVE_LOGS` back to 0)
6. Continue with **L3 (decoration views)** or other roadmap items

---

## Key Code Shapes (for quick context)

### `computeOffsetCorrection` new anchor scan (cpp/CollectionViewContainerShadowNode.cpp)
```cpp
// Find anchor: smallest Y whose bottom exceeds scrollY (scan ALL — mount order ≠ Y order)
size_t anchorIdx = oldCount;
Float anchorY = std::numeric_limits<Float>::max();
for (size_t i = 0; i < oldCount; ++i) {
    const auto y = oldPositions[i * 4 + 1];
    const auto h = oldPositions[i * 4 + 3];
    if (y + h > scrollY && y < anchorY) { anchorIdx = i; anchorY = y; }
}
if (anchorIdx >= oldCount) return 0;
const auto oldY = anchorY;

// Key-based lookup: find same child in new positions by stable cache key
if (!oldKeys.empty() && !newKeys.empty() && anchorIdx < oldKeys.size()) {
    const auto& anchorKey = oldKeys[anchorIdx];
    if (!anchorKey.empty()) {
        for (size_t i = 0; i < newKeys.size(); ++i) {
            if (newKeys[i] == anchorKey) {
                return newPositions[i * 4 + 1] - oldY;
            }
        }
        return 0; // anchor left render window — no correction
    }
}
// Index-based fallback (no keys available)...
```

### Inline forward-decl in RNCollectionViewContainerView.mm (replaces header import)
```objc
// Forward-declare layoutCacheForId to avoid pulling in CollectionViewModule's heavy deps.
#include <memory>
#include <cstdint>
namespace rncv { class LayoutCache; }
namespace facebook::react {
  std::shared_ptr<rncv::LayoutCache> layoutCacheForId(int32_t cacheId);
}
```
