/**
 * Flow Layout — variable-width items, greedy bin-packing, wraps to next line.
 *
 * Backed by the C++ FlowLayout engine via JSI.
 * V-mode: items pack left-to-right, wrap when next item doesn't fit row width.
 * H-mode: items pack top-to-bottom, wrap when next item doesn't fit column height.
 * Row height (V) / column width (H) = max cross-axis size of items in that row/column.
 *
 * `sizeForItem` is mandatory — flow layout needs both width and height for bin-packing.
 *
 * Multi-section support: each section gets its own header/footer/background/separators.
 * The C++ engine writes all LayoutAttributes to the shared LayoutCache.
 * All queries go through the LayoutCache so ShadowNode corrections are immediately visible.
 *
 * Standard JSI contract (mirrors GridLayout):
 *   this._flowEngine.computeSections(sections[])       → void
 *   this._flowEngine.invalidateSectionsFrom(n, [])     → void
 *
 * ─── STABLE KEY RULE (enforce in every layout engine) ────────────────────────
 * One key per item, used identically in ALL three places:
 *   1. C++ LayoutCache write  — uses keys[i] when provided, else "flow-{section}-{index}"
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
import type { RiffLayout, RiffFlowConfig } from '../types/protocol';
/**
 * Create a flow layout with the given delegate configuration.
 *
 * ```typescript
 * // Vertical flow — tag cloud
 * layout={flow({
 *   sizeForItem: (index) => ({ width: tagWidths[index], height: 34 }),
 *   itemSpacing: 8,
 *   lineSpacing: 8,
 *   headerHeight: 44,
 *   stickyMode: 'push',
 * })}
 *
 * // Horizontal flow — items pack top→bottom into columns
 * layout={flow({
 *   horizontal: true,
 *   sizeForItem: (index) => ({ width: 80, height: tagHeights[index] }),
 *   itemSpacing: 6,
 *   lineSpacing: 12,
 * })}
 * ```
 */
export declare function flow(delegate: RiffFlowConfig): RiffLayout;
