/**
 * List Layout — single-column vertical layout factory.
 *
 * Creates a RiffLayout backed by the C++ ListLayout engine.
 * Supports fixed height, estimated height with measurement, and per-item height callback.
 *
 * C++ layout writes to the shared LayoutCache. Spatial queries via getAttributesInRect.
 *
 * ─── STABLE KEY RULE (enforce in every layout engine) ────────────────────────
 * One key per item, used identically in ALL three places:
 *   1. C++ LayoutCache write  — uses keys[i] when provided, else "{type}-{section}-{index}"
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
import type { RiffLayout, RiffListConfig } from '../types/protocol';
/**
 * Create a list layout with the given delegate configuration.
 *
 * ```typescript
 * layout={list({ itemHeight: 44 })}
 * layout={list({ estimatedItemHeight: 60, stickyMode: 'push' })}
 * layout={list({ heightForItem: (i, s) => heights[i], itemSpacing: 8 })}
 * ```
 */
export declare function list(delegate: RiffListConfig): RiffLayout;
