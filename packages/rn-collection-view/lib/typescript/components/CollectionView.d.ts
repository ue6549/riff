/**
 * CollectionView — M2.1 shell + M2.3 renderer + M2.4 window controller
 *                + M3.1 Activity-based cell suspension.
 *
 * Lives in example/components/ during POC development so it shares the
 * example app's React instance (avoids the dual-React hooks crash that
 * happens when a component in packages/src/ has its own node_modules/react).
 * Will move to packages/src/ once the monorepo uses workspace hoisting.
 *
 * Windowing model (M2.4 + M4.1):
 *   Items outside the render window are not mounted at all.
 *   Items inside the render window are Activity=visible — they form the visual
 *   buffer so cells are fully painted before the viewport reaches them.
 *   Items in the measure range (beyond render range, parked at top:-9999) use
 *   Activity=hidden so Fabric computes their Yoga layout for height measurement
 *   without painting them or firing their user-cell effects.
 *   Heights are measured by the ShadowNode via Yoga and written back to the
 *   C++ LayoutCache — no JS measurement roundtrip needed.
 *
 * Scroll path optimisations:
 *   - Window range computed with O(1) arithmetic (no JSI on scroll tick).
 *   - State only updated when a range boundary actually changes.
 *   - Render window mounted via data.slice — reconciliation is O(window), not O(n).
 *   - Visible range consumed via useDeferredValue so Activity-mode updates
 *     never block the JS thread on a frame where the render range also changed.
 *   - updateScrollPosition removed: C++ already receives scroll position on the
 *     UI thread via UIScrollViewDelegate (M2.2b), one frame before JS sees it.
 *
 * Scroll container: native RNCollectionViewContainer (ShadowNode-managed).
 */
import React from 'react';
import { ScrollViewProps, StyleProp, ViewStyle } from 'react-native';
import { RiffSnapshot } from './CollectionSnapshot';
import type { RiffLayout, RiffSection, RiffRenderItemInfo, RiffScrollOptions, RiffScrollOffsetOptions } from '../types/protocol';
import type { LayoutAttributes } from '../types/layout';
/**
 * F1.2 — Imperative handle exposed via the `ref` prop (React 19 style).
 *
 * Usage:
 *   const ref = useRef<RiffHandle<MyItem>>(null);
 *   <Riff ref={ref} ... />
 *   const snap = ref.current.snapshot();
 *   snap.appendItems(newItems);
 *   ref.current.apply(snap);   // diff + LayoutAnimation + startTransition
 *
 * RiffScrollOptions and RiffScrollOffsetOptions are re-exported from @riff/types/protocol.
 */
