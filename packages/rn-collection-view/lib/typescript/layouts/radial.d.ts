/**
 * Radial layout — items arranged on a circle. Vertical scroll drives rotation
 * around the centre. Items further from the "front" (the viewport-bottom point
 * on the circle) get smaller and more transparent.
 *
 * This is a pure-TypeScript reference layout shipped with the framework.
 * Per scroll tick: 1 JSI round-trip via `setAttributesBatch` for all items.
 *
 * Usage:
 *   <CollectionSubContainer
 *     layout={radial({ radius: 140, itemSize: 80, scrollPerRevolution: 600 })}
 *     data={items}
 *     renderItem={({ item }) => <Card item={item} />}
 *     sectionIndex={2}
 *     crossAxisSize={360}
 *   />
 */
import type { RiffLayout } from '../types/protocol';
export interface RadialOptions {
    /** Radius of the item circle in points. Default: 140. */
    radius?: number;
    /** Item width and height in points. Default: 80. */
    itemSize?: number;
    /**
     * How much vertical scroll equals one full revolution of the circle (points).
     * Bigger = slower rotation. Default: 600.
     */
    scrollPerRevolution?: number;
    /** Total scrollable height (controls scroll budget). Default: 4 viewports. */
    scrollHeight?: number;
    /** Cross-axis (vertical) padding above the circle. Default: 40. */
    topInset?: number;
    /**
     * Minimum scale at the back of the circle. Items at the front are scale 1.
     * Default: 0.55.
     */
    minScale?: number;
    /**
     * Minimum opacity at the back of the circle. Items at the front are opaque.
     * Default: 0.35.
     */
    minOpacity?: number;
}
export type RadialLayoutFactory = (opts?: RadialOptions) => RiffLayout;
export declare const radial: RadialLayoutFactory;
