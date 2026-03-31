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

import type { Rect, Size, Insets } from './geometry';
import type { LayoutAttributes } from './layout';

// ═══════════════════════════════════════════════════════════════
// Layout Protocol
// ═══════════════════════════════════════════════════════════════

/**
 * The core layout engine interface. All built-in and custom layouts implement this.
 *
 * Modelled after UICollectionViewLayout — the layout is query-driven:
 * `prepare()` does upfront work, then spatial queries are cheap.
 * `shouldInvalidate()` lets the layout decide if a bounds change requires recomputation.
 */
export interface CollectionViewLayout {
  /** Human-readable type identifier. */
  readonly type: string;

  /**
   * Called before any queries. Compute and cache positions.
   * For C++ layouts: calls into JSI. For TS layouts: runs in JS.
   */
  prepare(context: LayoutContext): void;

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
  attributesForSupplementary(
    kind: string,
    section: number,
  ): LayoutAttributes | null;

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
  invalidationScope?(
    oldBounds: Rect,
    newBounds: Rect,
  ): InvalidationScope;

  /**
   * Incremental invalidation from a specific item.
   * Called when an item's measured size differs from estimated.
   */
  invalidateFrom?(key: string, context: LayoutContext): void;
}

// ═══════════════════════════════════════════════════════════════
// Layout Context
// ═══════════════════════════════════════════════════════════════

/** Geometry context passed to prepare() and invalidateFrom(). */
export interface LayoutContext {
  /** Container width in points. */
  readonly containerWidth: number;
  /** Container height in points. */
  readonly containerHeight: number;
  /** Current scroll offset. */
  readonly scrollOffset: Readonly<{ x: number; y: number }>;
  /** Section metadata — item counts, supplementary info, insets. */
  readonly sections: readonly SectionInfo[];
  /**
   * Actual measured height for an item, if available.
   * Layout engines should prefer this over delegate estimates when present.
   * Returns undefined for items that haven't been measured yet.
   */
  readonly measuredHeightForItem?: (index: number, section: number) => number | undefined;
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
  readonly size: Readonly<{ width: number; height: number }>;
  readonly alignment: SupplementaryAlignment;
  readonly pinToVisibleBounds: boolean;
  readonly pinBehavior: PinBehavior;
}

export type SupplementaryAlignment = 'top' | 'bottom' | 'leading' | 'trailing';
export type PinBehavior = 'push' | 'overlay';

export interface InvalidationScope {
  readonly type: 'full' | 'fromIndex';
  readonly fromSection?: number;
  readonly fromIndex?: number;
}

// ═══════════════════════════════════════════════════════════════
// Built-in Layout Delegates (strict per-layout contracts)
// ═══════════════════════════════════════════════════════════════

/**
 * List layout — single column vertical layout.
 *
 * Sizing: provide EITHER `itemHeight` (fixed) OR `heightForItem` (variable).
 * If both provided, `heightForItem` takes precedence.
 * If neither, `estimatedItemHeight` is used with measurement.
 *
 * Header/footer sizing follows the same pattern as item sizing.
 */
export interface ListLayoutDelegate {
  // ── Item sizing (one of these) ──
  /** Fixed height for all items, or a function of container width. Fast path — no measurement needed. */
  itemHeight?: number | ((containerWidth: number) => number);
  /** Estimated height for variable-height items. Items will be measured after render. */
  estimatedItemHeight?: number;
  /** Per-item height callback. Called only for items in the windowed range.
   *  `containerWidth` lets the consumer compute aspect-ratio or breakpoint-based heights. */
  heightForItem?: (index: number, section: number, containerWidth: number) => number;

  // ── Header sizing ──
  headerHeight?: number;
  estimatedHeaderHeight?: number;
  heightForHeader?: (sectionIndex: number) => number;

  // ── Footer sizing ──
  footerHeight?: number;
  estimatedFooterHeight?: number;
  heightForFooter?: (sectionIndex: number) => number;

  // ── Spacing ──
  itemSpacing?: number;

  // ── Sticky behavior (layout knows how to pin in linear coordinates) ──
  stickyMode?: StickyMode;
}

