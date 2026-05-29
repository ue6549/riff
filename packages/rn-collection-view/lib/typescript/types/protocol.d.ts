/**
 * Layout Protocol — the unified interface for all layout engines.
 *
 * Aligned with UICollectionView's layout architecture:
 *   - `prepare()` before queries (like UICollectionViewLayout.prepare)
 *   - `attributesForElements(inRect:)` spatial query
 *   - `shouldInvalidateLayout(forBoundsChange:)` resize efficiency
 *   - Per-layout delegate contracts (strict, not optional)
 *
 * Three-tier consumer API:
 *   Tier 1: Simple props on CollectionView (data, renderItem, itemHeight)
 *   Tier 2: Layout config via factory functions (list(), masonry(), grid(), flow())
 *   Tier 3: Full supplementary item API + custom layout delegate
 */
import type React from 'react';
import type { Rect, Size, Insets } from './geometry';
import type { LayoutAttributes } from './layout';
/**
 * The core layout engine interface. All built-in and custom layouts implement this.
 *
 * Modelled after UICollectionViewLayout — the layout is query-driven:
 * `prepare()` does upfront work, then spatial queries are cheap.
 * `shouldInvalidate()` lets the layout decide if a bounds change requires recomputation.
 */
export interface RiffLayout {
    /** Human-readable type identifier. */
    readonly type: string;
    /**
     * When true, the layout scrolls horizontally (primary axis = X).
     * CollectionView uses this to orient its scroll handler and render window query.
     * Defaults to false (vertical scroll).
     */
    readonly horizontal?: boolean;
    /**
     * Called before any queries. Compute and cache positions.
     * For C++ layouts: calls into JSI. For TS layouts: runs in JS.
     */
    prepare(context: LayoutContext): void;
    /**
     * Optional scroll-driven layout hook for sub-container layouts.
     *
     * Scroll-driven layouts (radial, spiral, carousel3D, ...) override this to
     * recompute positions / transforms / opacity per scroll tick. The recommended
     * implementation is to compute all visible items' new attributes in one go
     * and commit them through `setAttributesBatch` (one JSI round-trip for N
     * items), then return — the sub-container's ShadowNode picks the new values
     * up from the cache during its next layout pass.
     *
     * Static layouts (list, grid, masonry, flow) leave this undefined.
     */
    processScroll?(offset: Readonly<{
        x: number;
        y: number;
    }>, ctx: LayoutContext): void;
    /**
     * Spatial query — return attributes for items intersecting rect.
     * Primary interface for the window controller.
     */
    attributesForElements(inRect: Rect): LayoutAttributes[];
    /** Single item query by index path. */
    attributesForItem(index: number, section: number): LayoutAttributes | null;
    /**
     * Supplementary view positioning — layout-specific.
     * Returns natural (un-pinned) position. Pinning is handled by the scroll coordinator.
     */
    attributesForSupplementary(kind: string, section: number): LayoutAttributes | null;
    /** Total scrollable content size. */
    contentSize(): Size;
    /**
     * Should this layout recompute when bounds change?
     * Container resize → true. Scroll only → usually false.
     * This is what makes resize efficiency possible — the layout decides.
     */
    shouldInvalidate(oldBounds: Rect, newBounds: Rect): boolean;
    /**
     * What scope needs recomputation? Optional — defaults to full.
     * Enables incremental invalidation (e.g. only from a specific section).
     */
    invalidationScope?(oldBounds: Rect, newBounds: Rect): RiffInvalidationScope;
    /**
     * Incremental invalidation from a specific item.
     * Called when an item's measured size differs from estimated.
     */
    invalidateFrom?(key: string, context: LayoutContext): void;
    /**
     * When false (default), the scroll handler uses C++ binary search on sorted item
     * positions for O(log n) range computation — no per-item JSI marshalling.
     *
     * Set to true for layouts where visible items are NOT a contiguous index range
     * (e.g. truly non-linear layouts like radial arc, circular grid) — these require
     * a spatial query to find visible items.
     *
     * Built-in layouts (list, grid, masonry, flow) always leave this false.
     * Custom layout authors: set to true only if your layout places items
     * non-contiguously in the viewport. Linear custom layouts can leave it false.
     *
     * Default: false for built-in layouts, true for custom layouts (safe default).
     */
    readonly needsSpatialQuery?: boolean;
    /**
     * Per-section LayoutCache key prefix.
     * Compositional layouts use different prefixes per section (e.g. "item" for list
     * sections, "grid" for grid sections). CollectionView.tsx calls this to derive
     * cacheKey for headers/footers and fallback item keys.
     * If absent, falls back to `type === 'list' ? 'item' : type`.
     */
    keyPrefixForSection?(section: number): string;
    /**
     * Maximum column count used across all sections.
     * Used by processScroll to scale the application budget — returning the max ensures
     * the render window covers all visible items in the widest section.
     * If absent, CollectionView reads `delegate.columns` directly (existing behaviour).
     */
    budgetColumns?(viewportWidth: number): number;
    /**
     * Canonical cache key for an item. Single source of truth — C++ writes use
     * the same format, and all TS readers (computeCacheKey, measuredHeight, sticky)
     * MUST call this rather than constructing keys manually.
     *
     * Returns identity key from keyExtractor when available, otherwise
     * `{typePrefix}-{section}-{index}`.
     */
    cacheKeyForItem?(index: number, section: number): string;
    /**
     * Canonical cache key for a supplementary (header/footer). Single source of
     * truth — matches the key C++ writes to LayoutCache.
     *
     * Compositional layouts use `comp-{section}-{kind}` (Level 1 owned by the
     * orchestrator). Standalone layouts use `{typePrefix}-{section}-{kind}`.
     */
    cacheKeyForSupplementary?(kind: string, section: number): string;
}
/** Geometry context passed to prepare() and invalidateFrom(). */
export interface LayoutContext {
    /** Container width in points. */
    readonly containerWidth: number;
    /** Container height in points. */
    readonly containerHeight: number;
    /** Current scroll offset. */
    readonly scrollOffset: Readonly<{
        x: number;
        y: number;
    }>;
    /** Section metadata — item counts, supplementary info, insets. */
    readonly sections: readonly SectionInfo[];
    /**
     * Actual measured height for an item, if available.
     * Layout engines should prefer this over delegate estimates when present.
     * Returns undefined for items that haven't been measured yet.
     */
    readonly measuredHeightForItem?: (index: number, section: number) => number | undefined;
    /**
     * B4.9: Per-instance cache ID. Each CollectionView instance creates its own
     * LayoutCache via nativeMod.createLayoutCache(). Layout engines use this to
     * route all cache reads/writes to the correct isolated C++ cache.
     */
    readonly cacheId: number;
}
/** Per-section metadata for the layout engine. */
export interface SectionInfo {
    /** Number of data items in this section. */
    readonly itemCount: number;
    /** Section-level insets (padding inside the section). */
    readonly insets?: Insets;
    /** Supplementary views registered for this section. */
    readonly supplementaryItems: readonly SupplementaryInfo[];
    /** Stable identity keys per item (from keyExtractor). Layout engines use as cache keys. */
    readonly itemKeys?: readonly string[];
}
/** Supplementary view metadata for layout computation. */
export interface SupplementaryInfo {
    readonly kind: string;
    readonly size: Readonly<{
        width: number;
        height: number;
    }>;
    readonly alignment: RiffSupplementaryAlignment;
    readonly pinToVisibleBounds: boolean;
    readonly pinBehavior: RiffPinBehavior;
}
export type RiffSupplementaryAlignment = 'top' | 'bottom' | 'leading' | 'trailing';
export type RiffPinBehavior = 'push' | 'overlay';
export interface RiffInvalidationScope {
    readonly type: 'full' | 'fromIndex';
    readonly fromSection?: number;
    readonly fromIndex?: number;
}
/**
 * List layout — single column vertical layout.
 *
 * Sizing: provide `estimatedHeightForItem` (per-item estimate) or `estimatedItemHeight`
 * (scalar fallback). Yoga is always the authority for final dimensions.
 *
 * Horizontal mode: provide `estimatedSizeForItem` for per-item size estimates;
 * Yoga measures both width (primary axis) and height (cross axis) after render.
 */
