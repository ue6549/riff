/**
 * TypeScript wrapper around the C++ LayoutCache JSI object.
 *
 * The native module exposes a `layoutCache` property which is a plain JSI
 * object with methods installed by LayoutCache::installJSIBindings().
 * This class wraps it with proper types.
 */
import type { Rect, Size, LayoutAttributes } from './types';
export declare class LayoutCache {
    private readonly _native;
    constructor();
    /** Insert or replace attributes for an item. O(1) amortised. */
    setAttributes(attrs: LayoutAttributes): void;
    /** Retrieve attributes by item key. O(1). Returns null if not found. */
    getAttributes(key: string): LayoutAttributes | null;
    /** Remove an item from the cache. O(n) due to insertion-order maintenance. */
    removeAttributes(key: string): void;
    /** All attributes in insertion (layout) order. */
    getAll(): LayoutAttributes[];
    /**
     * Rect-based spatial query — returns all items whose frame intersects rect.
     * This is the primary interface for the window controller.
     * 2D-ready: works for both vertical and horizontal scroll.
     */
    getAttributesInRect(rect: Rect): LayoutAttributes[];
    /** Total scroll content size derived from the union of all frames. */
    getTotalContentSize(): Size;
    /**
     * Y offset of each section's first item.
     * Used by the window controller for fast section-level queries.
     */
    getSectionOffsets(): number[];
    /** Clear all attributes. */
    clear(): void;
    /**
     * Monotonically increasing version number.
     * Incremented on every mutation. Use to detect cache staleness
     * without diffing attribute contents.
     */
    get version(): number;
}
/** Singleton for the collection view's primary layout cache. */
export declare const layoutCache: LayoutCache;
