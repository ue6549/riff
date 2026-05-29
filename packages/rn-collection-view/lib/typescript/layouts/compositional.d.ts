/**
 * Compositional Layout — per-section layout types within a single CollectionView.
 *
 * Each section can independently use list, grid, flow, or masonry layout.
 * All sections share one scroll context, one LayoutCache, and one processScroll call —
 * no nested scroll views, no competing gesture recognizers, one recycling pool.
 *
 * Phase 1: Vertical scroll only. Phase 2 (follow-up): native orthogonal sections.
 *
 * API:
 *   layout={compositional([
 *     { range: [0, 0], layout: list({ estimatedItemHeight: 200 }) },
 *     { range: [1, 1], layout: grid({ columns: 4, rowHeight: 80 }) },
 *     { range: [2, 2], layout: flow({ sizeForItem: tagSize }) },
 *     { range: [3, 3], layout: masonry({ columns: 2, heightForItem: h }) },
 *   ])}
 *
 * Range shorthand: `{ range: 3 }` = `{ range: [3, 3] }` (single section).
 * Last entry's layout repeats for sections beyond those explicitly listed.
 *
 * ─── STABLE KEY RULE ─────────────────────────────────────────────────────────
 * Each sub-layout type uses its own LayoutCache prefix:
 *   list    → "item-{section}-{index}"
 *   grid    → "grid-{section}-{index}"
 *   flow    → "flow-{section}-{index}"
 *   masonry → "masonry-{section}-{index}"
 * Sections from different layout types naturally have non-colliding keys.
 * CollectionView.tsx uses keyPrefixForSection() to derive the right prefix.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { RiffLayout } from '../types/protocol';
/** Single section index or an inclusive [from, to] range. */
export type SectionRange = number | [number, number];
/** Maps a section range to a layout engine. */
export interface CompositionalEntry {
    range: SectionRange;
    layout: RiffLayout;
    /**
     * Phase 2: set `horizontal: true` to make this section scroll horizontally.
     * The section is rendered inside `RNOrthogonalSectionView` (a UIScrollView)
     * with native momentum, directional lock, and H-axis item clipping.
     * Default: false (vertical, same as all Phase 1 sections).
     */
    horizontal?: boolean;
    /**
     * For H-sections only: the height this section occupies in the outer vertical scroll.
     * - Flow H: required (or estimated from first item height). Controls how many rows of items fit.
     * - Grid / List / Masonry H: optional override; defaults to estimatedCrossAxisHeight from delegate.
     */
    estimatedSectionHeight?: number;
}
/** Post-prepare metadata for an H-section (horizontal=true entry). */
export interface HSectionMeta {
    sectionY: number;
    sectionHeight: number;
    flatBase: number;
    itemCount: number;
    contentWidth: number;
}
/**
 * Create a compositional layout with per-section layout types.
 *
 * ```typescript
 * layout={compositional([
 *   { range: 0,      layout: list({ estimatedItemHeight: 200 }) },
 *   { range: 1,      layout: grid({ columns: 4, rowHeight: 80 }) },
 *   { range: [2, 3], layout: flow({ sizeForItem: tagSize }) },
 *   { range: 4,      layout: masonry({ columns: 2, heightForItem: h }) },
 * ])}
 * ```
 *
 * Last entry repeats for any sections beyond those explicitly listed.
 */
export declare function compositional(entries: CompositionalEntry[]): RiffLayout;
