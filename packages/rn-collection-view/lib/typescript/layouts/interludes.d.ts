/**
 * splitInterludes — build `sections` + `layout` from a flat primary feed with
 * inline special sections (carousels, banners, grids) anchored at specific points.
 *
 * Replaces the manual "slice your 200 posts into N arrays and create N+M sections"
 * bookkeeping. The primary feed stays as one flat array; interludes are declared
 * separately with an anchor position. The splitter produces the `sections` array
 * and a `compositional` layout that CollectionView consumes directly.
 *
 * Usage:
 * ```tsx
 * const { sections, layout } = useMemo(() => splitInterludes(
 *   {
 *     layout: list({ estimatedItemHeight: 80 }),
 *     data: posts,
 *     keyExtractor: p => p.id,
 *   },
 *   [
 *     {
 *       anchor: { afterKey: 'post-7' },  // or { afterIndex: 7 } or { atKey: 'top'|'bottom' }
 *       layout: list({ horizontal: true }),
 *       data: stories,
 *       horizontal: true,
 *     },
 *     {
 *       anchor: { afterIndex: 14 },
 *       layout: grid({ columns: 2 }),
 *       data: ads,
 *     },
 *   ],
 * ), [posts, stories, ads]);
 *
 * <CollectionView sections={sections} layout={layout} renderItem={renderItem} />
 * ```
 *
 * Anchor semantics:
 *   afterKey: 'k'       — after the primary item whose keyExtractor returns 'k'.
 *                         Survives inserts/deletes that shift indices.
 *                         Falls back to end-of-feed if the key is absent.
 *   afterIndex: N       — after primary item at 0-based index N (fixed position).
 *   atKey: 'top'        — prepended before the first primary item.
 *   atKey: 'bottom'     — appended after the last primary item.
 *
 * Multiple interludes at the same anchor are placed in declaration order.
 *
 * All primary chunks share the same layout, header, footer, and insets from
 * PrimaryConfig. For per-chunk variation use the explicit compositional([...]) API.
 */
import type { RiffLayout, RiffSection } from '../types/protocol';
export type InterleavedAnchor = {
    afterKey: string;
} | {
    afterIndex: number;
} | {
    atKey: 'top' | 'bottom';
};
export interface PrimaryConfig<T = any> {
    /** Layout engine for every primary chunk (list, grid, flow, or masonry). */
    layout: RiffLayout;
    /** The flat data array. */
    data: readonly T[];
    /** Key extractor used to resolve `afterKey` anchors. */
    keyExtractor: (item: T) => string;
    /** Stable key prefix for generated chunk sections. Default: 'primary'. */
    key?: string;
    /** Applied uniformly to every primary chunk section. */
    header?: RiffSection<T>['header'];
    footer?: RiffSection<T>['footer'];
    insets?: RiffSection<T>['insets'];
    renderMultiplier?: number;
}
export interface InterleavedSectionConfig<I = any> {
    /** Where in the primary feed this section is anchored. */
    anchor: InterleavedAnchor;
    /** Layout engine for this interlude section. */
    layout: RiffLayout;
    /** Data items for this interlude section. */
    data: readonly I[];
    /** Stable key for this section. Default: 'interlude-{ordinal}'. */
    key?: string;
    /** Set true for a horizontally-scrolling interlude (H carousel, etc.). */
    horizontal?: boolean;
    estimatedSectionHeight?: number;
    header?: RiffSection<I>['header'];
    footer?: RiffSection<I>['footer'];
    insets?: RiffSection<I>['insets'];
    renderMultiplier?: number;
}
export interface InterleavedResult<T = any> {
    /** Pass directly to CollectionView `sections` prop. */
    sections: RiffSection<T | any>[];
    /** Pass directly to CollectionView `layout` prop. */
    layout: RiffLayout;
}
/**
 * Split a flat primary feed around declared interludes and return the
 * `sections` + `layout` pair ready for CollectionView.
 *
 * Pure function — wrap in `useMemo` with the data arrays as deps.
 */
export declare function splitInterludes<T>(primary: PrimaryConfig<T>, interludes: InterleavedSectionConfig[]): InterleavedResult<T>;
