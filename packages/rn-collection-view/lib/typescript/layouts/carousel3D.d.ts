/**
 * Carousel3D layout — horizontal cover-flow style. Items are laid out in a
 * straight row but transformed with rotateY based on their distance from the
 * scroll-centre, with perspective foreshortening to give a 3D look.
 *
 * Pure-TypeScript, scroll-driven. One JSI batch per scroll tick.
 *
 * Usage:
 *   <CollectionSubContainer
 *     layout={carousel3D({ itemSize: 220, gap: 24, perspective: 800 })}
 *     data={items}
 *     renderItem={({ item }) => <CardCover item={item} />}
 *     sectionIndex={3}
 *     crossAxisSize={300}
 *   />
 */
import type { RiffLayout } from '../types/protocol';
export interface Carousel3DOptions {
    /** Card width and height (square cards). Default: 220. */
    itemSize?: number;
    /** Spacing between cards along X. Default: 24. */
    gap?: number;
    /** Perspective distance in points. Smaller = more dramatic. Default: 800. */
    perspective?: number;
    /** Maximum rotation in degrees on either side. Default: 60. */
    maxRotation?: number;
    /**
     * Falloff distance — beyond this many points off-centre the card reaches
     * its full rotation. Default: itemSize * 1.5.
     */
    falloff?: number;
    /** Edge inset on the leading and trailing sides. Default: itemSize. */
    edgeInset?: number;
}
export type Carousel3DFactory = (opts?: Carousel3DOptions) => RiffLayout;
export declare const carousel3D: Carousel3DFactory;
