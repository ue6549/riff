/**
 * Core geometry primitives.
 * Matches UIKit/CoreGraphics conventions (origin top-left, y increases downward).
 */
export interface Point {
    readonly x: number;
    readonly y: number;
}
export interface Size {
    readonly width: number;
    readonly height: number;
}
export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}
export interface Insets {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
}
export declare function rectContainsPoint(rect: Rect, point: Point): boolean;
export declare function rectsIntersect(a: Rect, b: Rect): boolean;
export declare function rectUnion(a: Rect, b: Rect): Rect;
export declare function rectInsetBy(rect: Rect, insets: Insets): Rect;
export declare function rectOffset(rect: Rect, dx: number, dy: number): Rect;
export declare const ZERO_POINT: Point;
export declare const ZERO_SIZE: Size;
export declare const ZERO_RECT: Rect;
export declare const ZERO_INSETS: Insets;
