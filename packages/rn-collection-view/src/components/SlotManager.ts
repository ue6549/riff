/**
 * SlotManager — React-level cell pooling for Riff.
 *
 * Maintains a stable pool of cell "slots" identified by synthetic keys
 * ("slot_0", "slot_1", …). When the render window shifts, outgoing items
 * release their slot back to the pool and incoming items claim a slot of
 * matching type — triggering a React prop UPDATE instead of a full
 * Fiber DELETE+CREATE+INSERT lifecycle.
 *
 * Layout-agnostic: SlotManager knows nothing about list vs grid vs masonry.
 * It receives flat indices and three pure callbacks:
 *   - getDataKey(i)  → keyExtractor result (data identity)
 *   - getItemType(i) → user-supplied type string (pool segregation)
 *   - getCacheKey(i) → LayoutCache identity key (passed to RNMeasuredCell)
 *   - getItem(i)     → the actual data item (stored so pooled slots don't
 *                       re-render when later reactivated)
 *
 * Pool behaviour:
 *   - Slots released in a render are immediately available for items entering
 *     that same render (common case: simultaneous scroll-out/in).
 *   - Up to `maxPoolSize` (default 4) idle slots per type stay mounted with
 *     Activity=hidden so the Fiber survives between renders (handles
 *     short-distance scroll reversals).
 *   - Excess idle slots are removed from the tree (unmounted) to avoid
 *     unbounded hidden-cell accumulation.
 */

export interface SlotInfo<T> {
  /** Stable React key — never changes for the life of this slot. */
  slotKey: string;
  /** From getItemType — determines which recycle pool this slot belongs to. */
  itemType: string;
  /** Current flat data index. */
  dataIndex: number;
  /** From keyExtractor — the identity of the item currently in this slot. */
  dataKey: string;
  /** Passed to RNMeasuredCell/RNScrollCoordinatedView as the LayoutCache identity. */
  cacheKey: string;
  /**
   * Section index this slot belongs to. Captured from getSectionIndex at every
   * assignment (Phase 3 Cases A/B/C) and preserved across pooling so that
   * downstream consumers can route POOLED slots back to their original
   * section without re-reading the (possibly mutated) flat data.
   *
   * 0 for non-sectioned layouts. Never -1 in practice — a slot always passes
   * through Case A/B/C before being pooled.
   */
  sectionIndex: number;
  /**
   * Slot kind: 'item' | 'header' | 'footer'. Captured from getKind at every
   * assignment and preserved across pooling. Required for routing pooled
   * slots — pooled headers/footers must stay routed as supplementaries (in
   * the V `cells` array, V-positioned by the main container) and must NOT
   * be misrouted into an H sub-container even when their section is an
   * H section.
   *
   * Defaults to 'item' for non-sectioned data.
   */
  kind: 'item' | 'header' | 'footer';
  /** True → Activity=hidden (either in measure range or sitting idle in pool). */
  measureOnly: boolean;
  /** True → slot is idle in the recycle pool, not assigned to any visible index. */
  isPooled: boolean;
  /** The data item this slot should render (kept stable when pooled). */
  item: T;
}

export class SlotManager<T> {
  private activeSlots = new Map<string, SlotInfo<T>>();  // slotKey → info
  /**
   * Pool keyed by either `itemType` (cross-section recycling enabled) or
   * `${sectionIndex}|${itemType}` (cross-section recycling disabled).
   * The key shape is determined by `crossSectionRecycling` at the time
   * `_poolKey(slot)` is called for each push / pop.
   */
  private recyclePools = new Map<string, string[]>();    // poolKey → slotKey[] (LIFO)
  private dataKeyToSlot = new Map<string, string>();     // dataKey → slotKey
  private slotCounter = 0;
  /** Max idle slots per pool key kept alive between renders. Default 4. */
  maxPoolSize = 4;
  /**
   * Cross-section recycling control. When `true` (default), pools are keyed
   * by `itemType` alone — a slot freed by section A can be reclaimed by
   * section B if both use the same widget type. When `false`, pools are
   * keyed by `(sectionIndex, itemType)` — each section's pool is isolated;
   * a slot freed by section A stays available only for section A's
   * subsequent re-entry. Helpful for single-widget-type-across-many-
   * sections workloads (e.g. product feeds) where cross-section churn
   * dominates pool overflow. See backlog B-hsection-private-pools.
   */
  crossSectionRecycling = true;
  /** Number of fresh slot Fibers created in the most recent sync() call (Case C). */
  lastColdMounts = 0;