export interface RiffListConfig {
    /**
     * When true, items flow horizontally (primary axis = X).
     * `estimatedSizeForItem` (or `estimatedItemHeight` as fallback) seeds primary-axis width.
     * `estimatedCrossAxisHeight` seeds the cross-axis height before the first measurement.
     * The list's cross-axis height = max(all measured item heights) + vertical insets.
     */
    horizontal?: boolean;
    /**
     * Initial estimate for item height in horizontal mode (cross-axis size).
     * Yoga measures the actual height after render. The list adjusts its height
     * to the max of all measured item heights. Default: 200.
     * Has no effect in vertical mode.
     */
    estimatedCrossAxisHeight?: number;
    /**
     * Estimated item height for vertical lists, or primary-axis width for horizontal lists.
     * Scalar fallback used when `estimatedHeightForItem` / `estimatedSizeForItem` is absent.
     * Yoga measures the actual size after render. Default: 44.
     */
    estimatedItemHeight?: number;
    /**
     * Per-item height estimate for vertical lists. Section-first param order.
     * Called for items in the windowed range. Yoga measures actual heights.
     * Falls back to `estimatedItemHeight ?? 44` when absent.
     */
    estimatedHeightForItem?: (section: number, index: number) => number;
    /**
     * Per-item size estimate for horizontal lists. Section-first param order.
     * Returns `{ width, height }` — Yoga measures actual dimensions.
     * Falls back to `{ width: estimatedItemHeight ?? 44, height: estimatedCrossAxisHeight ?? 200 }`.
     */
    estimatedSizeForItem?: (section: number, index: number) => Readonly<{
        width: number;
        height: number;
    }>;
    headerHeight?: number;
    estimatedHeaderHeight?: number;
    heightForHeader?: (sectionIndex: number) => number;
    footerHeight?: number;
    estimatedFooterHeight?: number;
    heightForFooter?: (sectionIndex: number) => number;
    itemSpacing?: number;
    stickyMode?: RiffStickyMode;
    separator?: {
        /** Line color. Default: '#C6C6C8' (iOS system separator grey). */
        color?: string;
        /** Line height in points. Default: StyleSheet.hairlineWidth (0.5). */
        height?: number;
        /** Left inset. Default: 0. */
        insetLeading?: number;
        /** Right inset. Default: 0. */
        insetTrailing?: number;
    };
    sectionBackground?: boolean;
    /**
     * Insets applied to the sectionBackground frame at C++ emission time.
     * Positive values shrink the frame inward; negative values expand it outward.
     * Applied in absolute visual coordinates:
     *   top/bottom → adjust Y origin and height
     *   left/right → adjust X origin and width
     * This mirrors NSCollectionLayoutDecorationItem.contentInsets — adjustments happen
     * at the layout level so windowing and ShadowNode positioning use the final frame.
     * Requires `sectionBackground: true`.
     */
    sectionBackgroundContentInsets?: {
        top?: number;
        bottom?: number;
        left?: number;
        right?: number;
    };
    /**
     * Vertical gap inserted after each section's footer (or last item if no footer),
     * before the next section's header. Sits outside the section background frame.
     * Analogous to NSCollectionLayoutSection.interSectionSpacing.
     * Default: 0.
     */
    sectionSpacing?: number;
}
/**
 * Masonry layout — fixed columns, variable-height items, shortest-column placement.
 *
 * `columns` is mandatory. Provide `estimatedHeightForItem` for per-item height estimates,
 * or `estimatedItemHeight` as a scalar fallback. Yoga measures actual heights.
 * Width is derived from container width and column count.
 */
