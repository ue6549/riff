/**
 * Window configuration — the full public API for tuning the C++ window controller.
 *
 * Matches §11.5 in REQUIREMENTS.md.
 * "Logic native, configuration JS" — all values here are passed to C++ at runtime
 * via the configure(config) JSI method. Nothing is hardcoded in C++.
 */
export interface MemoryPressureOverride {
    /**
     * Render window shrinks to this multiplier under memory pressure.
     * Should be < normal renderMultiplier.
     */
    renderMultiplier: number;
    /**
     * Maximum mounted cell count under memory pressure.
     * Should be < normal mountedCellBudget.
     */
    mountedCellBudget: number;
}
export interface WindowConfig {
    /**
     * How many viewport heights ahead (leading direction) to render.
     * Cells in the render window are mounted React components.
     * Default: 3
     */
    renderMultiplier: number;
    /**
     * Trailing render window (behind scroll direction), as viewport height multiplier.
     * Asymmetric: trailing window is usually smaller.
     * Default: 1
     */
    trailingMultiplier: number;
    /**
     * How many viewport heights ahead to maintain C++ layout attributes.
     * No React components. Pure layout cache entries.
     * Default: 8
     */
    layoutMultiplier: number;
    /**
     * How many viewport heights ahead to prefetch data.
     * Triggers onPrefetch callback.
     * Default: 12
     */
    dataMultiplier: number;
    /**
     * How aggressively the window expands under fast scroll velocity.
     * windowExpansion = 1 + velocityScaleFactor * velocity (in viewport/s)
     * Clamped by maxWindowMultiplier.
     * Default: 0.5
     */
    velocityScaleFactor: number;
    /**
     * Hard cap on window expansion under velocity.
     * Prevents window from growing unbounded during fling.
     * Default: 8
     */
    maxWindowMultiplier: number;
    /**
     * Maximum number of simultaneously mounted React cell components (render tier + visible tier).
     * LRU eviction when exceeded — cells furthest from viewport are unmounted first.
     * Default: 40
     */
    mountedCellBudget: number;
    /**
     * Separate LRU budget for supplementary views (headers, footers, custom kinds).
     * Independent from mountedCellBudget to prevent headers being evicted by content.
     * Default: 20
     */
    supplementaryBudget: number;
    /**
     * Per-pressure-level overrides for renderMultiplier and mountedCellBudget.
     * Applied when iOS memory pressure notifications arrive.
     * C++ window controller reacts immediately (within the same scroll frame).
     */
    memoryPressure: {
        /** UIApplicationDidReceiveMemoryWarning (level 1) */
        low: MemoryPressureOverride;
        /** OS moderate pressure (level 2) */
        moderate: MemoryPressureOverride;
        /** OS critical pressure — app may be killed soon (level 3) */
        critical: MemoryPressureOverride;
        /** App moved to background (UIApplicationDidEnterBackgroundNotification) */
        backgrounded: MemoryPressureOverride;
    };
    /**
     * Minimum absolute pixel delta needed to trigger a position correction
     * when an estimated cell size is resolved.
     * Prevents unnecessary scroll adjustments for sub-pixel differences.
     * Default: 1  (px)
     */
    correctionMinDelta: number;
}
/** Default window config — mirrors C++ defaults, confirmed to be safe on mid-range devices. */
export declare const DEFAULT_WINDOW_CONFIG: WindowConfig;
