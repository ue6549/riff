/**
 * Layout types — the core data model for the layout engine.
 *
 * These types are serialisable (plain objects, no class instances) so they
 * can safely cross the C++↔JS boundary and be stored in the layout cache.
 */
import type { Rect } from './geometry';
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
export type SizingState = 'placeholder' | 'measured' | 'dirty';
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
    /**
     * True for decoration views emitted by the layout engine (e.g. section
     * backgrounds, separators). Decoration views have no data backing — their
     * frames are fully determined by the layout engine.
     */
    readonly isDecoration?: boolean;
    /**
     * For decoration views: identifies the kind.
     * "sectionBackground" | "separator" (or any custom string from a custom layout).
     */
    readonly decorationKind?: string;
    /**
     * Opacity in [0, 1]. When omitted, defaults to 1. The sub-container view
     * skips assigning child.alpha when this is 1 to avoid no-op CALayer dirties.
     * Distinct from the old `alpha` field above which is a layout-internal hint;
     * sub-containers read this for visual application.
     */
    readonly opacity?: number;
    /**
     * 4x4 column-major transform matrix (16 floats). Defaults to identity.
     * Layout: [m11,m12,m13,m14, m21,m22,m23,m24, m31,m32,m33,m34, m41,m42,m43,m44]
     * Matches CATransform3D's column-major layout for a direct memcpy on iOS.
     *
     * Common builders (compose left-to-right):
     *   identity    = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
     *   translate   = [1,0,0,0, 0,1,0,0, 0,0,1,0, tx,ty,tz,1]
     *   scale(s)    = [s,0,0,0, 0,s,0,0, 0,0,s,0, 0,0,0,1]
     *   perspective = [1,0,0,0, 0,1,0,0, 0,0,1,-1/d, 0,0,0,1]
     *
     * The sub-container view skips assigning layer.transform when this matrix
     * equals identity to avoid re-rasterisation cost.
     */
    readonly transform?: Readonly<[
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number
    ]>;
    /**
     * Anchor point for the transform. Default (0.5, 0.5) — centre of the cell's
     * bounds. Layouts can override (e.g. (0, 0.5) for left-edge rotation).
     */
    readonly anchorPoint?: Readonly<{
        x: number;
        y: number;
    }>;
}
/**
 * High-level description of a section, passed to the layout engine.
 * The layout engine expands this into LayoutAttributes per item.
 */
export interface SectionDescriptor {
    readonly sectionIndex: number;
    readonly itemCount: number;
    readonly sizingStrategy: SizingStrategy;
    /** Only used when sizingStrategy === 'fixed'. */
    readonly fixedItemSize?: Readonly<{
        width: number;
        height: number;
    }>;
    /** Only used when sizingStrategy === 'estimated'. */
    readonly estimatedItemSize?: Readonly<{
        width: number;
        height: number;
    }>;
    /** Whether items in this section have a sticky header. */
    readonly hasStickyHeader: boolean;
    readonly headerHeight: number;
    readonly footerHeight: number;
}
/** Returned by the layout engine for a completed layout pass. */
export interface LayoutResult {
    readonly version: number;
    readonly totalContentSize: Readonly<{
        width: number;
        height: number;
    }>;
    readonly sectionOffsets: readonly number[];
    /** Attributes for all items, sorted by section then index. */
    readonly attributes: readonly LayoutAttributes[];
}