export interface RiffMasonryConfig {
    /** Number of columns, or a function of container width for responsive layouts. Mandatory. */
    columns: number | ((containerWidth: number) => number);
    /**
     * Per-item height estimate. Section-first param order.
     * Used for initial lane assignment; Yoga measures actual heights.
     * Falls back to `estimatedItemHeight ?? 44` when absent.
     */
    estimatedHeightForItem?: (section: number, index: number) => number;
    /** Scalar height estimate used when `estimatedHeightForItem` is absent. Default: 44. */
    estimatedItemHeight?: number;
    headerHeight?: number;
    heightForHeader?: (sectionIndex: number) => number;
    footerHeight?: number;
    heightForFooter?: (sectionIndex: number) => number;
    columnSpacing?: number;
    rowSpacing?: number;
    /**
     * Vertical gap inserted after each section's footer (or last item if no footer),
     * before the next section's header. Analogous to NSCollectionLayoutSection.interSectionSpacing.
     */
    sectionSpacing?: number;
    stickyMode?: RiffStickyMode;
    /** Lane-divider separators between masonry columns (V) or rows (H). */
    separator?: {
        /** Line color. Default: '#C6C6C8' (iOS system separator grey). */
        color?: string;
        /** Line thickness in points. Default: StyleSheet.hairlineWidth (0.5). */
        height?: number;
        /** Leading inset from section edge. Default: 0. */
        insetLeading?: number;
        /** Trailing inset from section edge. Default: 0. */
        insetTrailing?: number;
    };
    /** When true, the layout engine emits a sectionBackground decoration attribute
     *  covering the full section rect. Render via decorationRenderers on the component. */
    sectionBackground?: boolean;
    /**
     * Insets applied to the sectionBackground frame at C++ emission time.
     * Same semantics as the list layout equivalent — see RiffListConfig.
     * Requires `sectionBackground: true`.
     */
    sectionBackgroundContentInsets?: {
        top?: number;
        bottom?: number;
        left?: number;
        right?: number;
    };
    /**
     * When true, the masonry layout scrolls horizontally.
     * Lanes run left-to-right; items are placed into the shortest lane.
     * `columns` controls the number of horizontal lanes (rows).
     * Yoga measures item widths (primary axis); heights are uniform across all items
     * and self-determined from the tallest measured item (same pattern as H-grid).
     */
    horizontal?: boolean;
    /**
     * Estimated item height along the cross axis for horizontal masonry.
     * Used as initial estimate before Yoga measures actual heights.
     * Default: 200.
     */
    estimatedCrossAxisHeight?: number;
}
/**
 * Grid layout — fixed columns, row-aligned heights.
 *
 * Provide `estimatedHeightForItem` for per-item height estimates (row height = tallest in row),
 * or `estimatedItemHeight` as a scalar fallback. Yoga measures actual heights.
 * Width is derived from container width and column count.
 * Horizontal mode: `estimatedSizeForItem` provides per-item size estimates.
 */
