# Perf Optimizations Handoff — Opt 4 + Opt 7 — 2026-04-06

## Branch
`cur-cell-pooling`

## What Was Done This Session

### Opt 4: Cell Recycling (SlotManager integration) ✅
### Opt 7: Incremental Render Loop (element cache) ✅

**Files changed:**
- `packages/rn-collection-view/example/components/CollectionView.tsx`
- `docs/COLLECTIONVIEW_INTERNALS.md` — new section documenting SlotManager design

**What it does:**

**Opt 4 — SlotManager:**
- Replaced per-item React keys (`key={keyExtractor(item)}`) with stable slot keys (`key="slot_N"`)
- When the render window shifts, outgoing items release their slot to a typed recycle pool; incoming items claim a matching slot
- Result: Fiber UPDATE instead of DELETE+CREATE+INSERT per scroll boundary crossing
- Sticky cells excluded from pool (use different native component type)
- SlotManager passes `cacheKey` to `RNMeasuredCell` — when a slot is recycled, the `cacheKey` changes, ShadowNode looks up the new item's position from LayoutCache

**Opt 7 — Element cache:**
- `elementCacheRef: Map<slotKey, ElemCacheEntry>` caches ReactElements
- Cache hit requires ALL 5 match: `gen`, `dataKey`, `cacheKey`, `measureOnly`, `item` (reference equality)
- `renderGen` bumped when any global rendering dep changes (`extraData`, `stickyConfig`, `effectiveLayout`, `viewportWidth`)
- On cache hit: push cached element reference — React sees referential equality, skips subtree diffing
- Result: O(delta) render loop instead of O(window_size)

**Fix: pooled-slot guard**
- Changed `if (!data[slot.dataIndex]) continue;` →
  `if (!slot.isPooled && !data[slot.dataIndex]) continue;`
- Pooled slots must always render (Activity=hidden, preserves Fiber) so pool reclaim triggers UPDATE not CREATE

**computeCacheKey extracted:**
- Pulled LayoutCache key derivation out of `renderCell` into a shared `computeCacheKey(index)` helper
- SlotManager and `renderCell` both use this so they produce identical keys

**Fix 1 (isVariableHeight decoupling) — already done:**
- The PERF-PLAN.md Fix 1 patterns were not present in the current code
- `measureAhead > 0` is already the gate everywhere (no `isVariableHeight &&` prefix)

## Status After This Session

| Opt | Status | Description |
|-----|--------|-------------|
| Opt 1 + 2 | ✅ Done | `processScroll` batched JSI call |
| Opt 3 | Deferred | Transform positioning (see PERF-PLAN.md) |
| Opt 4 | ✅ Done | Cell recycling (SlotManager) |
| Opt 5 | Deferred | Flat array spatial queries |
| Opt 6 | ❌ Reverted | JS stability guard caused items to disappear |
| Opt 7 | ✅ Done | Element cache / incremental render loop |

## Key Files to Read Before Continuing

1. `PERF-PLAN.md` — full roadmap with completion status
2. `docs/COLLECTIONVIEW_INTERNALS.md` — "Cell Recycling and Incremental Render Loop" section
3. `packages/rn-collection-view/example/components/SlotManager.ts` — the pool manager
4. `packages/rn-collection-view/example/components/CollectionView.tsx`:
   - Line ~1009: SlotManager + element cache refs
   - Line ~1953: renderGen bump + `computeCacheKey`
   - Line ~2069: `scrollContent` IIFE with SlotManager + element cache loop

## What to Do Next

### 1. Test Opt 4 + Opt 7 (pure JS — Metro reload sufficient)
**No Xcode rebuild needed.** Just Metro reload.

Verify:
- Scroll correctness: no items disappearing, positions correct
- MVC (insert from top): offsets correct
- Sticky headers/footers: still work
- Size change: cell height changes render correctly (`extraData` bump invalidates gen)
- Sectioned list: headers/footers render correctly via SlotManager

### 2. Items disappearing bug (possibly pre-existing)
The items-disappearing bug was observed before Opt 4+7. Opt 6 (JS stability guard) was reverted as a cause. The bug may be in `processScroll`'s C++ `toFlatIdx` for sectioned lists.

**How to diagnose:**
- Enable logs: `RNCV_DEBUG_LOGS = true` in CollectionView.tsx
- Check if items disappear in the non-sectioned "List Layout" demo
- If YES: the bug is in `processScroll` C++ (check `toFlatIdx` lambda ~line 470 of CollectionViewModule.cpp)
- If NO (only sectioned): the bug is in `toFlatIdx` handling of supplementary views

### 3. Headers/footers lose position on size change when MVC off
Test on `main` branch to confirm if pre-existing. If new, check `toFlatIdx` supplementary handling in C++.

### 4. Opt 6 (C++ stability guard)
Now that the C++ `processScroll` exists, Opt 6 can be implemented properly as a C++ skip (not JS-side). The C++ function can check if scrollOffset hasn't moved more than `budgetStride * 0.5` since last call and return the cached result. More precise than JS-side. See PERF-PLAN.md.

## Build Notes
- No new .cpp files → `pod install` NOT required
- Opt 4 + 7 are pure JS → Metro reload sufficient
- Metro: `nvm use && npx react-native start --port 8082 --reset-cache` from `example/`
