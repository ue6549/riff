"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.splitInterludes = splitInterludes;
var _compositional = require("./compositional");
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

// ── Types ─────────────────────────────────────────────────────────────────────

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Split a flat primary feed around declared interludes and return the
 * `sections` + `layout` pair ready for CollectionView.
 *
 * Pure function — wrap in `useMemo` with the data arrays as deps.
 */
function splitInterludes(primary, interludes) {
  const {
    data,
    keyExtractor,
    key: primaryKey = 'primary'
  } = primary;

  // Resolve each interlude's split point: number of primary items before it.

  const resolved = interludes.map((il, ordinal) => {
    const {
      anchor
    } = il;
    let splitAfter;
    if ('afterKey' in anchor) {
      const idx = data.findIndex(item => keyExtractor(item) === anchor.afterKey);
      splitAfter = idx >= 0 ? idx + 1 : data.length;
    } else if ('afterIndex' in anchor) {
      splitAfter = Math.min(Math.max(anchor.afterIndex + 1, 0), data.length);
    } else {
      splitAfter = anchor.atKey === 'top' ? 0 : data.length;
    }
    return {
      ...il,
      splitAfter,
      ordinal
    };
  });

  // Stable sort: ascending splitAfter, ties preserve declaration order.
  resolved.sort((a, b) => a.splitAfter !== b.splitAfter ? a.splitAfter - b.splitAfter : a.ordinal - b.ordinal);
  const sections = [];
  const entries = [];
  let sectionIdx = 0;
  let cursor = 0;
  const pushPrimaryChunk = end => {
    if (end <= cursor) return;
    sections.push({
      key: `${primaryKey}-chunk-${sectionIdx}`,
      data: data.slice(cursor, end),
      header: primary.header,
      footer: primary.footer,
      insets: primary.insets,
      renderMultiplier: primary.renderMultiplier
    });
    entries.push({
      range: sectionIdx,
      layout: primary.layout
    });
    sectionIdx++;
    cursor = end;
  };
  for (const il of resolved) {
    pushPrimaryChunk(il.splitAfter);
    sections.push({
      key: il.key ?? `interlude-${il.ordinal}`,
      data: il.data,
      header: il.header,
      footer: il.footer,
      insets: il.insets,
      renderMultiplier: il.renderMultiplier
    });
    entries.push({
      range: sectionIdx,
      layout: il.layout,
      horizontal: il.horizontal,
      estimatedSectionHeight: il.estimatedSectionHeight
    });
    sectionIdx++;
  }

  // Remaining primary items after the last interlude.
  pushPrimaryChunk(data.length);
  return {
    sections,
    layout: (0, _compositional.compositional)(entries)
  };
}
//# sourceMappingURL=interludes.js.map