export interface RiffGridConfig {
    /** Number of columns, or a function of container width for responsive layouts. Mandatory. */
    columns: number | ((containerWidth: number) => number);
    /**
     * Scalar height estimate used as fallback when `estimatedHeightForItem` / `estimatedSizeForItem`
     * is absent. For horizontal grids, seeds the primary-axis width estimate.
     * Yoga measures actual dimensions. Default: 44.
     */
    estimatedItemHeight?: number;
    /**
     * Per-item height estimate for vertical grids. Row height = max estimate in each row.
     * Section-first param order. Yoga measures actual heights.
     * Falls back to `estimatedItemHeight ?? 44` when absent.
     */
    estimatedHeightForItem?: (section: number, index: number) => number;
    /**
     * Per-item size estimate for horizontal grids. Section-first param order.
     * Returns `{ width, height }` — Yoga measures actual dimensions.
     * Falls back to scalar fallbacks when absent.
     */
    estimatedSizeForItem?: (section: number, index: number) => Readonly<{
        width: number;
        height: number;
    }>;
    headerHeight?: number;
    heightForHeader?: (sectionIndex: number) => number;
    footerHeight?: number;
    heightForFooter?: (sectionIndex: number) => number;
    columnSpacing?: number;
    rowSpacing?: number;
    /**
     * Vertical gap inserted after each section's footer (or last row if no footer),
     * before the next section's header. Analogous to NSCollectionLayoutSection.interSectionSpacing.
     */
    sectionSpacing?: number;
    stickyMode?: RiffStickyMode;
    /** Row separators between rows in the grid. */
    separator?: {
        color?: string;
        height?: number;
        insetLeading?: number;
        insetTrailing?: number;
    };
    /** When true, the layout engine emits a sectionBackground decoration attribute
     *  covering the items area. Render via decorationRenderers on the component. */
    sectionBackground?: boolean;
    /**
     * Insets applied to the sectionBackground frame at C++ emission time.
     * Same semantics as the list layout equivalent — see RiffListConfig.
     * Requires `sectionBackground: true`.
     */
    sectionBackgroundContentInsets?: {
        top?: number;
        bottom?: number;
        left?: number;
        right?: number;
    };
    /**
     * When true, the grid scrolls horizontally.
     * `columns` controls how many items fill the cross axis (Y) per column-group.
     * Items tile top-to-bottom within a column-group, then advance left-to-right
     * (column-major order — mirrors UICollectionViewFlowLayout horizontal default).
     * Yoga measures item widths (primary axis); heights are derived from column count.
     */
    horizontal?: boolean;
    /**
     * Estimated item width along the scroll axis for horizontal grids.
     * Used as initial estimate before Yoga measures actual widths.
     * Default: 200.
     */
    estimatedCrossAxisHeight?: number;
}
/**
 * Flow layout — variable-width items, greedy bin-packing, wraps to next line.
 *
 * V-mode: items pack left-to-right, wrap when next item doesn't fit row width.
 * H-mode: items pack top-to-bottom, wrap when next item doesn't fit column height.
 * `estimatedSizeForItem` provides per-item size estimates; Yoga measures actual dimensions.
 */