/**
 * Masonry layout — fixed columns, variable-height items, shortest-column placement.
 *
 * `columns` and `heightForItem` are MANDATORY — masonry can't work without them.
 * Width is derived from container width and column count.
 */
export interface MasonryLayoutDelegate {
  /** Number of columns, or a function of container width for responsive layouts. Mandatory. */
  columns: number | ((containerWidth: number) => number);
  /** Per-item height callback. Mandatory. Called only for items in the windowed range.
   *  `containerWidth` lets the consumer compute aspect-ratio heights. */
  heightForItem: (index: number, section: number, containerWidth: number) => number;

  // ── Header/footer sizing ──
  headerHeight?: number;
  heightForHeader?: (sectionIndex: number) => number;
  footerHeight?: number;
  heightForFooter?: (sectionIndex: number) => number;

  // ── Spacing ──
  columnSpacing?: number;
  rowSpacing?: number;

  stickyMode?: StickyMode;
}

/**
 * Grid layout — fixed columns, row-aligned heights.
 *
 * Provide EITHER `rowHeight` (uniform rows) OR `heightForItem` (row height = tallest in row).
 * Width is derived from container width and column count.
 */
export interface GridLayoutDelegate {
  /** Number of columns, or a function of container width for responsive layouts. Mandatory. */
  columns: number | ((containerWidth: number) => number);

  /** Fixed row height, or a function of container width (e.g. aspect-ratio cards). All rows same height. */
  rowHeight?: number | ((containerWidth: number) => number);
  /** Per-item height for dynamic rows. Row height = max(items in row).
   *  `containerWidth` lets the consumer compute aspect-ratio heights. */
  heightForItem?: (index: number, section: number, containerWidth: number) => number;

  // ── Header/footer sizing ──
  headerHeight?: number;
  heightForHeader?: (sectionIndex: number) => number;
  footerHeight?: number;
  heightForFooter?: (sectionIndex: number) => number;

  // ── Spacing ──
  columnSpacing?: number;
  rowSpacing?: number;

  stickyMode?: StickyMode;
}

/**
 * Flow layout — dynamic columns based on item dimensions, wraps to next line.
 *
 * `sizeForItem` is MANDATORY — flow layout needs both width and height to
 * decide how many items fit per row. Items pack left-to-right, wrapping when
 * the next item wouldn't fit.
 */
export interface FlowLayoutDelegate {
  /** Per-item size callback. Mandatory. Returns both width and height.
   *  `containerWidth` lets the consumer derive proportional widths or aspect-ratio heights. */
  sizeForItem: (index: number, section: number, containerWidth: number) => Readonly<{ width: number; height: number }>;

  // ── Header/footer sizing ──
  headerHeight?: number;
  heightForHeader?: (sectionIndex: number) => number;
  footerHeight?: number;
  heightForFooter?: (sectionIndex: number) => number;

  // ── Spacing ──
  itemSpacing?: number;
  lineSpacing?: number;

  stickyMode?: StickyMode;
}

/**
 * Custom layout — full control. Per-item attribute function.
 *
 * The layout calls `attributesForItem` however it wants internally.
 * No stickyMode — custom layouts handle their own pinning via
 * `attributesForSupplementary` on the CollectionViewLayout interface.
 */
export interface CustomLayoutDelegate {
  /**
   * Compute layout attributes for a single item.
   * Called per-index for items in the windowed range.
   */
  attributesForItem: (
    index: number,
    section: number,
    context: LayoutContext,
  ) => LayoutAttributes;
}

export type StickyMode = 'push' | 'overlay' | 'none';

// ═══════════════════════════════════════════════════════════════
// Supplementary Items (Tier 3 power-user API)
// ═══════════════════════════════════════════════════════════════

/**
 * Full supplementary item definition.
 * Used in Tier 3 when the consumer needs custom supplementary views
 * beyond standard headers/footers.
 */
