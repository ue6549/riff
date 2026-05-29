/**
 * Masonry Layout — fixed-column, variable-height, shortest-column placement.
 *
 * Backed by the C++ MasonryLayout engine via JSI.
 * `columns` is mandatory. Provide `heightForItem` for known heights, or `estimatedItemHeight`
 * to let Yoga measure actual heights (default: 44).
 *
 * Multi-section support: each section gets its own header/footer/background/separators.
 * The C++ engine writes all LayoutAttributes to the shared LayoutCache.
 * All queries go through the LayoutCache so ShadowNode corrections are immediately visible.
 *
 * Standard JSI contract (mirrors GridLayout):
 *   this._masonryEngine.computeSections(sections[])       → void
 *   this._masonryEngine.invalidateSectionsFrom(n, [])     → void
 *
 * ─── STABLE KEY RULE (enforce in every layout engine) ────────────────────────
 * One key per item, used identically in ALL three places:
 *   1. C++ LayoutCache write  — uses keys[i] when provided, else "masonry-{section}-{index}"
 *   2. TS attributesForItem() — reads from lastSectionKeys[section][index] (same key)
 *   3. CollectionView.tsx cacheKey — derived from layoutContext.sections[s].itemKeys[i]
 *
 * Identity keys from keyExtractor flow as:
 *   keyExtractor → layoutContext.sections[s].itemKeys → prepare() keys[] → C++ → TS read
 *
 * Violation = silent rendering failures (wrong width, lost measurements, broken sticky).
 * See docs/COLLECTIONVIEW_INTERNALS.md "RULE: Stable Key Consistency" for full details.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { RiffLayout, RiffMasonryConfig } from '../types/protocol';
/**
 * Create a masonry layout with the given delegate configuration.
 *
 * ```typescript
 * // Vertical masonry — 2 columns, variable height
 * layout={masonry({
 *   columns: 2,
 *   heightForItem: (index, section, w) => imageHeights[index],
 *   columnSpacing: 8,
 *   rowSpacing: 8,
 *   headerHeight: 44,
 *   stickyMode: 'push',
 * })}
 *
 * // Horizontal masonry — 3 rows, variable width
 * layout={masonry({
 *   horizontal: true,
 *   columns: 3,
 *   heightForItem: (index, section, w) => 0, // unused in H-mode
 *   estimatedCrossAxisHeight: 150,
 * })}
 * ```
 */
export declare function masonry(delegate: RiffMasonryConfig): RiffLayout;