  // Short-circuit state — when all inputs match, sync() returns cached result in O(1).
  private _prevFirst = -1;
  private _prevLast = -1;
  private _prevMF: number | null = null;
  private _prevML: number | null = null;
  private _prevLen = -1;
  private _prevExcludeSize = 0;
  // Order-independent content hash of excludeIndices. Required (not just size)
  // because H-section windowing rotates the excluded set as the user H-scrolls
  // (e.g. excludes {4..9} → {0,1,6..9} as window shifts) — same size, different
  // contents. Comparing only size here would short-circuit and return stale
  // activeSlots, leaving the H wrapper rendering yesterday's cells while the
  // C++ window has moved on. Visible as: leading-edge whitespace, "items
  // disappear", and (when combined with stale cell positions in the cache for
  // newly-included indices) cells stacked at index-0 frame.
  private _prevExcludeHash = 0;
  // Render generation — bumped by CollectionView when extraData/layout/vpWidth
  // changes. Must be included in the short-circuit check so that in-place item
  // mutations (resize: same range, same length, new item content) force a Phase 3
  // run that refreshes slot.item references. Without this, renderCell receives the
  // stale pre-mutation item, Yoga measures the old height, and no delta is produced.
  private _prevRenderGen = -1;

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Synchronise the slot table to the current render window.
   *
   * @param renderFirst  First index in the visible render range.
   * @param renderLast   Last index in the visible render range.
   * @param measureFirst First index in the measure-ahead range (null = none).
   * @param measureLast  Last index in the measure-ahead range (null = none).
   * @param getDataKey       (i) → identity key from keyExtractor.
   * @param getItemType      (i) → type string for pool segregation.
   * @param getCacheKey      (i) → LayoutCache key for RNMeasuredCell.
   * @param getSectionIndex  (i) → section index of the item at flat index i
   *                         (0 for non-sectioned layouts). Captured into
   *                         SlotInfo.sectionIndex on assignment and preserved
   *                         across pooling — see SlotInfo.sectionIndex jsdoc.
   * @param getKind          (i) → 'item' | 'header' | 'footer' for the item at
   *                         flat index i. Captured into SlotInfo.kind on
   *                         assignment and preserved across pooling — see
   *                         SlotInfo.kind jsdoc. 'item' for non-sectioned data.
   * @param getItem          (i) → the actual data item.
   * @param dataLength       Length of the data array (for bounds checking).
   * @param stickySet        Indices managed as sticky cells (excluded from pool).
   * @returns Map of slotKey → SlotInfo for ALL slots that should be rendered
   *          (assigned + idle pool slots with Activity=hidden).
   */
  sync(
    renderFirst: number,
    renderLast: number,
    measureFirst: number | null,
    measureLast: number | null,
    getDataKey: (i: number) => string,
    getItemType: (i: number) => string,
    getCacheKey: (i: number) => string,
    getSectionIndex: (i: number) => number,
    getKind: (i: number) => 'item' | 'header' | 'footer',
    getItem: (i: number) => T,
    dataLength: number,
    stickySet: Set<number> | null,
    excludeIndices?: Set<number>,
    renderGen?: number,
  ): Map<string, SlotInfo<T>> {
    // Reset per-call counter before any early return so callers never double-count.
    this.lastColdMounts = 0;

    // ── Short-circuit: if all inputs match previous call, return cached result ─
    // Safe because: when data content changes (same length), the consumer changes
    // data reference or extraData → Riff calls prepare() → layoutContext changes →
    // renderGen bumps → element cache misses → renderCell calls computeCacheKey
    // with new keys → Phase 3 Case A/B dataKey checks detect the change.
    // This short-circuit only fires when the index ranges, array length, and
    // H-section exclusion set are identical.
    //
    // excludeHash: order-independent content hash. Pure size check is unsafe —
    // H window rotation produces same-size sets with different contents.
    const excludeSize = excludeIndices?.size ?? 0;
    let excludeHash = 0;
    if (excludeIndices) {
      for (const i of excludeIndices) {
        // boost::hash_combine variant; commutative-friendly via add (order-
        // independent) so set iteration order doesn't change the digest.
        excludeHash = (excludeHash + ((i + 0x9e3779b9) | 0)) | 0;
      }
    }
    if (renderFirst === this._prevFirst && renderLast === this._prevLast &&
        measureFirst === this._prevMF && measureLast === this._prevML &&
        dataLength === this._prevLen &&
        excludeSize === this._prevExcludeSize &&
        excludeHash === this._prevExcludeHash &&
        (renderGen === undefined || renderGen === this._prevRenderGen)) {
      return this.activeSlots;
    }

    // ── Phase 1: Build the set of indices we need this render ───────────────
    const neededIndices = new Set<number>();
    const effectiveMeasureFirst = measureFirst ?? renderFirst;
    const effectiveMeasureLast  = measureLast  ?? renderLast;

    const lo = Math.min(renderFirst, effectiveMeasureFirst);
    const hi = Math.max(renderLast,  effectiveMeasureLast);

    for (let i = lo; i <= hi && i < dataLength; i++) {
      if (stickySet?.has(i)) continue;
      if (excludeIndices?.has(i)) continue; // H-windowed out
      neededIndices.add(i);
    }

    // ── Phase 2: Release slots no longer needed → pool or discard ──────────
    let _p2Released = 0, _p2Discarded = 0;
    for (const [slotKey, slot] of this.activeSlots) {
      if (slot.isPooled) continue; // already in pool, handled in Phase 4

      const stillNeeded =
        neededIndices.has(slot.dataIndex) &&
        slot.dataIndex < dataLength &&
        getDataKey(slot.dataIndex) === slot.dataKey;

      if (!stillNeeded) {
        this.dataKeyToSlot.delete(slot.dataKey);
        // Pool keyed by slot's sectionIndex when cross-section recycling
        // is off — preserved across phase 2 / phase 3 because slot.sectionIndex
        // is set on every Case A/B/C assignment.
        const pool = this._pool(slot.sectionIndex, slot.itemType);
        if (pool.length < this.maxPoolSize) {
          pool.push(slotKey);
          slot.isPooled = true;
          slot.measureOnly = true;
          // Keep slot.item as-is — pooled cell renders old content but is hidden.
          _p2Released++;
        } else {
          // Pool full — let this slot unmount.
          this.activeSlots.delete(slotKey);
          _p2Discarded++;
        }
      }
    }

    // ── Phase 3: Assign slots to needed indices ─────────────────────────────
    let _p3A = 0, _p3B = 0, _p3C = 0;
    for (const index of neededIndices) {
      const dataKey = getDataKey(index);

      // Case A: this data item already owns a slot (possibly pooled).
      const existingSlotKey = this.dataKeyToSlot.get(dataKey);
      if (existingSlotKey) {
        const slot = this.activeSlots.get(existingSlotKey);
        if (slot) {
          if (slot.isPooled) {
            // Promote from pool. Use slot.sectionIndex (the pool's key when
            // cross-section recycling is off), not the new section's index,
            // because the slot was pooled under its prior section's key.
            const pool = this._pool(slot.sectionIndex, slot.itemType);
            const pi = pool.indexOf(existingSlotKey);
            if (pi >= 0) pool.splice(pi, 1);
            slot.isPooled = false;
          }
          slot.dataIndex = index;
          slot.cacheKey = getCacheKey(index);
          slot.sectionIndex = getSectionIndex(index);
          slot.kind = getKind(index);
          slot.measureOnly = this._isMeasureOnly(index, renderFirst, renderLast, measureFirst !== null);
          slot.item = getItem(index);
          _p3A++;
          continue;
        } else {
          // Slot was discarded (pool overflow) — remove stale map entry.
          this.dataKeyToSlot.delete(dataKey);
        }
      }

      // Case B: claim a recycled slot of matching type.
      // The pool we draw from is keyed by the *new* index's section (when
      // cross-section recycling is off) — so we only reclaim a slot that
      // was previously pooled by the same section. Cross-section reclaim
      // returns a smaller pool and forces Case C for sections without
      // matching prior occupants.
      const itemType = getItemType(index);
      const sectionIndex = getSectionIndex(index);
      const pool = this._pool(sectionIndex, itemType);
      if (pool.length > 0) {
        const slotKey = pool.pop()!;
        const slot = this.activeSlots.get(slotKey)!;
        // Guard: only delete the old dataKey mapping if it still points to THIS slot.
        // It may have been re-assigned to a different active slot earlier in this Phase 3
        // loop (e.g. insert→delete sequence where the same dataKey was recycled mid-loop).
        // Deleting it unconditionally would corrupt the map and cause duplicate renders.
        if (this.dataKeyToSlot.get(slot.dataKey) === slotKey) {
          this.dataKeyToSlot.delete(slot.dataKey);
        }
        slot.dataKey   = dataKey;
        slot.dataIndex = index;
        slot.cacheKey  = getCacheKey(index);
        slot.sectionIndex = sectionIndex;
        slot.kind      = getKind(index);
        slot.itemType  = itemType;
        slot.measureOnly = this._isMeasureOnly(index, renderFirst, renderLast, measureFirst !== null);
        slot.isPooled  = false;
        slot.item      = getItem(index);
        this.dataKeyToSlot.set(dataKey, slotKey);
        _p3B++;
        continue;
      }

      // Case C: create a fresh slot.
      const slotKey = `slot_${this.slotCounter++}`;
      const slot: SlotInfo<T> = {
        slotKey,
        itemType,
        dataIndex: index,
        dataKey,
        cacheKey: getCacheKey(index),
        sectionIndex: getSectionIndex(index),
        kind: getKind(index),
        measureOnly: this._isMeasureOnly(index, renderFirst, renderLast, measureFirst !== null),
        isPooled: false,
        item: getItem(index),
      };
      this.activeSlots.set(slotKey, slot);
      this.dataKeyToSlot.set(dataKey, slotKey);
      this.lastColdMounts++;
      _p3C++;
    }

    // ── Phase 4: Trim excess pool slots (unmount overflow) ──────────────────
    for (const [type, pool] of this.recyclePools) {
      while (pool.length > this.maxPoolSize) {
        const slotKey = pool.shift()!; // remove oldest (bottom of stack)
        const slot = this.activeSlots.get(slotKey);
        if (slot) {
          this.dataKeyToSlot.delete(slot.dataKey);
          this.activeSlots.delete(slotKey);
        }
      }
      if (pool.length === 0) this.recyclePools.delete(type);
    }


    // Store inputs for short-circuit check on next call.
    this._prevFirst = renderFirst;
    this._prevLast = renderLast;
    this._prevMF = measureFirst;
    this._prevML = measureLast;
    this._prevLen = dataLength;
    this._prevExcludeSize = excludeSize;
    this._prevExcludeHash = excludeHash;
    if (renderGen !== undefined) this._prevRenderGen = renderGen;

    return this.activeSlots;
  }