export interface SupplementaryItem {
  /** Kind identifier. 'header' and 'footer' are reserved for standard use. */
  kind: string;
  /** Render function for this supplementary view. */
  render: () => React.ReactElement;
  /** Size of the supplementary view. 'full' for width = container width. */
  size: Readonly<{ width: number | 'full'; height: number }>;
  /** Where this view is positioned relative to the section. */
  alignment: SupplementaryAlignment;
  /** Whether this view pins to visible bounds during scroll. */
  pinToVisibleBounds?: boolean;
  /** How pinned views interact: 'push' = next pushes current, 'overlay' = stack. */
  pinBehavior?: PinBehavior;
  /** Z-ordering override. */
  zIndex?: number;
}

// ═══════════════════════════════════════════════════════════════
// Section Config (consumer-facing, supports all 3 tiers)
// ═══════════════════════════════════════════════════════════════

/**
 * Section configuration — combines data with layout metadata.
 *
 * Tier 1: Use `header`/`footer` shorthand for simple cases.
 * Tier 3: Use `supplementaryItems` for custom supplementary views.
 * Both can coexist — `header`/`footer` are additive, not exclusive.
 */
export interface SectionConfig<T> {
  /** Stable section key. */
  key: string;
  /** Data items for this section. */
  data: T[];
  /** Section-level insets. */
  insets?: Insets;

  // ── Tier 1: Simple header/footer shorthand ──
  header?: {
    render: () => React.ReactElement;
    height: number;
    sticky?: boolean;
  };
  footer?: {
    render: () => React.ReactElement;
    height: number;
    sticky?: boolean;
  };

  // ── Tier 3: Full supplementary items (additive with header/footer) ──
  supplementaryItems?: SupplementaryItem[];

  // ── Decoration ──
  background?: (sectionIndex: number) => React.ReactElement;
}

// ═══════════════════════════════════════════════════════════════
// CollectionView Props (consumer-facing component API)
// ═══════════════════════════════════════════════════════════════

/**
 * CollectionView component props.
 *
 * Tier 1: Just `data` + `renderItem` + simple props.
 * Tier 2: Add `layout` for non-default layouts.
 * Tier 3: Full `sections` with supplementary items.
 */
export interface CollectionViewProps<T> {
  // ── Data (one of these) ──
  /** Single-section convenience. Wraps in one section internally. */
  data?: T[];
  /** Multi-section data. */
  sections?: SectionConfig<T>[];

  // ── Layout ──
  /** Layout engine. Defaults to list layout if omitted. */
  layout?: CollectionViewLayout;

  // ── Rendering ──
  renderItem: (info: {
    item: T;
    index: number;
    section: number;
  }) => React.ReactElement;
  keyExtractor?: (item: T, index: number) => string;

  /** Section header renderer — called for each section that has a header. */
  renderSectionHeader?: (info: { sectionIndex: number }) => React.ReactElement;
  /** Section footer renderer — called for each section that has a footer. */
  renderSectionFooter?: (info: { sectionIndex: number }) => React.ReactElement;

  // ── Tier 1 shortcuts (when using default list layout) ──
  /** Fixed item height — fast path, no measurement. */
  itemHeight?: number;
  /** Estimated item height — variable height with measurement. */
  estimatedItemHeight?: number;
  /** Pin items at these indices to top during scroll (single-section mode). */
  stickyHeaderIndices?: number[];
  /** Pin items at these indices to bottom during scroll (single-section mode). */
  stickyFooterIndices?: number[];

  // ── Prefetch ──
  onPrefetch?: (keys: string[]) => void;
  prefetchDistance?: number;

  // ── Memory ──
  mountedWindowSize?: number;

  // ── Events ──
  onScroll?: (event: { contentOffset: { x: number; y: number } }) => void;
  onRenderCountChange?: (count: number) => void;

  // ── Scroll ──
  scrollViewProps?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// Layout Factory Types
// ═══════════════════════════════════════════════════════════════

/** Factory function signatures for built-in layouts. */
export type ListLayoutFactory = (delegate: ListLayoutDelegate) => CollectionViewLayout;
export type MasonryLayoutFactory = (delegate: MasonryLayoutDelegate) => CollectionViewLayout;
export type GridLayoutFactory = (delegate: GridLayoutDelegate) => CollectionViewLayout;
export type FlowLayoutFactory = (delegate: FlowLayoutDelegate) => CollectionViewLayout;
export type CustomLayoutFactory = (delegate: CustomLayoutDelegate) => CollectionViewLayout;
