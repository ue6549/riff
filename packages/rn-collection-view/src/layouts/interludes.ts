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
import { compositional, type CompositionalEntry } from './compositional';

// ── Types ─────────────────────────────────────────────────────────────────────

export type InterleavedAnchor =
  | { afterKey: string }
  | { afterIndex: number }
  | { atKey: 'top' | 'bottom' };

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

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Split a flat primary feed around declared interludes and return the
 * `sections` + `layout` pair ready for CollectionView.
 *
 * Pure function — wrap in `useMemo` with the data arrays as deps.
 */
export function splitInterludes<T>(
  primary: PrimaryConfig<T>,
  interludes: InterleavedSectionConfig[],
): InterleavedResult<T> {
  const { data, keyExtractor, key: primaryKey = 'primary' } = primary;

  // Resolve each interlude's split point: number of primary items before it.
  type Resolved = InterleavedSectionConfig & { splitAfter: number; ordinal: number };
  const resolved: Resolved[] = interludes.map((il, ordinal) => {
    const { anchor } = il;
    let splitAfter: number;
    if ('afterKey' in anchor) {
      const idx = (data as T[]).findIndex(item => keyExtractor(item) === anchor.afterKey);
      splitAfter = idx >= 0 ? idx + 1 : data.length;
    } else if ('afterIndex' in anchor) {
      splitAfter = Math.min(Math.max(anchor.afterIndex + 1, 0), data.length);
    } else {
      splitAfter = anchor.atKey === 'top' ? 0 : data.length;
    }
    return { ...il, splitAfter, ordinal };
  });

  // Stable sort: ascending splitAfter, ties preserve declaration order.
  resolved.sort((a, b) =>
    a.splitAfter !== b.splitAfter ? a.splitAfter - b.splitAfter : a.ordinal - b.ordinal,
  );

  const sections: RiffSection<any>[] = [];
  const entries: CompositionalEntry[] = [];
  let sectionIdx = 0;
  let cursor = 0;

  const pushPrimaryChunk = (end: number) => {
    if (end <= cursor) return;
    sections.push({
      key: `${primaryKey}-chunk-${sectionIdx}`,
      data: (data as T[]).slice(cursor, end),
      header: primary.header as RiffSection<any>['header'],
      footer: primary.footer as RiffSection<any>['footer'],
      insets: primary.insets,
      renderMultiplier: primary.renderMultiplier,
    });
    entries.push({ range: sectionIdx, layout: primary.layout });
    sectionIdx++;
    cursor = end;
  };

  for (const il of resolved) {
    pushPrimaryChunk(il.splitAfter);
    sections.push({
      key: il.key ?? `interlude-${il.ordinal}`,
      data: il.data as any[],
      header: il.header,
      footer: il.footer,
      insets: il.insets,
      renderMultiplier: il.renderMultiplier,
    });
    entries.push({
      range: sectionIdx,
      layout: il.layout,
      horizontal: il.horizontal,
      estimatedSectionHeight: il.estimatedSectionHeight,
    });
    sectionIdx++;
  }

  // Remaining primary items after the last interlude.
  pushPrimaryChunk(data.length);

  return { sections, layout: compositional(entries) };
}
