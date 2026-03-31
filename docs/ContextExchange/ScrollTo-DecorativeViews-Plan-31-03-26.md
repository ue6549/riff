# Context Exchange: Session Handoff — ScrollTo + Decorative Views Plan
**Date:** 31-03-26

---

## What Was Completed This Session

### 1. Sticky footer fix (committed to `main`)
Three-pronged fix for footer jumping to middle-of-screen after insert/delete:
- `RNCollectionViewContainerView.mm`: `hasActiveTransform` now checks `child.layer.transform` (3D CATransform3D) not just `child.transform` (2D CGAffineTransform)
- `RNScrollCoordinatedViewView.mm`: Override `updateLayoutMetrics:oldLayoutMetrics:` to call `[self _applyTransform]` after `[super ...]` — Fabric sets natural position but leaves layer.transform stale
- `CollectionView.tsx`: Footer `boundaryY` was pointing to next section start (wrong); fixed to current section start. Push clamp changed from `MIN` to `MAX`

### 2. MVC key mismatch fix (committed to `main`)
`measuredHeightForItem()` was reading LayoutCache using positional keys (`item-0-0`) but ShadowNode writes under identity keys (`s0:cell-animation-1`). Fixed to use identity keys when `keyExtractor` is provided.

### 3. MVC size-change correction (committed to `main`)
When a cell resizes without changing item count/section structure, `layoutContext` deps don't change → `useMemo` doesn't re-fire → `snapshotAnchor()` never called from JS → `computeCorrection()` returns 0 → visible rows shift.

Fix:
- Added `snapshotAnchorIfNeeded()` to LayoutCache: snapshots only if `_hasAnchor = false` AND `_mvcEnabled = true`
- Called from ShadowNode before `applyMeasurements()`
- Added `setMVCEnabled()` JSI binding + `useEffect` in CollectionView.tsx to sync the flag

### 4. Import path cleanup (committed to `main`)
- All `riff/src/specs/NativeCollectionViewModule` → `../components/NativeCollectionViewModule` wrapper
- All `riff/src/layouts` → `@riff/layouts`
- metro.config.js: replaced symlink + NODE_OPTIONS with `resolveRequest()` mapping `@riff/*` → `src/`
- Removed `riff: link:../` from package.json, removed `check-riff-link.js`

### 5. L2 ListDemo (committed to `main`)
`LayoutsTab.tsx` ListDemo rewritten as 3-section identity demo:
- S0: Sticky Identity (shimmer+timer header/footer, mutation target)
- S1: Cell Animation Identity (animated shimmer cells, variable heights)
- S2: Insets + Spacing (24/16pt insets, 8px spacing)
- Controls: Insert/Delete/Resize/MVC toggle all wired and working

### 6. L5 mutations confirmed done
Insert/Delete/Resize buttons and MVC toggle were already wired. Only cleanup needed: update info text in LayoutsTab that says "MVC (L5) not yet wired" — it is wired.

---

## Current State

**Branch:** `cur-scrollto` (created from main, empty — ready for L4 work)
**Main:** clean, all above committed and pushed

---

## Next: L4 ScrollToItem

See `ethereal-seeking-willow.md` for full design. Summary:

1. **Native** (`RNCollectionViewContainerView.mm`): `scrollToOffset:animated:` method calling `[_scrollView setContentOffset:animated:]`. Reuse `_applyingCorrection` guard so `scrollViewDidScroll:` is suppressed during programmatic scroll (same pattern as MVC correction).

2. **C++ JSI** (`CollectionViewModule.cpp`): Add `scrollTo(layoutCacheId, x, y, animated)` JSI binding. The JS thread calls it synchronously (no bridge needed — JSI).

3. **JS** (`CollectionView.tsx`): `scrollToItem(key, options)` imperative method:
   - `nativeLayoutCache.getAttributes(key)` — synchronous, returns frame
   - Compute targetY based on `position` mode
   - Clamp to `[0, contentHeight - viewportHeight]`
   - Call `nativeMod.scrollTo(...)`

4. **Demo wiring** (`LayoutsTab.tsx`): Enable the disabled "→ Top", "→ #42", "→ Bot" buttons.

**Dynamic size accuracy:** Items not yet scrolled past use `estimatedItemHeight`. Target is approximate for those (same as UICollectionView + estimatedItemSize). Acceptable for POC.

---

## After L4: L3 Decorative Views

Key design decisions confirmed:
- **Layout-powered, no data** — layout engine emits LayoutAttributes (frame + kind), consumer provides renderer
- **Separators: simple props** (`separatorEnabled`, `separatorColor`, `separatorInsetLeading/Trailing`) — no renderer needed, built-in view
- **Section backgrounds + custom kinds**: consumer provides `decorationRenderers` map
- **Windowed** — participates in render range like cells
- **Z-ordered** via `zIndex` field: backgrounds at -1, separators at 0

Tricky: z-ordering (insertion order in ShadowNode), windowing for large decoration views (section backgrounds may be partially visible when start is off-screen), lifecycle (decorations driven by layout output not data changes).

---

## Architecture Notes Worth Keeping

### Sticky view transform invariant
- `self.center` + `self.bounds` = natural (Yoga) position
- `self.layer.transform.m42` = current Y translation (KVO-driven)
- `updateLayoutMetrics:` sets center/bounds but leaves layer.transform — MUST call `[self _applyTransform]` after `[super ...]`
- `applyPositionsFromState` MUST check `!CATransform3DIsIdentity(child.layer.transform)` not just `!CGAffineTransformIsIdentity(child.transform)`

### MVC protocol (3 steps)
1. JS (before `prepare()`): `snapshotAnchor()` — records anchor item Y from current cache
2. ShadowNode (before `applyMeasurements()`): `snapshotAnchorIfNeeded()` — covers size-change path
3. Native (in `updateState:`): `computeCorrection()` → `_pendingMVCCorrection` → applied in `layoutSubviews`

### Key system
- C++ `computeSections()` stores items under identity keys (`s0:cell-animation-1`) when `p.keys[]` is provided
- Headers/footers always use positional keys: `item-{section}-header`, `item-{section}-footer`
- `measuredHeightForItem()` (JS) must read identity keys: `${sec.key}:${keyExtractor(item, index)}`
