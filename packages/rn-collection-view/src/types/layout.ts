/**
 * Layout types — the core data model for the layout engine.
 *
 * These types are serialisable (plain objects, no class instances) so they
 * can safely cross the C++↔JS boundary and be stored in the layout cache.
 */

import type { Rect } from './geometry';

// ─── Sizing strategy ─────────────────────────────────────────────────────────

/**
 * How the layout engine determines the size of a cell:
 *
 * - `fixed`      Frame is fully known from config at layout time. No measurement.
 * - `estimated`  A rough size is used for layout; corrected when cell reports its
 *                actual size after first render (position correction applied).
 * - `measured`   C++ layout engine measures the cell synchronously via JSI before
 *                placing it (equivalent to UICollectionView's preferredLayoutAttributes).
 * - `selfSizing` The cell itself calls back with its size after mounting
 *                (equivalent to UICollectionView self-sizing cells with Auto Layout).
 */
export type SizingStrategy = 'fixed' | 'estimated' | 'measured' | 'selfSizing';

/** Tracks whether a cell's layout attributes are final or provisional. */
export type SizingState =
  | 'placeholder'   // estimated size in use, cell not yet measured
  | 'measured'      // final size known, position corrections have been applied
  | 'dirty';        // needs re-measurement (e.g. content changed)

// ─── Window tiers ────────────────────────────────────────────────────────────

/**
 * The 4-tier window model. Derived from AsyncDisplayKit's ASRangeController.
 *
 * C++ window controller classifies every item into one of these tiers and
 * updates them as the user scrolls:
 *
 * - `visible`   Item intersects the viewport. React component fully rendered
 *               and painted. Activity mode="visible" (or mounted & clipped).
 * - `render`    Outside viewport but within the render window (leading × renderMultiplier,
 *               trailing × trailingMultiplier). Component is mounted and its
 *               React tree is alive. On RN 0.83+: Activity mode="hidden"
 *               (skips paint, defers effects). On older new-arch: absolute
 *               position, scroll view clips it — mounted but not visible.
 * - `layout`    Outside render window but within layout window. C++ layout
 *               attributes are computed and cached. No React component mounted.
 * - `data`      Outside layout window but within data window. Data prefetch
 *               callbacks are fired. No layout, no component.
 * - `outside`   Beyond the data window. Nothing allocated.
 */
export type WindowTier = 'visible' | 'render' | 'layout' | 'data' | 'outside';

// ─── Layout attributes ───────────────────────────────────────────────────────

/**
 * Equivalent to UICollectionViewLayoutAttributes.
 *
 * One instance per cell/supplementary view. Immutable snapshot from the
 * layout engine. The C++ LayoutCache stores and retrieves these.
 */
export interface LayoutAttributes {
  /** Stable item key — same as the key prop on the cell component. */
  readonly key: string;

  /** Section index (0-based). */
  readonly section: number;

  /** Item index within its section (0-based). -1 for supplementary views. */
  readonly index: number;

  /**
   * Frame in scroll content coordinates.
   * Origin is top-left of scroll content, y increases downward.
   */
  readonly frame: Rect;

  /**
   * Z-axis ordering. Sticky headers use zIndex > 0. Normal cells use 0.
   * Within the same zIndex, items are rendered in document order.
   */
  readonly zIndex: number;

  /** True for supplementary views (headers, footers, custom kinds). */
  readonly isSupplementary: boolean;

  /**
   * For supplementary views: identifies the kind string
   * (e.g. "header", "footer", "badge", any custom string).
   * Null for regular cells.
   */
  readonly supplementaryKind: string | null;

  /** Whether this item's size has been finalised. */
  readonly sizingState: SizingState;

  /**
   * Whether this item needs layout recalculation.
   * Set to true by the diff engine when an item changes.
   * Cleared by the layout engine after recomputation.
   */
  readonly isDirty: boolean;

  /**
   * Current window tier assignment from the C++ window controller.
   * Updated on every scroll frame.
   */
  readonly tier: WindowTier;

  /**
   * Whether this cell is currently sticky (pinned to viewport top/bottom).
   * Computed per scroll frame by the layout engine.
   */
  readonly isSticky: boolean;

  /** Applied alpha (0–1). Non-visible render cells may use 1 here; Activity handles opacity. */
  readonly alpha: number;

  /** Whether this item is being animated (insertion, deletion, update). */
  readonly isAnimating: boolean;
}

// ─── Section descriptor ──────────────────────────────────────────────────────

/**
 * High-level description of a section, passed to the layout engine.
 * The layout engine expands this into LayoutAttributes per item.
 */
export interface SectionDescriptor {
  readonly sectionIndex: number;
  readonly itemCount: number;
  readonly sizingStrategy: SizingStrategy;
  /** Only used when sizingStrategy === 'fixed'. */
  readonly fixedItemSize?: Readonly<{ width: number; height: number }>;
  /** Only used when sizingStrategy === 'estimated'. */
  readonly estimatedItemSize?: Readonly<{ width: number; height: number }>;
  /** Whether items in this section have a sticky header. */
  readonly hasStickyHeader: boolean;
  readonly headerHeight: number;
  readonly footerHeight: number;
}

// ─── Layout result ───────────────────────────────────────────────────────────

/** Returned by the layout engine for a completed layout pass. */
export interface LayoutResult {
  readonly version: number;
  readonly totalContentSize: Readonly<{ width: number; height: number }>;
  readonly sectionOffsets: readonly number[];
  /** Attributes for all items, sorted by section then index. */
  readonly attributes: readonly LayoutAttributes[];
}
