/**
 * Grid Layout — fixed columns, row-aligned heights.
 *
 * Backed by the C++ GridLayout engine via JSI.
 * Items placed left-to-right in rows. Each row's height = tallest item in that row
 * (or fixed `rowHeight` if provided — actual height determined by Yoga for dynamic rows).
 *
 * Multi-section support: each section gets its own header/footer/background/separators.
 * The C++ engine writes all LayoutAttributes to the shared LayoutCache.
 * All queries go through the LayoutCache so ShadowNode corrections are immediately visible.
 *
 * Standard JSI contract (mirrors ListLayout):
 *   this._gridEngine.computeSections(sections[])       → void
 *   this._gridEngine.invalidateSectionsFrom(n, [])     → void
 *
 * ─── STABLE KEY RULE (enforce in every layout engine) ────────────────────────
 * One key per item, used identically in ALL three places:
 *   1. C++ LayoutCache write  — uses keys[i] when provided, else "grid-{section}-{index}"
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
import type { RiffLayout, RiffGridConfig } from '../types/protocol';
/**
 * Create a grid layout with the given delegate configuration.
 *
 * ```typescript
 * // Uniform row height (fast path — no measurement per row)
 * layout={grid({ columns: 3, rowHeight: 100, columnSpacing: 8, rowSpacing: 8 })}
 *
 * // Dynamic row height (row height = tallest item in each row)
 * layout={grid({ columns: 3, heightForItem: (i) => heights[i], columnSpacing: 8 })}
 *
 * // Multi-section with sticky headers and section backgrounds
 * layout={grid({
 *   columns: 2,
 *   rowHeight: 120,
 *   headerHeight: 44,
 *   footerHeight: 24,
 *   sectionBackground: true,
 *   stickyMode: 'push',
 * })}
 * ```
 */
export declare function grid(delegate: RiffGridConfig): RiffLayout;
