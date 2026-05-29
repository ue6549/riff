/**
 * CustomLayoutPlugin — the extension point for user-provided layout engines.
 *
 * Plugins compute layout positions in TypeScript and write the results into
 * the C++ LayoutCache via JSI. This gives full layout flexibility in TS
 * while keeping a single source of truth in C++ (spatial index, content size,
 * window controller all read from the same cache).
 *
 * Implementations must be pure with respect to the cache: only write
 * attributes for the sections/keys they own.
 */
import type { LayoutCache } from '../LayoutCache';
/**
 * Geometry context passed to every plugin call.
 * Mirrors the subset of ListLayoutParams the plugin needs.
 */
export interface LayoutPluginContext {
    /** Viewport width in points. */
    readonly viewportWidth: number;
    /** Section index being laid out. */
    readonly section: number;
    /** Number of items in this section. */
    readonly itemCount: number;
    /** Y offset where this section starts (from the previous section's end). */
    readonly sectionStartY: number;
    /** Arbitrary extra data the host passes through (e.g. column count). */
    readonly extra?: unknown;
}
/**
 * Interface for pluggable layout engines.
 *
 * A plugin is responsible for writing LayoutAttributes into the cache for
 * all items in the sections it claims. The collection view will not touch
 * those sections itself.
 *
 * Usage:
 * ```ts
 * const gridPlugin: CustomLayoutPlugin = {
 *   compute(ctx, cache) { ... },
 * };
 * ```
 */
export interface CustomLayoutPlugin {
    /**
     * Full layout pass for the section described by `ctx`.
     * Write LayoutAttributes for each item into `cache`.
     * Called when the section is first loaded or fully invalidated.
     */
    compute(ctx: LayoutPluginContext, cache: LayoutCache): void;
    /**
     * Partial re-layout from `key` onward (optional).
     * If absent, the host falls back to calling `compute` for the full section.
     * Implement for O(n-pivot) invalidation instead of O(n).
     */
    invalidateFrom?(key: string, ctx: LayoutPluginContext, cache: LayoutCache): void;
    /**
     * Optional: return the total content height for the section so the host
     * can compute section offsets without scanning the cache.
     * If absent, the host derives it from getTotalContentSize().
     */
    sectionContentHeight?(ctx: LayoutPluginContext): number;
}