  /** Adjust max pool size (e.g. on memory pressure). */
  setMaxPoolSize(n: number) {
    this.maxPoolSize = Math.max(0, n);
  }

  /**
   * Toggle cross-section recycling and migrate the existing pools so the
   * change is non-destructive — slot keys (and therefore React Fibers,
   * `useState`, `useRef`, in-flight animations) are preserved across the
   * toggle. Only the pool index is rebuilt.
   *
   * Caveat: a slot evicted by section A while cross-section recycling was
   * ON might have been about to be reclaimed by section B. After toggling
   * OFF, that slot moves to section A's private pool, so section B can no
   * longer reclaim it — section B will cold-mount on its next assignment.
   * This is the intended trade and is expected on the first sync() call
   * after the toggle.
   */
  setCrossSectionRecycling(value: boolean) {
    if (this.crossSectionRecycling === value) return;

    // Collect every currently pooled slot before mutating state.
    const pooledSlots: SlotInfo<T>[] = [];
    for (const [, pool] of this.recyclePools) {
      for (const slotKey of pool) {
        const slot = this.activeSlots.get(slotKey);
        if (slot) pooledSlots.push(slot);
      }
    }

    // Rebuild pool index under the new keying policy.
    this.recyclePools.clear();
    this.crossSectionRecycling = value;
    for (const slot of pooledSlots) {
      const pool = this._pool(slot.sectionIndex, slot.itemType);
      pool.push(slot.slotKey);
    }
  }

