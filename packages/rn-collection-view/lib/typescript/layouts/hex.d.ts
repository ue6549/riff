/**
 * Hex layout — honeycomb tiling. Static (no scroll-driven recomputation).
 * Items are placed on an offset grid where every other row is shifted by
 * half a hex width.
 *
 * NOTE: shipped as TypeScript today for parity with radial/spiral/carousel3D.
 * A C++ port (HexLayoutEngine + registerLayoutEngine + TS shim) is a planned
 * follow-up to demonstrate native custom layouts using the same H-2 framework.
 *
 * Usage:
 *   <CollectionSubContainer
 *     layout={hex({ hexSize: 56 })}
 *     data={items}
 *     renderItem={({ item }) => <HexCell item={item} />}
 *     sectionIndex={5}
 *     scrollDirection="none"
 *     crossAxisSize={400}
 *   />
 */
import type { RiffLayout } from '../types/protocol';
export interface HexOptions {
    /** Edge-to-edge size of a hex cell. Default: 64. */
    hexSize?: number;
    /** Horizontal padding around the tiling. Default: 8. */
    paddingX?: number;
    /** Vertical padding above the tiling. Default: 8. */
    paddingY?: number;
    /** Spacing between hexes. Default: 4. */
    gap?: number;
}
export type HexFactory = (opts?: HexOptions) => RiffLayout;
export declare const hex: HexFactory;
