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
export declare class SlotManager<T> {
    private activeSlots;
    /**
     * Pool keyed by either `itemType` (cross-section recycling enabled) or
     * `${sectionIndex}|${itemType}` (cross-section recycling disabled).
     * The key shape is determined by `crossSectionRecycling` at the time
     * `_poolKey(slot)` is called for each push / pop.
     */
    private recyclePools;
    private dataKeyToSlot;
    private slotCounter;
    /** Max idle slots per pool key kept alive between renders. Default 4. */
    maxPoolSize: number;
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
    crossSectionRecycling: boolean;
    /** Number of fresh slot Fibers created in the most recent sync() call (Case C). */
    lastColdMounts: number;
    private _prevFirst;
    private _prevLast;
    private _prevMF;
    private _prevML;
    private _prevLen;
    private _prevExcludeSize;
    private _prevExcludeHash;
    private _prevRenderGen;
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
    sync(renderFirst: number, renderLast: number, measureFirst: number | null, measureLast: number | null, getDataKey: (i: number) => string, getItemType: (i: number) => string, getCacheKey: (i: number) => string, getSectionIndex: (i: number) => number, getKind: (i: number) => 'item' | 'header' | 'footer', getItem: (i: number) => T, dataLength: number, stickySet: Set<number> | null, excludeIndices?: Set<number>, renderGen?: number): Map<string, SlotInfo<T>>;
    /** Adjust max pool size (e.g. on memory pressure). */
    setMaxPoolSize(n: number): void;
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
    setCrossSectionRecycling(value: boolean): void;
    /** Reset all state (e.g. on data reset or component remount). */
    reset(): void;
    /**
     * Composite pool key. When cross-section recycling is on (default), this
     * is just the itemType — sections share their pools. When off, the key
     * includes the sectionIndex so each section has its own private pool.
     * The "|" separator is reserved (not allowed in itemType returned from
     * consumer's getItemType) so there's no collision risk.
     */
    private _poolKey;
    private _pool;
    private _isMeasureOnly;
}