export interface RiffFlowConfig {
    /**
     * Per-item size estimate. Section-first param order. Returns `{ width, height }`.
     * Yoga measures actual dimensions. Falls back to `{ width: containerWidth, height: estimatedItemHeight ?? 44 }`.
     * For H-flow, also used for primary-axis height estimates.
     */
    estimatedSizeForItem?: (section: number, index: number) => Readonly<{
        width: number;
        height: number;
    }>;
    /**
     * Scalar height estimate used when `estimatedSizeForItem` is absent. Default: 44.
     */
    estimatedItemHeight?: number;
    headerHeight?: number;
    heightForHeader?: (sectionIndex: number) => number;
    footerHeight?: number;
    heightForFooter?: (sectionIndex: number) => number;
    itemSpacing?: number;
    lineSpacing?: number;
    /**
     * Gap inserted after each section's footer before the next section's header.
     * Analogous to NSCollectionLayoutSection.interSectionSpacing.
     */
    sectionSpacing?: number;
    stickyMode?: RiffStickyMode;
    /** Between-row separators (V) or between-column separators (H). */
    separator?: {
        /** Line color. Default: '#C6C6C8' (iOS system separator grey). */
        color?: string;
        /** Line thickness in points. Default: StyleSheet.hairlineWidth (0.5). */
        height?: number;
        /** Leading inset from section edge. Default: 0. */
        insetLeading?: number;
        /** Trailing inset from section edge. Default: 0. */
        insetTrailing?: number;
    };
    /** When true, the layout engine emits a sectionBackground decoration attribute
     *  covering the full section rect. Render via decorationRenderers on the component. */
    sectionBackground?: boolean;
    /**
     * Insets applied to the sectionBackground frame at C++ emission time.
     * Same semantics as the list layout equivalent — see RiffListConfig.
     * Requires `sectionBackground: true`.
     */
    sectionBackgroundContentInsets?: {
        top?: number;
        bottom?: number;
        left?: number;
        right?: number;
    };
    /**
     * When true, flow scrolls horizontally.
     * Items pack top-to-bottom within each column, wrapping to a new column when
     * the next item doesn't fit the container height. Column width = widest item in column.
     * Unlike H-masonry, container height is fixed (provided by the consumer, not adaptive).
     */
    horizontal?: boolean;
}
/**
 * Custom layout — full control. Per-item attribute function.
 *
 * The layout calls `attributesForItem` however it wants internally.
 * No stickyMode — custom layouts handle their own pinning via
 * `attributesForSupplementary` on the RiffLayout interface.
 */