  /** Reset all state (e.g. on data reset or component remount). */
  reset() {
    this.activeSlots.clear();
    this.recyclePools.clear();
    this.dataKeyToSlot.clear();
    this.slotCounter = 0;
    this._prevFirst = -1;
    this._prevLast = -1;
    this._prevMF = null;
    this._prevML = null;
    this._prevLen = -1;
    this._prevExcludeSize = 0;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Composite pool key. When cross-section recycling is on (default), this
   * is just the itemType — sections share their pools. When off, the key
   * includes the sectionIndex so each section has its own private pool.
   * The "|" separator is reserved (not allowed in itemType returned from
   * consumer's getItemType) so there's no collision risk.
   */
  private _poolKey(sectionIndex: number, itemType: string): string {
    return this.crossSectionRecycling ? itemType : `${sectionIndex}|${itemType}`;
  }

  private _pool(sectionIndex: number, itemType: string): string[] {
    const key = this._poolKey(sectionIndex, itemType);
    let pool = this.recyclePools.get(key);
    if (!pool) { pool = []; this.recyclePools.set(key, pool); }
    return pool;
  }

  private _isMeasureOnly(
    index: number,
    renderFirst: number,
    renderLast: number,
    hasMeasureRange: boolean,
  ): boolean {
    if (!hasMeasureRange) return false;
    return index < renderFirst || index > renderLast;
  }
}