export interface RiffHandle<T = unknown> {
    /**
     * Scroll to the item at the given index path.
     * section: 0-based section index. item: 0-based item index within the section.
     */
    scrollToIndexPath(indexPath: {
        section: number;
        item: number;
    }, options?: RiffScrollOptions): void;
    /**
     * Scroll to the start of a section — its header if one exists, otherwise its first item.
     * Equivalent to UICollectionView's scrollToItemAtIndexPath:item=0 atScrollPosition:.
     */
    scrollToSection(sectionIndex: number, options?: RiffScrollOptions): void;
    /** Scroll to the very beginning of the content (offset 0,0). */
    scrollToTop(options?: {
        animated?: boolean;
    }): void;
    /** Scroll to the trailing edge of the content (right for horizontal, bottom for vertical). */
    scrollToEnd(options?: {
        animated?: boolean;
    }): void;
    /** Scroll to an absolute content offset. */
    scrollToOffset(options: RiffScrollOffsetOptions): void;
    /**
     * Scroll to the item with the given cache key (low-level).
     * Prefer scrollToIndexPath for consumer use.
     * Key format for sectioned mode: `${sectionKey}:${keyExtractor(item)}`.
     */
    scrollToItem(key: string, options?: RiffScrollOptions): void;
    /**
     * Scroll to item at flat index (flat mode convenience).
     * Equivalent to scrollToIndexPath({ section: 0, item: index }).
     */
    scrollToIndex(index: number, options?: RiffScrollOptions): void;
    /**
     * Get layout attributes for item at flat index (flat mode convenience).
     * Returns null if the index is out of range or the item has no cached layout.
     */
    getItemLayoutAt(index: number): LayoutAttributes | null;
    /**
     * @unstable
     *
     * Evict cached heights for items at the given flat indices.
     * Flat-mode convenience for invalidateKeys — resolves indices to keys internally.
     */
    invalidateAt(indices: number[]): void;
    /**
     * Create a snapshot seeded with the current data array and key extractor.
     * Record mutations on it, then pass to apply().
     */
    snapshot(): RiffSnapshot<T>;
    /**
     * Apply a snapshot: diff old vs new keys, evict stale heights for removed
     * items, trigger LayoutAnimation for position shifts, and commit the update
     * inside startTransition.
     *
     * Two ways to deliver the new data array to your state:
     *
     *   // Option A — pass the setter at the call site (recommended):
     *   ref.current.apply(snap, setData);
     *
     *   // Option B — wire onDataChange in JSX and call apply with no setter:
     *   <Riff onDataChange={setData} ... />
     *   ref.current.apply(snap);
     *
     * If both are provided, the call-site setter wins.
     * If neither is provided, a dev warning is logged and the data does not update.
     */
    apply(snap: RiffSnapshot<T>, setData?: ((data: T[]) => void) | boolean, animated?: boolean): void;
    /**
     * @unstable
     *
     * Evict the cached height for the item at (sectionIndex, itemIndex) and
     * trigger a re-measurement pass.
     *
     * Call this in the same event handler as your state update — React 19 batches
     * both into one commit so the cell is measured at its new natural height
     * without a second render pass.
     */
    invalidateItem(sectionIndex: number, itemIndex: number): void;
    /**
     * @unstable Low-level escape hatch. Prefer invalidateItem(sectionIndex, itemIndex)
     * or invalidateAt(indices) — both resolve to the correct cache key internally.
     *
     * Evicts cached heights for the given keys and triggers a re-measurement pass.
     * The key must be the exact string that keyExtractor returns for the item in
     * flat mode. In sections mode use invalidateItem instead.
     */
    invalidateKeys(keys: Iterable<string>): void;
    /**
     * @unstable Key format is an internal detail — consumers should not need to
     * construct cache keys. A future version will accept (sectionIndex, itemIndex)
     * instead.
     *
     * Returns full layout attributes (frame, sizingState, isSticky, zIndex, etc.)
     * for the item with the given cache key, or null if not found. Useful for
     * custom scroll math via scrollToOffset.
     */
    getItemLayout(key: string): LayoutAttributes | null;
}
export interface RiffProps<T = unknown> {
    /** Flat mode data. Mutually exclusive with `sections`. */
    data?: T[];
    /** Sectioned mode. Mutually exclusive with `data`. */
    sections?: RiffSection<T>[];
    /**
     * Layout engine conforming to the RiffLayout protocol.
     * When provided, the layout handles position computation, content sizing,
     * and invalidation. Built-in props (itemHeight, estimatedItemHeight) are
     * ignored — the layout's delegate owns sizing.
     *
     * Usage:
     *   import { list, masonry, grid, flow, customLayout } from 'riff/layouts';
     *   <CollectionView layout={masonry({ columns: 3, heightForItem: fn })} ... />
     */
    layout?: RiffLayout;
    /**
     * Called for each item. Receives a `RiffRenderItemInfo<T>` with all four
     * fields always present (flat mode: sectionIndex=0, itemIndex=index).
     */
    renderItem: (info: RiffRenderItemInfo<T>) => React.ReactElement | null;
    keyExtractor?: (item: T, ...args: any[]) => string;
    /**
     * Returns a string type identifier for an item. Items with the same type
     * share a recycle pool — a slot vacated by one item can be reused by another
     * of the same type without remounting the inner component.
     *
     * Identical to FlashList's getItemType. Use this whenever your list renders
     * heterogeneous cell components (e.g. banners, products, ads) to prevent
     * cross-type recycling, which is no cheaper than a cold mount.
     *
     * Default: all items share a single 'item' pool (no segregation).
     */
    getItemType?: (item: T, index: number) => string;
    /**
     * Returns a string type identifier for a supplementary view (header or footer).
     * Supplementary views with the same type share a recycle pool — matches
     * UICollectionView's reuseIdentifier per supplementary kind.
     *
     * Receives the kind ('header' | 'footer') and the section index.
     * Default: all headers share 'header' pool, all footers share 'footer' pool.
     */
    getSupplementaryType?: (kind: 'header' | 'footer', sectionIndex: number) => string;
    /**
     * Like FlatList's `extraData` — changing this value forces a re-render of ALL visible cells
     * and a layout re-measurement pass.
     *
     * Pass any value that changes when items resize. A simple version counter works well:
     * ```ts
     * const [resizeVersion, setResizeVersion] = useState(0);
     * // in your resize handler:
     * setResizeVersion(v => v + 1);
     * // on the component:
     * <Riff extraData={resizeVersion} ... />
     * ```
     *
     * This re-renders all visible cells regardless of what changed. For lists with many
     * cells this is acceptable; `invalidateItem` (unstable) is a more precise alternative
     * when it is reliable.
     */
    extraData?: unknown;
    /**
     * Initial height estimate for items. Yoga is always the authority for final cell
     * dimensions — this value seeds the layout before measurement.
     * Enables the onLayout measurement pass: cells report their measured height,
     * LayoutCache is updated incrementally, and scroll position is corrected so
     * visible content does not jump when an item above it changes size.
     *
     * Only meaningful for the default vertical list (no `layout` prop). When a layout
     * is provided, sizing is owned by the layout's estimatedHeightForItem / estimatedSizeForItem
     * delegates; this prop is used only as a stride fallback for the JS window computation
     * and as the H-container height seed before the first measurement.
     */
    estimatedItemHeight?: number;
    /**
     * @unstable This API is not yet stable and may change or be removed.
     *
     * Called when an item's object reference changes behind the same key to decide
     * whether its cached height should be invalidated and the cell re-measured.
     *
     * Default: `(prev, next) => prev !== next` — any reference change triggers
     * re-measurement. Override to skip remeasure when only non-height fields change
     * (e.g. a badge count update that doesn't affect cell height).
     *
     * **Known limitation:** This does NOT call `nativeLayoutCache.removeAttributes` — it only
     * bumps `layoutCacheVersion`. If the LayoutCache still holds a stale measured height for the
     * key, the re-render races with the Yoga re-measurement cycle and the cell may stay at its
     * old height until the next layout pass. For reliable resize, use `extraData` instead.
     *
     * Works for all layout types (list, grid, masonry, flow, custom).
     */
    remeasureOnItemChange?: (prev: T, next: T) => boolean;
    itemSpacing?: number;
    sectionInsetTop?: number;
    sectionInsetBottom?: number;
    sectionInsetLeft?: number;
    sectionInsetRight?: number;
    /**
     * How many additional viewport-heights to keep rendered above and below
     * the visible area. Default 1.0 → total render window = 3× viewport.
     */
    renderMultiplier?: number;
    /**
     * H-3.5 — Render multiplier used specifically for horizontal sections.
     * Decouples the H window size from the V window size so you can tune them
     * independently. For example, a long feed can use renderMultiplier={0.25}
     * for V efficiency while horizontal carousels use hRenderMultiplier={1.0}
     * so they never show a blank leading edge.
     *
     * Precedence for H sections:
     *   section.renderMultiplier ?? hRenderMultiplier ?? renderMultiplier ?? 0.5
     *
     * Defaults to renderMultiplier (backward-compatible — same behaviour as before).
     */
    hRenderMultiplier?: number;
    /**
     * M3.5 — Maximum mounted content expressed as a viewport-height multiple.
     * E.g. 5.0 = keep at most 5× the viewport height worth of cells mounted.
     * Self-calibrating: works regardless of item size or heterogeneous heights.
     * Relates naturally to renderMultiplier — velocity can temporarily expand
     * the render window, but total mounted content is capped here.
     * Default 5.0. Set to Infinity to disable.
     */
    mountedWindowSize?: number;
    /**
     * M4.1 — How many viewport-heights to pre-measure ahead of (and behind) the
     * render range. Cells in this extended zone are mounted off-screen at top:-9999
     * inside Activity=hidden so their heights are captured before they scroll into
     * view, eliminating white-space flash on fast scroll.
     * Default 2.0. Only active in variable-height mode (estimatedItemHeight).
     * Set to 0 to disable pre-measurement.
     */
    measureAhead?: number;
    /**
     * How many items to render on the very first paint, before viewport
     * dimensions are known. Avoids the blank-frame flash that would otherwise
     * occur while waiting for onLayout. Items are positioned at stride-estimated
     * positions. Once the viewport is measured, the real windowed range takes over.
     * Default 10. Set to 0 to disable (renders nothing until layout is known).
     */
    initialNumToRender?: number;
    /**
     * Maximum number of idle slots kept alive (Activity=hidden) per item type
     * between render-window updates. Idle slots let items re-enter the window
     * as a cheap prop update (Fiber reuse) rather than a cold mount.
     *
     * Default: undefined = auto (tracks the current render window size). This
     * guarantees zero steady-state cold mounts on revisit at negligible memory
     * cost — Activity=hidden cells don't participate in layout or GPU rendering.
     *
     * Set to a fixed number to cap memory usage at the cost of more cold mounts.
     * Set to 0 to disable pooling entirely (every revisit is a cold mount).
     */
    recyclePoolSize?: number;
    /**
     * Called whenever the number of rendered items changes.
     * Useful for debug overlays: (renderCount, totalCount) => void.
     */
    onRenderCountChange?: (renderCount: number, totalCount: number) => void;
    /** Called after each render with the number of mounted decoration views (windowing proof). */
    onDecorationCountChange?: (count: number) => void;
    /**
     * Fires when the container's measured size changes.
     * Useful for coordinating external UI (animations, other components) with container resize.
     * The layout itself re-computes automatically — this callback is for consumer side effects only.
     */
    onContainerSizeChange?: (width: number, height: number) => void;
    /**
     * ScrollView-compatible content size callback.
     * Called when the native scroll content size changes.
     * Supports legacy/top-level usage; equivalent to scrollViewProps.onContentSizeChange.
     */
    onContentSizeChange?: (width: number, height: number) => void;
    /**
     * @experimental
     *
     * Fires on every scroll event with an estimate of how many pixels of the
     * visible viewport are not covered by the render window.
     *   offsetStart: gap px at the leading edge (top when scrolling down)
     *   offsetEnd:   gap px at the trailing edge (bottom when scrolling down)
     * Both are 0 when the render window fully covers the viewport.
     *
     * Important caveats — read before relying on this:
     *
     * 1. Geometry-based, not pixel-based. Values are derived from the position
     *    of the first/last rendered item in LayoutCache vs the current scroll
     *    offset. A non-zero value means the render window boundary has receded
     *    past the viewport edge — it does NOT mean blank pixels were actually
     *    painted on screen (cells may already be mid-mount).
     *
     * 2. Always 0 for custom layouts. The computation only works on sorted
     *    layouts (list, grid, masonry, flow). Custom spatial-query layouts
     *    always return 0.
     *
     * 3. Fires on every scroll tick (not throttled). Gate expensive work inside
     *    the callback yourself.
     *
     * For a reliable indication of what the user can see, use onViewableRangeChange.
     * Only enable RNCV_DEBUG_CALLBACKS to receive this callback.
     */
    onBlankArea?: (event: {
        offsetStart: number;
        offsetEnd: number;
    }) => void;
    /**
     * Fires when any windowing range boundary changes. Ranges are flat indices
     * into the data array (or the flattened sections array in sectioned mode).
     *
     *   visible:  items whose frame overlaps the current viewport
     *   render:   items currently mounted (the render window around visible)
     *   measure:  items pre-mounted off-screen for height measurement
     *             (only present in variable-height mode, i.e. estimatedItemHeight)
     *
     * Called only when at least one boundary actually changes — not on every
     * scroll tick. Zero overhead on scroll events where the window is stable.
     *
     * Use this instead of onBlankArea for reliable visibility tracking. To get
     * the item or its frame for a given index, call ref.current.getItemLayout(key).
     */
    onViewableRangeChange?: (ranges: {
        visible: {
            first: number;
            last: number;
        };
        render: {
            first: number;
            last: number;
        };
        measure?: {
            first: number;
            last: number;
        };
    }) => void;
    /**
     * Called by ref.current.apply(snap) with the mutated data array so you
     * can sync your React state. Equivalent to passing your state setter directly
     * to apply(): `ref.current.apply(snap, setData)`.
     *
     * Wire this in JSX when you always want the same setter:
     *   const [data, setData] = useState(initialItems);
     *   <Riff data={data} onDataChange={setData} ref={listRef} />
     *   ref.current.apply(snap); // no setter needed at call site
     *
     * Already wrapped in startTransition internally — do not wrap again.
     * If both onDataChange and a call-site setter are provided, the call-site wins.
     */
    onDataChange?: (data: T[]) => void;
    /**
     * F1.3 — Prefetch callback. Fires when items enter the prefetch window
     * (~prefetchAhead × viewport ahead of the render range). Use this to start
     * loading images or data before cells mount.
     */
    onPrefetch?: (keys: string[]) => void;
    /**
     * F1.3 — Evict callback. Fires when items leave the prefetch window so
     * in-flight loads can be cancelled and resources released.
     */
    onEvict?: (keys: string[]) => void;
    /**
     * F1.3 — How many viewport-heights ahead to fire onPrefetch.
     * Default 12. Set to 0 to disable.
     */
    prefetchAhead?: number;
    /**
     * Flat mode: indices of cells that pin to the top when scrolled past.
     * Only valid when `data` is provided (not `sections`).
     */
    stickyHeaderIndices?: number[];
    /**
     * Flat mode: indices of cells that pin to the bottom when scrolled past.
     * Only valid when `data` is provided (not `sections`).
     */
    stickyFooterIndices?: number[];
    /**
     * How sticky headers behave when multiple are present.
     * - 'sticky': header sticks at top until replaced by next sticky header
     * - 'push': incoming sticky header pushes the current one upward
     *   (matches UICollectionView's default behaviour)
     * Default 'push'.
     */
    stickyMode?: 'sticky' | 'push';
    /**
     * @deprecated Use `decorationRenderers.sectionBackground` instead.
     * Requires `sectionBackground: true` on the list layout delegate.
     * Old prop: not windowed, manually positioned via JS.
     */
    renderSectionBackground?: (sectionIndex: number) => React.ReactElement | null;
    /**
     * Renderers for decoration views emitted by the layout engine.
     * Decoration views are windowed (off-screen ones are not mounted).
     *
     * - `sectionBackground(sectionIndex, frame)`: covers the full section rect.
     *   Requires `sectionBackground: true` on the list layout delegate.
     * - Any custom kind emitted by a custom layout engine.
     *
     * Separators are built-in and use the color from the list layout's
     * `separator.color` option — no renderer needed.
     */
    decorationRenderers?: {
        sectionBackground?: (sectionIndex: number, frame: {
            x: number;
            y: number;
            width: number;
            height: number;
        }) => React.ReactElement | null;
        [kind: string]: ((sectionIndex: number, frame: {
            x: number;
            y: number;
            width: number;
            height: number;
        }) => React.ReactElement | null) | undefined;
    };
    scrollViewProps?: ScrollViewProps;
    style?: StyleProp<ViewStyle>;
    /**
     * P5.2 — Debug performance HUD.
     * When true, renders a live metrics overlay (FPS, frame time, mounted cells,
     * cold mounts, scroll corrections, blank area). Updates at 10 Hz.
     * Uses CADisplayLink for accurate frame time — more precise than RAF-based FPS.
     */
    showHUD?: boolean;
    /**
     * Seed container width for the first render, before onLayout fires.
     * When the layout protocol is active, this lets prepare() run immediately
     * so cells are positioned from heightForItem/sizeForItem on frame 1
     * instead of falling back to uniform stride estimates.
     * Defaults to Dimensions.get('window').width. Set to 0 to disable seeding.
     */
    initialWidth?: number;
    /**
     * Seed container height for the first render, before onLayout fires.
     * Defaults to Dimensions.get('window').height.
     */
    initialHeight?: number;
    /**
     * When true, adjusts the scroll offset whenever items above the viewport
     * are inserted, deleted, or resized — so visible content stays in place.
     * Correction is computed in JS via LayoutCache snapshot-compare.
     * Default false (opt-in).
     */
    maintainVisibleContentPosition?: boolean;
}
export declare const Riff: <T = unknown>(props: RiffProps<T> & React.RefAttributes<RiffHandle<T>>) => React.ReactElement | null;