export interface RiffCustomConfig {
    /** When true, the layout scrolls horizontally. Defaults to false. */
    horizontal?: boolean;
    /**
     * Compute layout attributes for a single item.
     * Called per-index for items in the windowed range.
     */
    attributesForItem: (index: number, section: number, context: LayoutContext) => LayoutAttributes;
}
export type RiffStickyMode = 'push' | 'overlay' | 'none';
/**
 * Full supplementary item definition.
 * Used in Tier 3 when the consumer needs custom supplementary views
 * beyond standard headers/footers.
 */
export interface RiffSupplementary {
    /** Kind identifier. 'header' and 'footer' are reserved for standard use. */
    kind: string;
    /** Render function for this supplementary view. */
    render: () => React.ReactElement;
    /** Size of the supplementary view. 'full' for width = container width. */
    size: Readonly<{
        width: number | 'full';
        height: number;
    }>;
    /** Where this view is positioned relative to the section. */
    alignment: RiffSupplementaryAlignment;
    /** Whether this view pins to visible bounds during scroll. */
    pinToVisibleBounds?: boolean;
    /** How pinned views interact: 'push' = next pushes current, 'overlay' = stack. */
    pinBehavior?: RiffPinBehavior;
    /** Z-ordering override. */
    zIndex?: number;
}
/**
 * Section configuration — combines data with layout metadata.
 *
 * Tier 1: Use `header`/`footer` shorthand for simple cases.
 * Tier 3: Use `supplementaryItems` for custom supplementary views.
 * Both can coexist — `header`/`footer` are additive, not exclusive.
 */
export interface RiffSection<T> {
    /** Stable section key. */
    key: string;
    /** Data items for this section. */
    data: T[];
    /** Section-level insets. All sides optional — unspecified sides default to 0. */
    insets?: Partial<Insets>;
    header?: {
        render: () => React.ReactElement | null;
        height: number;
        sticky?: boolean;
    };
    footer?: {
        render: () => React.ReactElement | null;
        height: number;
        sticky?: boolean;
    };
    supplementaryItems?: RiffSupplementary[];
    background?: (sectionIndex: number) => React.ReactElement | null;
    renderMultiplier?: number;
    mountedWindowSize?: number;
    measureAhead?: number;
}
/**
 * Info object passed to the `renderItem` callback.
 *
 * All four fields are always present regardless of flat/sectioned mode:
 *   flat mode:      sectionIndex=0, itemIndex=index
 *   sectioned mode: index=flat position across all sections
 */
export interface RiffRenderItemInfo<T> {
    item: T;
    /** Flat position across all sections (flat mode: position in data array). */
    index: number;
    /** 0-based section index. Always 0 in flat-data mode. */
    sectionIndex: number;
    /** 0-based item index within the section. Equals index in flat-data mode. */
    itemIndex: number;
}
export interface RiffScrollOptions {
    /** Whether to animate the scroll. Default: true. */
    animated?: boolean;
    /**
     * Where to position the target item relative to the viewport.
     * 'nearest' is a no-op if the item is already fully visible.
     * Default: 'top'.
     */
    position?: 'top' | 'center' | 'bottom' | 'nearest' | 'start' | 'end';
}
export interface RiffScrollOffsetOptions {
    x?: number;
    y?: number;
    animated?: boolean;
}
/** Factory function signatures for built-in layouts. */
export type ListLayoutFactory = (delegate: RiffListConfig) => RiffLayout;
export type MasonryLayoutFactory = (delegate: RiffMasonryConfig) => RiffLayout;
export type GridLayoutFactory = (delegate: RiffGridConfig) => RiffLayout;
export type FlowLayoutFactory = (delegate: RiffFlowConfig) => RiffLayout;
export type CustomLayoutFactory = (delegate: RiffCustomConfig) => RiffLayout;
