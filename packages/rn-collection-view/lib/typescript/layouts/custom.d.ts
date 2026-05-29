/**
 * Custom Layout — full-control layout for power users.
 *
 * The consumer provides `attributesForItem` which computes layout attributes
 * for each item. Supports arbitrary positioning, transforms, opacity, z-ordering.
 *
 * Used for layouts that don't fit built-in patterns: circular, carousel, 3D, etc.
 */
import type { RiffLayout, RiffCustomConfig } from '../types/protocol';
/**
 * Create a custom layout with the given delegate configuration.
 *
 * ```typescript
 * layout={customLayout({
 *   attributesForItem: (index, section, context) => ({
 *     key: `item-${index}`,
 *     section,
 *     index,
 *     frame: { x: ..., y: ..., width: ..., height: ... },
 *     zIndex: computeDepth(index, context),
 *   }),
 * })}
 * ```
 */
export declare function customLayout(delegate: RiffCustomConfig): RiffLayout;
