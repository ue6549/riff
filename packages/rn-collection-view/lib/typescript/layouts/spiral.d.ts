/**
 * Spiral layout — items arranged on an Archimedean spiral. Vertical scroll
 * unwinds (or rewinds) the spiral by adding a phase offset, so items appear
 * to spiral outward from the centre.
 *
 * Pure-TypeScript, scroll-driven. One JSI batch per scroll tick.
 *
 * Usage:
 *   <CollectionSubContainer
 *     layout={spiral({ a: 8, b: 12, itemSize: 60, scrollPerRevolution: 800 })}
 *     data={items}
 *     renderItem={({ item }) => <Bubble item={item} />}
 *     sectionIndex={4}
 *     crossAxisSize={500}
 *   />
 */
import type { RiffLayout } from '../types/protocol';
export interface SpiralOptions {
    /** Spiral starting radius in points. r = a + b * theta. Default: 8. */
    a?: number;
    /** Radial growth per radian. Bigger = looser spiral. Default: 12. */
    b?: number;
    /** Angular spacing between items in radians. Default: 0.5. */
    angularStep?: number;
    /** Item width and height (square). Default: 60. */
    itemSize?: number;
    /** Vertical scroll → angular phase mapping. Default: 800 (px/revolution). */
    scrollPerRevolution?: number;
    /** Vertical scroll budget. Default: 5 viewports. */
    scrollHeight?: number;
    /** Top inset above the spiral centre. Default: 80. */
    topInset?: number;
    /**
     * Minimum scale at the centre of the spiral (innermost items). Default: 0.4.
     * Outer items are scale 1.
     */
    minScale?: number;
}
export type SpiralFactory = (opts?: SpiralOptions) => RiffLayout;
export declare const spiral: SpiralFactory;
