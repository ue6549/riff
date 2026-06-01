/**
 * CollectionView — M2.1 shell + M2.3 renderer + M2.4 window controller
 *                + M3.1 Activity-based cell suspension.
 *
 * Lives in example/components/ during POC development so it shares the
 * example app's React instance (avoids the dual-React hooks crash that
 * happens when a component in packages/src/ has its own node_modules/react).
 * Will move to packages/src/ once the monorepo uses workspace hoisting.
 *
 * Windowing model (M2.4 + M4.1):
 *   Items outside the render window are not mounted at all.
 *   Items inside the render window are Activity=visible — they form the visual
 *   buffer so cells are fully painted before the viewport reaches them.
 *   Items in the measure range (beyond render range, parked at top:-9999) use
 *   Activity=hidden so Fabric computes their Yoga layout for height measurement
 *   without painting them or firing their user-cell effects.
 *   Heights are measured by the ShadowNode via Yoga and written back to the
 *   C++ LayoutCache — no JS measurement roundtrip needed.
 *
 * Scroll path optimisations:
 *   - Window range computed with O(1) arithmetic (no JSI on scroll tick).
 *   - State only updated when a range boundary actually changes.
 *   - Render window mounted via data.slice — reconciliation is O(window), not O(n).
 *   - Visible range consumed via useDeferredValue so Activity-mode updates
 *     never block the JS thread on a frame where the render range also changed.
 *   - updateScrollPosition removed: C++ already receives scroll position on the
 *     UI thread via UIScrollViewDelegate (M2.2b), one frame before JS sees it.
 *
 * Scroll container: native RNCollectionViewContainer (ShadowNode-managed).
 */
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Dimensions,
  LayoutAnimation,
  ScrollViewProps,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';

// Activity: stable in React 19.2 (RN 0.83+).
// Falls back gracefully if not available (older new-arch builds).
// @ts-ignore — not in @types/react yet for all versions
const Activity = (React as any).Activity as
  | React.ComponentType<{ mode: 'visible' | 'hidden'; children: React.ReactNode }>
  | undefined;

import NativeCollectionViewModule from '../specs/NativeCollectionViewModule';
import RNMeasuredCell from '../specs/RNMeasuredCellNativeComponent';
import RNScrollCoordinatedView from '../specs/RNScrollCoordinatedViewNativeComponent';
import RNCollectionViewContainer from '../specs/RNCollectionViewContainerNativeComponent';
// H-2: replaced by RNCollectionSubContainer (generic native sub-container with
// internal UIScrollView and native frame/transform application). Old wrapper
// kept available behind the flag for fallback debugging only.
import RNOrthogonalSectionView from '../specs/RNOrthogonalSectionNativeComponent';
import RNCollectionSubContainer from '../specs/RNCollectionSubContainerNativeComponent';
import type { HSectionMeta } from '../layouts/compositional';
import { RiffSnapshot } from './CollectionSnapshot';
import { SlotManager } from './SlotManager';
import type { SlotInfo } from './SlotManager';
import type { RiffLayout, RiffSection, LayoutContext, RiffRenderItemInfo, RiffScrollOptions, RiffScrollOffsetOptions } from '../types/protocol';
import type { LayoutAttributes } from '../types/layout';
import { list as listLayout } from '../layouts/list';

// ─── JSI module types ─────────────────────────────────────────────────────────

type NativeRange = { first: number; last: number };
type NativeWindowState = { render: NativeRange; visible: NativeRange };

const nativeMod = NativeCollectionViewModule as unknown as {
  layoutCacheId: number;
  /** B4.9: Create a fresh isolated LayoutCache + engines for one CollectionView instance. */
  createLayoutCache(): number;
  /** B4.9: Release per-instance cache on unmount. */
  destroyLayoutCache(id: number): void;
  /** B4.9: Returns per-instance cache JSI object (same API as layoutCache). */
  layoutCacheById(id: number): any;
  /** Programmatic scroll. Invokes the scroll handler registered by the container view. */
  scrollTo(cacheId: number, x: number, y: number, animated: boolean): void;
  /** Single-call scroll-to-item by cache key. C++ looks up attrs, computes offset, invokes handler. */
  scrollToKey(cacheId: number, key: string, isHoriz: boolean, vpW: number, vpH: number, hasLeadPin: boolean, hasTrailPin: boolean, position: string, curScroll: number, animated?: boolean): void;
  /** Single-call scroll-to-index-path. C++ resolves (section,item)→key via O(1) reverse index. */
  scrollToIndexPath(cacheId: number, section: number, item: number, isHoriz: boolean, vpW: number, vpH: number, hasLeadPin: boolean, hasTrailPin: boolean, position: string, curScroll: number, animated?: boolean): void;
  /** Single-call scroll-to-section. C++ tries header key first, falls back to first item. */
  scrollToSection(cacheId: number, section: number, isHoriz: boolean, vpW: number, vpH: number, position: string, curScroll: number, animated?: boolean): void;
  /** Single-call scroll-to-end. C++ queries content size, subtracts viewport, invokes handler. */
  scrollToEnd(cacheId: number, isHoriz: boolean, vpW: number, vpH: number, animated?: boolean): void;
  layoutCache: {
    clear(): void;
    setAttributes(attrs: object): void;
    getAttributes(key: string): any;
    getAttributesInRect(rect: { x: number; y: number; width: number; height: number }): any[];
    removeAttributes(key: string): void;
    getItemHeights(section: number, count: number): number[];
    getItemHeightsByKeys(keys: string[]): number[];
    getTotalContentSize(): { width: number; height: number };
    version(): number;
    /** MVC: enable/disable correction. Drives ShadowNode snapshotAnchorIfNeeded() gating. */
    setMVCEnabled(enabled: boolean): void;
    /** MVC: snapshot anchor before prepare() rewrites positions. Reads scroll offset from LayoutCache. */
    snapshotAnchor(): void;
    /** MVC: compare anchor's new Y after prepare(). Stores pending correction. */
    computeCorrection(): number;
    /** MVC: consume and clear pending correction (called by native view). */
    consumePendingCorrection(): number;
    /** H-list MVC: snapshot first visible H item for sectionIndex before prepare(). */
    snapshotHAnchor(sectionIndex: number, scrollX: number): void;
    /** Stash API: save primary-axis size for every Measured entry. Call before clear(). */
    stashHeights(): void;
    /** Stash API: release stash memory. Call after computeSections(). */
    clearStash(): void;
  };
  metrics: {
    startFrameTimer(): void;
    stopFrameTimer(): void;
    getFrameMetrics(): { fps: number; frameTimeMs: number };
    resetMetrics(): void;
    getMainThreadCPU(): number;
  };
  /** F1.1 — Key-based identity diff. */
  diffEngine: {
    diff(
      oldKeys: string[], newKeys: string[]
    ): {
      removed:  string[];
      inserted: string[];
      moved:    Array<{ key: string; fromIndex: number; toIndex: number }>;
    };
  };
  /** P5.3 — Instruments signpost. id: 0=ScrollHandler 1=LayoutPass 2=MeasureFlush */
  signpost: {
    begin(id: number): void;
    end(id: number): void;
  };
  /** P4.1 — Memory management. */
  memory: {
    availableBytes(): number;
    pressureLevel(): number;
    onPressure(callback: (level: number) => void): void;
    simulate(level: number): void;
  };
  windowController: {
    getScrollPosition(): { y: number; x: number };
    // P1.1 — C++ window controller
    computeRanges(
      scrollY: number, vpHeight: number, itemCount: number,
      stride: number, renderMult: number, sectionInsetTop: number,
      velocity: number,
    ): NativeWindowState;
    computeVariableRanges(
      scrollY: number, vpHeight: number, positions: number[],
      itemCount: number, renderMult: number, velocity: number,
    ): NativeWindowState;
    applyBudget(
      renderFirst: number, renderLast: number,
      visibleFirst: number, visibleLast: number,
      mountedWindowSize: number, vpHeight: number, stride: number,
    ): NativeRange;
    computeMeasureRange(
      budgetedFirst: number, budgetedLast: number,
      ahead: number, itemCount: number,
    ): NativeRange;
    // Batched scroll computation — replaces 4-6 individual JSI calls.
    // B4.9: cacheId is the first argument (routes to per-instance cache).
    // Scroll offset + velocity are read from LayoutCache (set by native scrollViewDidScroll:).
    processScroll(
      cacheId: number,
      vpPrimary: number, vpCross: number,
      isHorizontal: boolean,
      renderMult: number,
      stride: number, measureAheadMult: number,
      mountedWindowSize: number, itemCount: number,
      sectionInfoPacked: number[] | null,
      budgetCols?: number,
      sorted?: boolean,
    ): {
      renderFirst: number; renderLast: number;
      visibleFirst: number; visibleLast: number;
      measureFirst: number; measureLast: number;
      cacheVersion: number;
      blankBefore: number; blankAfter: number;
      frames?: number[]; framesFirst?: number;
    };
    // H-section render range computation from scroll offset.
    // B4.9: cacheId is the first argument.
    processHScroll(
      cacheId: number,
      sectionIndex: number, scrollX: number,
      vpWidth: number, renderMult: number,
      sectionY: number, sectionHeight: number,
      flatBase: number, itemCount: number,
    ): {
      renderFirst: number; renderLast: number;
      frames?: number[]; framesFirst?: number;
      cacheVersion?: number;
      unchanged?: boolean;
    };
  };
};
const nativeWindowController = nativeMod.windowController;

// ── Internal render info types ─────────────────────────────────────────────────

interface RenderItemInfo<T> {
  item: T;
  index: number;
}

interface SectionedRenderItemInfo<T> {
  item: T;
  sectionIndex: number;
  itemIndex: number;
}

/**
 * F1.2 — Imperative handle exposed via the `ref` prop (React 19 style).
 *
 * Usage:
 *   const ref = useRef<RiffHandle<MyItem>>(null);
 *   <Riff ref={ref} ... />
 *   const snap = ref.current.snapshot();
 *   snap.appendItems(newItems);
 *   ref.current.apply(snap);   // diff + LayoutAnimation + startTransition
 *
 * RiffScrollOptions and RiffScrollOffsetOptions are re-exported from @riff/types/protocol.
 */
export interface RiffHandle<T = unknown> {
  /**
   * Scroll to the item at the given index path.
   * section: 0-based section index. item: 0-based item index within the section.
   */
  scrollToIndexPath(indexPath: { section: number; item: number }, options?: RiffScrollOptions): void;

  /**
   * Scroll to the start of a section — its header if one exists, otherwise its first item.
   * Equivalent to UICollectionView's scrollToItemAtIndexPath:item=0 atScrollPosition:.
   */
  scrollToSection(sectionIndex: number, options?: RiffScrollOptions): void;

  /** Scroll to the very beginning of the content (offset 0,0). */
  scrollToTop(options?: { animated?: boolean }): void;

  /** Scroll to the trailing edge of the content (right for horizontal, bottom for vertical). */
  scrollToEnd(options?: { animated?: boolean }): void;

  /** Scroll to an absolute content offset. */
  scrollToOffset(options: RiffScrollOffsetOptions): void;

  /**
   * Scroll to the item with the given cache key (low-level).
   * Prefer scrollToIndexPath for consumer use.
   * Key format for sectioned mode: `${sectionKey}:${keyExtractor(item)}`.
   */
  scrollToItem(key: string, options?: RiffScrollOptions): void;

  /**
   * Scroll to item at flat index (flat mode convenience).
   * Equivalent to scrollToIndexPath({ section: 0, item: index }).
   */
  scrollToIndex(index: number, options?: RiffScrollOptions): void;

  /**
   * Get layout attributes for item at flat index (flat mode convenience).
   * Returns null if the index is out of range or the item has no cached layout.
   */
  getItemLayoutAt(index: number): LayoutAttributes | null;

  /**
   * @unstable
   *
   * Evict cached heights for items at the given flat indices.
   * Flat-mode convenience for invalidateKeys — resolves indices to keys internally.
   */
  invalidateAt(indices: number[]): void;

  /**
   * Create a snapshot seeded with the current data array and key extractor.
   * Record mutations on it, then pass to apply().
   */
  snapshot(): RiffSnapshot<T>;

  /**
   * Apply a snapshot: diff old vs new keys, evict stale heights for removed
   * items, trigger LayoutAnimation for position shifts, and commit the update
   * inside startTransition.
   *
   * Two ways to deliver the new data array to your state:
   *
   *   // Option A — pass the setter at the call site (recommended):
   *   ref.current.apply(snap, setData);
   *
   *   // Option B — wire onDataChange in JSX and call apply with no setter:
   *   <Riff onDataChange={setData} ... />
   *   ref.current.apply(snap);
   *
   * If both are provided, the call-site setter wins.
   * If neither is provided, a dev warning is logged and the data does not update.
   */
  apply(snap: RiffSnapshot<T>, setData?: ((data: T[]) => void) | boolean, animated?: boolean): void;

  /**
   * @unstable
   *
   * Evict the cached height for the item at (sectionIndex, itemIndex) and
   * trigger a re-measurement pass.
   *
   * Call this in the same event handler as your state update — React 19 batches
   * both into one commit so the cell is measured at its new natural height
   * without a second render pass.
   */
  invalidateItem(sectionIndex: number, itemIndex: number): void;

  /**
   * @unstable Low-level escape hatch. Prefer invalidateItem(sectionIndex, itemIndex)
   * or invalidateAt(indices) — both resolve to the correct cache key internally.
   *
   * Evicts cached heights for the given keys and triggers a re-measurement pass.
   * The key must be the exact string that keyExtractor returns for the item in
   * flat mode. In sections mode use invalidateItem instead.
   */
  invalidateKeys(keys: Iterable<string>): void;

  /**
   * @unstable Key format is an internal detail — consumers should not need to
   * construct cache keys. A future version will accept (sectionIndex, itemIndex)
   * instead.
   *
   * Returns full layout attributes (frame, sizingState, isSticky, zIndex, etc.)
   * for the item with the given cache key, or null if not found. Useful for
   * custom scroll math via scrollToOffset.
   */
  getItemLayout(key: string): LayoutAttributes | null;
}

export interface RiffProps<T = unknown> {
  /** Flat mode data. Mutually exclusive with `sections`. */
  data?: T[];
  /** Sectioned mode. Mutually exclusive with `data`. */
  sections?: RiffSection<T>[];

  /**
   * Layout engine conforming to the RiffLayout protocol.
   * When provided, the layout handles position computation, content sizing,
   * and invalidation. Built-in props (itemHeight, estimatedItemHeight) are
   * ignored — the layout's delegate owns sizing.
   *
   * Usage:
   *   import { list, masonry, grid, flow, customLayout } from 'riff/layouts';
   *   <CollectionView layout={masonry({ columns: 3, heightForItem: fn })} ... />
   */
  layout?: RiffLayout;

  /**
   * Called for each item. Receives a `RiffRenderItemInfo<T>` with all four
   * fields always present (flat mode: sectionIndex=0, itemIndex=index).
   */
  renderItem: (info: RiffRenderItemInfo<T>) => React.ReactElement | null;
  keyExtractor?: (item: T, ...args: any[]) => string;
  /**
   * Returns a string type identifier for an item. Items with the same type
   * share a recycle pool — a slot vacated by one item can be reused by another
   * of the same type without remounting the inner component.
   *
   * Identical to FlashList's getItemType. Use this whenever your list renders
   * heterogeneous cell components (e.g. banners, products, ads) to prevent
   * cross-type recycling, which is no cheaper than a cold mount.
   *
   * Default: all items share a single 'item' pool (no segregation).
   */
  getItemType?: (item: T, index: number) => string;
  /**
   * Returns a string type identifier for a supplementary view (header or footer).
   * Supplementary views with the same type share a recycle pool — matches
   * UICollectionView's reuseIdentifier per supplementary kind.
   *
   * Receives the kind ('header' | 'footer') and the section index.
   * Default: all headers share 'header' pool, all footers share 'footer' pool.
   */
  getSupplementaryType?: (kind: 'header' | 'footer', sectionIndex: number) => string;
  /**
   * Like FlatList's `extraData` — changing this value forces a re-render of ALL visible cells
   * and a layout re-measurement pass.
   *
   * Pass any value that changes when items resize. A simple version counter works well:
   * ```ts
   * const [resizeVersion, setResizeVersion] = useState(0);
   * // in your resize handler:
   * setResizeVersion(v => v + 1);
   * // on the component:
   * <Riff extraData={resizeVersion} ... />
   * ```
   *
   * This re-renders all visible cells regardless of what changed. For lists with many
   * cells this is acceptable; `invalidateItem` (unstable) is a more precise alternative
   * when it is reliable.
   */
  extraData?: unknown;

  /**
   * Initial height estimate for items. Yoga is always the authority for final cell
   * dimensions — this value seeds the layout before measurement.
   * Enables the onLayout measurement pass: cells report their measured height,
   * LayoutCache is updated incrementally, and scroll position is corrected so
   * visible content does not jump when an item above it changes size.
   *
   * Only meaningful for the default vertical list (no `layout` prop). When a layout
   * is provided, sizing is owned by the layout's estimatedHeightForItem / estimatedSizeForItem
   * delegates; this prop is used only as a stride fallback for the JS window computation
   * and as the H-container height seed before the first measurement.
   */
  estimatedItemHeight?: number;

  /**
   * @unstable This API is not yet stable and may change or be removed.
   *
   * Called when an item's object reference changes behind the same key to decide
   * whether its cached height should be invalidated and the cell re-measured.
   *
   * Default: `(prev, next) => prev !== next` — any reference change triggers
   * re-measurement. Override to skip remeasure when only non-height fields change
   * (e.g. a badge count update that doesn't affect cell height).
   *
   * **Known limitation:** This does NOT call `nativeLayoutCache.removeAttributes` — it only
   * bumps `layoutCacheVersion`. If the LayoutCache still holds a stale measured height for the
   * key, the re-render races with the Yoga re-measurement cycle and the cell may stay at its
   * old height until the next layout pass. For reliable resize, use `extraData` instead.
   *
   * Works for all layout types (list, grid, masonry, flow, custom).
   */
  remeasureOnItemChange?: (prev: T, next: T) => boolean;

  itemSpacing?: number;
  sectionInsetTop?: number;
  sectionInsetBottom?: number;
  sectionInsetLeft?: number;
  sectionInsetRight?: number;

  /**
   * How many additional viewport-heights to keep rendered above and below
   * the visible area. Default 1.0 → total render window = 3× viewport.
   */
  renderMultiplier?: number;

  /**
   * H-3.5 — Render multiplier used specifically for horizontal sections.
   * Decouples the H window size from the V window size so you can tune them
   * independently. For example, a long feed can use renderMultiplier={0.25}
   * for V efficiency while horizontal carousels use hRenderMultiplier={1.0}
   * so they never show a blank leading edge.
   *
   * Precedence for H sections:
   *   section.renderMultiplier ?? hRenderMultiplier ?? renderMultiplier ?? 0.5
   *
   * Defaults to renderMultiplier (backward-compatible — same behaviour as before).
   */
  hRenderMultiplier?: number;

  /**
   * M3.5 — Maximum mounted content expressed as a viewport-height multiple.
   * E.g. 5.0 = keep at most 5× the viewport height worth of cells mounted.
   * Self-calibrating: works regardless of item size or heterogeneous heights.
   * Relates naturally to renderMultiplier — velocity can temporarily expand
   * the render window, but total mounted content is capped here.
   * Default 5.0. Set to Infinity to disable.
   */
  mountedWindowSize?: number;

  /**
   * M4.1 — How many viewport-heights to pre-measure ahead of (and behind) the
   * render range. Cells in this extended zone are mounted off-screen at top:-9999
   * inside Activity=hidden so their heights are captured before they scroll into
   * view, eliminating white-space flash on fast scroll.
   * Default 2.0. Only active in variable-height mode (estimatedItemHeight).
   * Set to 0 to disable pre-measurement.
   */
  measureAhead?: number;

  /**
   * How many items to render on the very first paint, before viewport
   * dimensions are known. Avoids the blank-frame flash that would otherwise
   * occur while waiting for onLayout. Items are positioned at stride-estimated
   * positions. Once the viewport is measured, the real windowed range takes over.
   * Default 10. Set to 0 to disable (renders nothing until layout is known).
   */
  initialNumToRender?: number;

  /**
   * Maximum number of idle slots kept alive (Activity=hidden) per item type
   * between render-window updates. Idle slots let items re-enter the window
   * as a cheap prop update (Fiber reuse) rather than a cold mount.
   *
   * Default: undefined = auto (tracks the current render window size). This
   * guarantees zero steady-state cold mounts on revisit at negligible memory
   * cost — Activity=hidden cells don't participate in layout or GPU rendering.
   *
   * Set to a fixed number to cap memory usage at the cost of more cold mounts.
   * Set to 0 to disable pooling entirely (every revisit is a cold mount).
   */
  recyclePoolSize?: number;

  /**
   * Called whenever the number of rendered items changes.
   * Useful for debug overlays: (renderCount, totalCount) => void.
   */
  onRenderCountChange?: (renderCount: number, totalCount: number) => void;
  /** Called after each render with the number of mounted decoration views (windowing proof). */
  onDecorationCountChange?: (count: number) => void;

  /**
   * Fires when the container's measured size changes.
   * Useful for coordinating external UI (animations, other components) with container resize.
   * The layout itself re-computes automatically — this callback is for consumer side effects only.
   */
  onContainerSizeChange?: (width: number, height: number) => void;
  /**
   * ScrollView-compatible content size callback.
   * Called when the native scroll content size changes.
   * Supports legacy/top-level usage; equivalent to scrollViewProps.onContentSizeChange.
   */
  onContentSizeChange?: (width: number, height: number) => void;

  /**
   * @experimental
   *
   * Fires on every scroll event with an estimate of how many pixels of the
   * visible viewport are not covered by the render window.
   *   offsetStart: gap px at the leading edge (top when scrolling down)
   *   offsetEnd:   gap px at the trailing edge (bottom when scrolling down)
   * Both are 0 when the render window fully covers the viewport.
   *
   * Important caveats — read before relying on this:
   *
   * 1. Geometry-based, not pixel-based. Values are derived from the position
   *    of the first/last rendered item in LayoutCache vs the current scroll
   *    offset. A non-zero value means the render window boundary has receded
   *    past the viewport edge — it does NOT mean blank pixels were actually
   *    painted on screen (cells may already be mid-mount).
   *
   * 2. Always 0 for custom layouts. The computation only works on sorted
   *    layouts (list, grid, masonry, flow). Custom spatial-query layouts
   *    always return 0.
   *
   * 3. Fires on every scroll tick (not throttled). Gate expensive work inside
   *    the callback yourself.
   *
   * For a reliable indication of what the user can see, use onViewableRangeChange.
   * Only enable RNCV_DEBUG_CALLBACKS to receive this callback.
   */
  onBlankArea?: (event: { offsetStart: number; offsetEnd: number }) => void;

  /**
   * Fires when any windowing range boundary changes. Ranges are flat indices
   * into the data array (or the flattened sections array in sectioned mode).
   *
   *   visible:  items whose frame overlaps the current viewport
   *   render:   items currently mounted (the render window around visible)
   *   measure:  items pre-mounted off-screen for height measurement
   *             (only present in variable-height mode, i.e. estimatedItemHeight)
   *
   * Called only when at least one boundary actually changes — not on every
   * scroll tick. Zero overhead on scroll events where the window is stable.
   *
   * Use this instead of onBlankArea for reliable visibility tracking. To get
   * the item or its frame for a given index, call ref.current.getItemLayout(key).
   */
  onViewableRangeChange?: (ranges: {
    visible: { first: number; last: number };
    render:  { first: number; last: number };
    measure?: { first: number; last: number };
  }) => void;

  // ref is exposed via React.forwardRef — not declared here.
  // Usage: const ref = useRef<RiffHandle<T>>(null); <Riff ref={ref} />

  /**
   * Called by ref.current.apply(snap) with the mutated data array so you
   * can sync your React state. Equivalent to passing your state setter directly
   * to apply(): `ref.current.apply(snap, setData)`.
   *
   * Wire this in JSX when you always want the same setter:
   *   const [data, setData] = useState(initialItems);
   *   <Riff data={data} onDataChange={setData} ref={listRef} />
   *   ref.current.apply(snap); // no setter needed at call site
   *
   * Already wrapped in startTransition internally — do not wrap again.
   * If both onDataChange and a call-site setter are provided, the call-site wins.
   */
  onDataChange?: (data: T[]) => void;

  /**
   * F1.3 — Prefetch callback. Fires when items enter the prefetch window
   * (~prefetchAhead × viewport ahead of the render range). Use this to start
   * loading images or data before cells mount.
   */
  onPrefetch?: (keys: string[]) => void;

  /**
   * F1.3 — Evict callback. Fires when items leave the prefetch window so
   * in-flight loads can be cancelled and resources released.
   */
  onEvict?: (keys: string[]) => void;

  /**
   * F1.3 — How many viewport-heights ahead to fire onPrefetch.
   * Default 12. Set to 0 to disable.
   */
  prefetchAhead?: number;

  /**
   * Flat mode: indices of cells that pin to the top when scrolled past.
   * Only valid when `data` is provided (not `sections`).
   */
  stickyHeaderIndices?: number[];

  /**
   * Flat mode: indices of cells that pin to the bottom when scrolled past.
   * Only valid when `data` is provided (not `sections`).
   */
  stickyFooterIndices?: number[];

  /**
   * How sticky headers behave when multiple are present.
   * - 'sticky': header sticks at top until replaced by next sticky header
   * - 'push': incoming sticky header pushes the current one upward
   *   (matches UICollectionView's default behaviour)
   * Default 'push'.
   */
  stickyMode?: 'sticky' | 'push';

  /**
   * @deprecated Use `decorationRenderers.sectionBackground` instead.
   * Requires `sectionBackground: true` on the list layout delegate.
   * Old prop: not windowed, manually positioned via JS.
   */
  renderSectionBackground?: (sectionIndex: number) => React.ReactElement | null;

  /**
   * Renderers for decoration views emitted by the layout engine.
   * Decoration views are windowed (off-screen ones are not mounted).
   *
   * - `sectionBackground(sectionIndex, frame)`: covers the full section rect.
   *   Requires `sectionBackground: true` on the list layout delegate.
   * - Any custom kind emitted by a custom layout engine.
   *
   * Separators are built-in and use the color from the list layout's
   * `separator.color` option — no renderer needed.
   */
  decorationRenderers?: {
    sectionBackground?: (sectionIndex: number, frame: { x: number; y: number; width: number; height: number }) => React.ReactElement | null;
    [kind: string]: ((sectionIndex: number, frame: { x: number; y: number; width: number; height: number }) => React.ReactElement | null) | undefined;
  };

  scrollViewProps?: ScrollViewProps;

  style?: StyleProp<ViewStyle>;

  /**
   * P5.2 — Debug performance HUD.
   * When true, renders a live metrics overlay (FPS, frame time, mounted cells,
   * cold mounts, scroll corrections, blank area). Updates at 10 Hz.
   * Uses CADisplayLink for accurate frame time — more precise than RAF-based FPS.
   */
  showHUD?: boolean;

  /**
   * Seed container width for the first render, before onLayout fires.
   * When the layout protocol is active, this lets prepare() run immediately
   * so cells are positioned from heightForItem/sizeForItem on frame 1
   * instead of falling back to uniform stride estimates.
   * Defaults to Dimensions.get('window').width. Set to 0 to disable seeding.
   */
  initialWidth?: number;

  /**
   * Seed container height for the first render, before onLayout fires.
   * Defaults to Dimensions.get('window').height.
   */
  initialHeight?: number;

  /**
   * When true, adjusts the scroll offset whenever items above the viewport
   * are inserted, deleted, or resized — so visible content stays in place.
   * Correction is computed in JS via LayoutCache snapshot-compare.
   * Default false (opt-in).
   */
  maintainVisibleContentPosition?: boolean;
}

// ─── Internal types ───────────────────────────────────────────────────────────

/** Inclusive index range into the data array. last < first means empty. */
type Range = { first: number; last: number };

/** Snapshot of JS-side metrics read by the HUD at 10 Hz. */
type HUDSnapshot = {
  mountedCells:          number;
  coldMountCount:        number;
  scrollCorrectionCount: number;
  offsetStart:           number; // blank px at top of viewport
  offsetEnd:             number; // blank px at bottom of viewport
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rangeChanged(a: Range | null, b: Range): boolean {
  if (a === null) return true;
  return a.first !== b.first || a.last !== b.last;
}

/**
 * M3.5 — Trims a render range to fit within mountedWindowSize.
 *
 * Budget is expressed in viewport-height multiples, converted to an index
 * count via stride. This keeps the budget meaningful regardless of item size:
 * mountedWindowSize=5 always means "5 viewport-heights of mounted content",
 * whether items are 44px or 400px tall.
 *
 * The visible range anchors the trim so the visible area is always covered.
 * Excess is shed symmetrically, biased toward the trailing end.
 */
function applyBudget(
  render:           Range,
  visible:          Range,
  mountedWindowSize: number,
  vpHeight:         number,
  stride:           number,
): Range {
  if (mountedWindowSize === Infinity || stride <= 0 || vpHeight <= 0) return render;
  let budget = Math.ceil((mountedWindowSize * vpHeight) / stride);
  // Never trim below what's already visible. Dense wrapped layouts can have a
  // visible span larger than stride-derived budget.
  const visibleSize = Math.max(0, visible.last - visible.first + 1);
  if (visibleSize > budget) budget = visibleSize;
  const size   = render.last - render.first + 1;
  if (size <= budget) return render;

  // Centre the budget window on the mid-point of the visible range.
  const visibleMid = (visible.first + visible.last) / 2;
  const half       = Math.floor(budget / 2);
  const first      = Math.max(render.first, Math.round(visibleMid) - half);
  const last       = Math.min(render.last,  first + budget - 1);
  const adjFirst   = Math.max(render.first, last - budget + 1);
  return { first: adjFirst, last };
}

// ─── Section flattening ──────────────────────────────────────────────────────

/** Discriminated union for flat items in sectioned mode. */
type FlatItem<T> =
  | { _kind: 'header'; sectionIndex: number }
  | { _kind: 'item';   sectionIndex: number; item: T; itemIndex: number }
  | { _kind: 'footer'; sectionIndex: number };

interface FlattenResult<T> {
  flatData:                  FlatItem<T>[];
  stickyHeaderFlatIndices:   number[];
  stickyFooterFlatIndices:   number[];
  sectionStartFlatIndices:   number[];
  /** Pre-populated heights for supplementary views with declared height. */
  declaredHeights:           Map<string, number>;
}

const RNCV_DEBUG_LOGS = false;
// Consumer-facing debug/instrumentation callbacks:
// showHUD, onRenderCountChange, onDecorationCountChange, onBlankArea.
// Controlled at build time (not at runtime via __DEV__).
// Set to false for clean perf baseline builds; true for development.
const RNCV_DEBUG_CALLBACKS = true;
// Set to true to enable verbose MVC lifecycle tracing across the JS layer.
// Covers: snapshotAnchor, fingerprint change + stash, computeSections heights,
// measuredHeightForItem lookups, processScroll ranges, onScroll events.
// Keep false in normal development; enable only to debug insert/delete/correction bugs.
const RNCV_MVC_TRACE = false;

// H-1 debug: 1-second JS-thread health summary.
// Logs renders/sec, cv bumps/sec, handleHScroll calls/sec per section, and
// rAF gaps (JS thread blocked). Filter "RNCV-H-DIAG" in the log stream.
// Kept available behind this flag for future H-section gesture/scroll debugging.
const RNCV_HGEST_DIAG = false;

// H sub-container scroll diagnostics. Per-event verbose logs for the JS side
// of the H windowing pipeline.
//
// Flip to true to enable. Sister flag in native code:
//   - cpp/CollectionSubContainerShadowNode.cpp  → RNCV_ENABLE_HSUB_LOGS
//   - cpp/CollectionViewModule.cpp              → RNCV_ENABLE_HSUB_LOGS
//   - ios/RNCollectionSubContainerView.mm       → RNCV_ENABLE_HSUB_LOGS
//
// Filterable tags (grep these):
//   RNCV-HSUB-JS-SCROLL    handleHScroll input + computed range + delta
//   RNCV-HSUB-JS-WIN       Per-render H windowing decisions (re-entry, ranges, exclusions)
//   RNCV-HSUB-JS-PROPS     Wrapper props handed to <RNCollectionSubContainer>
const RNCV_HSUB_LOGS = false;

// ── Scroll health diagnostic ─────────────────────────────────────────────────
// Flip to true. Prints a 1-line summary every ~1s during active scroll.
// Grep: "RNCV-HEALTH"
// Fields:
//   renders   — React component body executions (lower = better)
//   coldM     — cold mounts (should be 0 in steady state)
//   h4Skip    — H-4 stable-band skips (high = good)
//   h4Compute — H-4 actual computes (low = good)
//   hReRender — H-5 React re-renders from H range changes
//   hRestore  — scroll position restorations
const RNCV_HEALTH_DIAG = true;

function rncvMvcTrace(msg: string) {
  if (!__DEV__ || !RNCV_MVC_TRACE) return;
  console.log(`[MVC-TRACE] ${msg}`);
}

function rncvLog(tag: string, payload: Record<string, unknown>) {
  if (!__DEV__ || !RNCV_DEBUG_LOGS) return;
  // Print a single serialized line so Metro doesn't collapse payload to "Object".
  const serialized = JSON.stringify(payload, (_key, value) =>
    value === undefined ? '__undefined__' : value
  );
  console.log(`[${tag}] ${serialized}`);
}

function rncvVerboseLog(...args: any[]) {
  if (!__DEV__ || !RNCV_DEBUG_LOGS) return;
  console.log(...args);
}

function flattenSections<T>(sections: RiffSection<T>[]): FlattenResult<T> {
  const flatData:                FlatItem<T>[] = [];
  const stickyHeaderFlatIndices: number[]      = [];
  const stickyFooterFlatIndices: number[]      = [];
  const sectionStartFlatIndices: number[]      = [];
  const declaredHeights                        = new Map<string, number>();

  for (let si = 0; si < sections.length; si++) {
    const s = sections[si]!;
    sectionStartFlatIndices.push(flatData.length);

    if (s.header) {
      const fi = flatData.length;
      if (s.header.sticky) stickyHeaderFlatIndices.push(fi);
      declaredHeights.set(`__h_${s.key}`, s.header.height);
      flatData.push({ _kind: 'header', sectionIndex: si });
      rncvLog('RNCV-JS-FLAT', {
        op: 'push-header',
        sectionIndex: si,
        sectionKey: s.key,
        flatIndex: fi,
        cacheKey: `item-${si}-header`,
        sticky: !!s.header.sticky,
        declaredHeight: s.header.height,
      });
    }

    for (let ii = 0; ii < s.data.length; ii++) {
      const fi = flatData.length;
      flatData.push({ _kind: 'item', sectionIndex: si, item: s.data[ii]!, itemIndex: ii });
      if (ii < 3 || ii === s.data.length - 1) {
        rncvLog('RNCV-JS-FLAT', {
          op: 'push-item',
          sectionIndex: si,
          sectionKey: s.key,
          itemIndex: ii,
          flatIndex: fi,
          cacheKey: `item-${si}-${ii}`,
        });
      }
    }

    if (s.footer) {
      const fi = flatData.length;
      if (s.footer.sticky) stickyFooterFlatIndices.push(fi);
      declaredHeights.set(`__f_${s.key}`, s.footer.height);
      flatData.push({ _kind: 'footer', sectionIndex: si });
      rncvLog('RNCV-JS-FLAT', {
        op: 'push-footer',
        sectionIndex: si,
        sectionKey: s.key,
        flatIndex: fi,
        cacheKey: `item-${si}-footer`,
        sticky: !!s.footer.sticky,
        declaredHeight: s.footer.height,
      });
    }
  }

  rncvLog('RNCV-JS-FLAT', {
    op: 'summary',
    sectionCount: sections.length,
    flatCount: flatData.length,
    stickyHeaderFlatIndices,
    stickyFooterFlatIndices,
    sectionStartFlatIndices,
  });

  return { flatData, stickyHeaderFlatIndices, stickyFooterFlatIndices, sectionStartFlatIndices, declaredHeights };
}

/**
 * Compute flat index from LayoutAttributes using section+index arithmetic.
 * Layout-key-agnostic — works for list, grid, masonry, flow, any future layout.
 * Replaces keyToFlatIndex.get(attr.key) which hardcodes the list "item-" key prefix.
 */
function attrToFlatIndex(
  attr: LayoutAttributes,
  sectionStartFlatIndices: number[],
  sections: RiffSection<any>[],
): number {
  if (attr.isDecoration) return -1;
  const si = attr.section;
  const start = sectionStartFlatIndices[si];
  if (start === undefined) return -1;
  const s = sections[si];
  if (!s) return -1;

  if (attr.isSupplementary) {
    if (attr.supplementaryKind === 'header') return s.header ? start : -1;
    if (attr.supplementaryKind === 'footer') {
      const headerOffset = s.header ? 1 : 0;
      return start + headerOffset + s.data.length;
    }
    return -1;
  }

  // Regular item: sectionStart + header offset + item index
  const headerOffset = s.header ? 1 : 0;
  return start + headerOffset + attr.index;
}

/** Flat-mode key extractor for sectioned items. */
function sectionedKeyExtractor<T>(
  sections: RiffSection<T>[],
  userKE: ((item: T, ...args: any[]) => string) | undefined,
  fi: FlatItem<T>,
  flatIndex: number,
): string {
  const sk = sections[fi.sectionIndex]?.key ?? String(fi.sectionIndex);
  if (fi._kind === 'header') {
    const out = `__h_${sk}`;
    rncvLog('RNCV-JS-KEY', {
      kind: fi._kind,
      sectionIndex: fi.sectionIndex,
      flatIndex,
      reactKey: out,
    });
    return out;
  }
  if (fi._kind === 'footer') {
    const out = `__f_${sk}`;
    rncvLog('RNCV-JS-KEY', {
      kind: fi._kind,
      sectionIndex: fi.sectionIndex,
      flatIndex,
      reactKey: out,
    });
    return out;
  }
  const raw = userKE ? userKE(fi.item, fi.sectionIndex, fi.itemIndex) : String(flatIndex);
  const out = `${sk}:${raw}`;
  if (fi.itemIndex < 3) {
    rncvLog('RNCV-JS-KEY', {
      kind: fi._kind,
      sectionIndex: fi.sectionIndex,
      itemIndex: fi.itemIndex,
      flatIndex,
      reactKey: out,
    });
  }
  return out;
}

// ─── Cell wrapper ─────────────────────────────────────────────────────────────

function CellWrapper({
  mode,
  children,
}: {
  mode: 'visible' | 'hidden';
  children: React.ReactNode;
}) {
  if (Activity) {
    return <Activity mode={mode}>{children}</Activity>;
  }
  return <>{children}</>;
}

// ─── P5.2: Debug HUD ──────────────────────────────────────────────────────────
// Absolute-positioned overlay showing live performance metrics.
// Polls at 10 Hz (100 ms interval) — decoupled from the scroll render path.
// Receives a snapshotRef so it reads fresh JS-side counters without
// subscribing to CollectionView state (no extra re-renders).

function CollectionViewHUD({
  snapshotRef,
  nativeMod,
}: {
  snapshotRef: React.RefObject<() => HUDSnapshot>;
  nativeMod:   typeof nativeMod;
}) {
  const [fps,         setFps]         = React.useState(0);
  const [frameTimeMs, setFrameTimeMs] = React.useState(0);
  const [snap,        setSnap]        = React.useState<HUDSnapshot>({
    mountedCells: 0, coldMountCount: 0, scrollCorrectionCount: 0, offsetStart: 0, offsetEnd: 0,
  });

  React.useEffect(() => {
    const id = setInterval(() => {
      const fm = nativeMod.metrics.getFrameMetrics();
      setFps(Math.round(fm.fps));
      setFrameTimeMs(parseFloat(fm.frameTimeMs.toFixed(1)));
      if (snapshotRef.current) setSnap(snapshotRef.current());
    }, 100);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fpsColor = fps >= 55 ? '#4ade80' : fps >= 40 ? '#fbbf24' : '#f87171';

  return (
    <View style={HUD.overlay} pointerEvents="none">
      <Text style={HUD.title}>CV Perf</Text>
      <Text style={HUD.row}>
        FPS <Text style={[HUD.val, { color: fpsColor }]}>{fps}</Text>
      </Text>
      <Text style={HUD.row}>
        Frame <Text style={HUD.val}>{frameTimeMs}ms</Text>
      </Text>
      <Text style={HUD.row}>
        Mounted <Text style={HUD.val}>{snap.mountedCells}</Text>
      </Text>
      <Text style={HUD.row}>
        Cold <Text style={HUD.val}>{snap.coldMountCount}</Text>
      </Text>
      <Text style={HUD.row}>
        Corrections <Text style={HUD.val}>{snap.scrollCorrectionCount}</Text>
      </Text>
      {(snap.offsetStart > 0 || snap.offsetEnd > 0) && (
        <Text style={HUD.row}>
          Blank↑ <Text style={[HUD.val, { color: snap.offsetStart > 20 ? '#f87171' : '#fbbf24' }]}>
            {Math.round(snap.offsetStart)}px
          </Text>
        </Text>
      )}
      {snap.offsetEnd > 0 && (
        <Text style={HUD.row}>
          Blank↓ <Text style={[HUD.val, { color: snap.offsetEnd > 20 ? '#f87171' : '#fbbf24' }]}>
            {Math.round(snap.offsetEnd)}px
          </Text>
        </Text>
      )}
    </View>
  );
}

// Breaks circular Yoga sizing for H-free-width cells (H-list/H-grid/V-flow).
// alignSelf: own width = content; alignItems: consumer cell inherits flex-start
// instead of the default stretch, so it also measures to its own content width.
const hFreeWidthInnerStyle = { alignSelf: 'flex-start' as const, alignItems: 'flex-start' as const };

const HUD = StyleSheet.create({
  overlay: {
    position:        'absolute',
    top:             8,
    right:           8,
    backgroundColor: 'rgba(0,0,0,0.82)',
    borderRadius:    8,
    padding:         8,
    minWidth:        130,
    zIndex:          9999,
  },
  title: { fontSize: 10, fontWeight: '700', color: '#94a3b8',
           fontFamily: 'Menlo', marginBottom: 4, letterSpacing: 0.5 },
  row:   { fontSize: 11, color: '#94a3b8', fontFamily: 'Menlo', marginTop: 1 },
  val:   { color: '#e2e8f0', fontWeight: '600' },
});

// ─── Memoized cell content ─────────────────────────────────────────────────────
// Separates the expensive consumer component tree from cheap position/mode
// updates. The outer positioning View and CellWrapper (Activity) reconcile
// freely on every scroll-driven parent re-render — they're just style and
// prop diffs on existing Fibers, sub-microsecond work.
//
// MemoizedCellContent is the memo boundary: it only re-renders when `item`
// or `index` actually changes. For scroll events where data is stable, the
// consumer's component tree is skipped entirely.
//
// renderItem uses RiffRenderItemInfo<any> (module-level, generic-agnostic).
// CollectionView passes a stable wrapper (renderItemRef pattern) so memo's
// prop comparison always sees the same function reference.
const MemoizedCellContent = React.memo(function MemoizedCellContent({
  item,
  index,
  renderItem,
  extraData: _extraData,
}: {
  item: any;
  index: number;
  renderItem: (info: RiffRenderItemInfo<any>) => React.ReactElement | null;
  extraData?: unknown;
}) {
  return renderItem({ item, index, sectionIndex: 0, itemIndex: index });
});

// ─── Component ────────────────────────────────────────────────────────────────

function RiffBase<T = unknown>({
  data: propData,
  sections: propSections,
  layout: layoutProp,
  renderItem: propRenderItem,
  keyExtractor: propKeyExtractor,
  getItemType: propGetItemType,
  getSupplementaryType: propGetSupplementaryType,
  estimatedItemHeight,
  remeasureOnItemChange,
  itemSpacing = 0,
  sectionInsetTop = 0,
  sectionInsetBottom = 0,
  sectionInsetLeft = 0,
  sectionInsetRight = 0,
  renderMultiplier = 0.5,
  hRenderMultiplier: hRenderMultiplierProp,
  mountedWindowSize = 2.0,
  measureAhead = 0,
  initialNumToRender = 10,
  recyclePoolSize,
  onRenderCountChange,
  onBlankArea,
  onViewableRangeChange,
  onDataChange,
  onPrefetch,
  onEvict,
  prefetchAhead = 12,
  stickyHeaderIndices: propStickyHeaderIndices,
  stickyFooterIndices: propStickyFooterIndices,
  stickyMode = 'push',
  extraData,
  renderSectionBackground,
  decorationRenderers,
  onDecorationCountChange,
  scrollViewProps,
  style,
  showHUD = false,
  onContainerSizeChange,
  onContentSizeChange,
  initialWidth,
  initialHeight,
  maintainVisibleContentPosition = false,
}: RiffProps<T>, ref: React.ForwardedRef<RiffHandle<T>>) {

  // ── H-1 debug: 1-second JS health summary ──────────────────────────────────
  // Counts per second (flushed via setInterval from inside an effect):
  //   renders: every Riff() call increments this counter
  //   cvBumps: setLayoutCacheVersion calls (each one triggers a full re-render)
  //   hScrolls per section: handleHScroll calls
  //   rafGapsMs: requestAnimationFrame gaps > 32ms (JS thread blocked)
  // Filter "RNCV-H-DIAG" in the log stream to see this summary.
  const diagRef = useRef({
    renders:    0,
    cvBumps:    0,
    hScrolls:   new Map<number, number>(),
    rafGapsMs:  [] as number[],
    lastRafTs:  0,
  });
  if (__DEV__ && RNCV_HGEST_DIAG) {
    diagRef.current.renders++;
  }
  useEffect(() => {
    if (!__DEV__ || !RNCV_HGEST_DIAG) return;
    let rafId = 0;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const last = diagRef.current.lastRafTs;
      if (last > 0) {
        const gap = now - last;
        if (gap > 32) diagRef.current.rafGapsMs.push(gap);
      }
      diagRef.current.lastRafTs = now;
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    intervalId = setInterval(() => {
      const d = diagRef.current;
      const hParts: string[] = [];
      d.hScrolls.forEach((v, k) => hParts.push(`s${k}=${v}`));
      const gapStr = d.rafGapsMs.length === 0
        ? 'none'
        : `[${d.rafGapsMs.map(g => g.toFixed(0)).join(',')}]`;
      // eslint-disable-next-line no-console
      console.log(
        `RNCV-H-DIAG renders=${d.renders}/s cvBumps=${d.cvBumps}/s ` +
        `hScrolls={${hParts.join(',') || 'none'}} rafGaps>32ms=${gapStr}`,
      );
      d.renders = 0;
      d.cvBumps = 0;
      d.hScrolls.clear();
      d.rafGapsMs = [];
    }, 1000);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  // ── Section flattening ──────────────────────────────────────────────────────
  // If `sections` is provided, flatten to a flat item array. The rest of the
  // component operates on flat data — it doesn't know about sections.

  const isSectioned = !!propSections;

  const flattenResult = useMemo(() => {
    if (!propSections) return null;
    return flattenSections(propSections);
    // NOTE: keyToFlatIndex is no longer used for render-range lookups (replaced by attrToFlatIndex).
    // Stable key → flat index registration removed — no longer needed.
  }, [propSections]);

  useEffect(() => {
    if (!isSectioned || !flattenResult) return;
    rncvLog('RNCV-JS-FLAT', {
      op: 'useMemo-result',
      flatCount: flattenResult.flatData.length,
      stickyHeaders: flattenResult.stickyHeaderFlatIndices,
      stickyFooters: flattenResult.stickyFooterFlatIndices,
      sectionStartFlatIndices: flattenResult.sectionStartFlatIndices,
    });
  }, [isSectioned, flattenResult]);

  // In sectioned mode, wrap the consumer's renderItem to dispatch
  // headers/footers to their section render functions.
  const sectionedRenderItem = useCallback((info: RiffRenderItemInfo<any>) => {
    if (!propSections) return propRenderItem(info);
    const fi = info.item as FlatItem<T>;
    if (fi._kind === 'header') return propSections[fi.sectionIndex]?.header?.render() ?? null;
    if (fi._kind === 'footer') return propSections[fi.sectionIndex]?.footer?.render() ?? null;
    return propRenderItem({ item: fi.item, index: info.index, sectionIndex: fi.sectionIndex, itemIndex: fi.itemIndex });
  }, [propSections, propRenderItem]);

  const sectionedKeyExtractorCb = useCallback((item: any, index: number) => {
    if (!propSections) return propKeyExtractor ? propKeyExtractor(item, index) : String(index);
    const fi = item as FlatItem<T>;
    // For items: read from layoutContextRef.itemKeys — the single source of truth for canonical
    // keys. This avoids re-invoking propKeyExtractor and keeps the key format consistent with
    // what C++ LayoutCache stores (same array passed as params.keys in list.ts prepare()).
    // For headers/footers: use the __h_/__f_ format (not in itemKeys, which covers items only).
    let k: string;
    if (fi._kind === 'item') {
      const ctx = layoutContextRef.current;
      const precomputed = ctx?.sections[fi.sectionIndex]?.itemKeys?.[fi.itemIndex];
      if (precomputed !== undefined) {
        k = precomputed;
      } else {
        // Fallback: layoutContext not yet computed (first render) — construct directly.
        const sk = propSections[fi.sectionIndex]?.key ?? String(fi.sectionIndex);
        k = propKeyExtractor
          ? `${sk}:${propKeyExtractor(fi.item, fi.itemIndex)}`
          : String(index);
      }
    } else {
      k = sectionedKeyExtractor(propSections, propKeyExtractor, fi, index);
    }
    if (fi._kind === 'header' || fi._kind === 'footer' || (fi._kind === 'item' && fi.itemIndex < 2)) {
      rncvLog('RNCV-JS-KEY', {
        op: 'sectionedKeyExtractorCb',
        flatIndex: index,
        kind: fi._kind,
        sectionIndex: fi.sectionIndex,
        itemIndex: (fi as any).itemIndex,
        reactKey: k,
      });
    }
    return k;
  }, [propSections, propKeyExtractor]);

  // Effective values used by the rest of the component.
  const data         = (isSectioned ? flattenResult!.flatData : propData!) as any[];
  const renderItem   = isSectioned ? sectionedRenderItem : propRenderItem;
  const keyExtractor = isSectioned ? sectionedKeyExtractorCb : propKeyExtractor;

  // Sticky indices: from sections (derived) or from flat-mode props.
  const stickyHeaderFlatIndices = isSectioned
    ? flattenResult!.stickyHeaderFlatIndices
    : (propStickyHeaderIndices ?? []);
  const hasStickyHeaders = stickyHeaderFlatIndices.length > 0;
  const stickyFooterFlatIndices = isSectioned
    ? flattenResult!.stickyFooterFlatIndices
    : (propStickyFooterIndices ?? []);
  const hasStickyFooters = stickyFooterFlatIndices.length > 0;

  // ── Core state ──────────────────────────────────────────────────────────────
  // Seed viewport dimensions so the layout protocol can run on frame 1.
  // Consumer can override via initialWidth/initialHeight for non-full-width containers.
  // Seeded values are corrected by onContainerLayout once the real dimensions are known.
  const seedW = initialWidth ?? Dimensions.get('window').width;
  const seedH = initialHeight ?? Dimensions.get('window').height;
  const viewportWidthRef  = useRef(seedW);
  const viewportHeightRef = useRef(seedH);
  const decorationCountRef = useRef(0);
  // Decoration cache — avoids JSI getAttributesInRect call on re-renders
  // where layoutCacheVersion and scroll position haven't changed.
  const lastDecoCacheRef = useRef<{ lcv: number; scrollY: number; scrollX: number; elements: React.ReactElement[] }>({ lcv: -1, scrollY: -1, scrollX: -1, elements: [] });
  // contentHeightRef / layoutContentSizeRef mirror state/memo values.
  // useImperativeHandle closes over its deps once — refs let scrollToItem read
  // the current value without requiring those values in the deps array
  // (which would recreate the handle on every layout pass).
  const contentHeightRef      = useRef(0);
  const layoutContentSizeRef  = useRef<{ width: number; height: number } | null>(null);
  const [viewportWidth,  setViewportWidth]  = useState(seedW);
  const [viewportHeight, setViewportHeight] = useState(seedH);
  const [contentHeight,  setContentHeight]  = useState(0);
  const [internalHorizontalHeight, setInternalHorizontalHeight] = useState<number | null>(null);
  const internalHorizontalHeightRef = useRef<number | null>(null);

  // null = not yet initialized. onContainerLayout computes an eager initial
  // range from stride estimates so the first screenful mounts immediately.
  const [renderRange, setRenderRange] = useState<Range | null>(null);

  // Previous range for O(1) change detection — compared by value, not string.
  const prevRenderRef = useRef<Range | null>(null);
  // Last ranges delivered to onViewableRangeChange — used to suppress no-op calls.
  const prevViewableRef = useRef<{ visFirst: number; visLast: number; renFirst: number; renLast: number; measFirst: number; measLast: number } | null>(null);

  // Scroll position tracking — used for onContentSizeChange synthesis and
  // blank area computation. Velocity is now derived natively in LayoutCache
  // (setScrollOffset with CACurrentMediaTime) — see PERF-PLAN.md.
  const prevScrollYRef   = useRef(0);
  const prevScrollXRef   = useRef(0);  // for horizontal layouts
  const prevContentSizeRef = useRef({ width: 0, height: 0 }); // for onContentSizeChange synthesis
  // H-6: When the scroll handler bumps layoutCacheVersion, the useLayoutEffect
  // should NOT re-run processScroll + setRenderRange — the scroll handler already
  // computed the correct range. This flag lets the effect skip the redundant work.
  const scrollHandledCVRef = useRef(false);

  // Ref kept in sync with layoutContext each render so that sectionedKeyExtractorCb
  // (defined before layoutContext via useCallback) can read pre-computed itemKeys
  // without independently re-invoking propKeyExtractor.
  const layoutContextRef = useRef<LayoutContext | null>(null);

  // Opt 4: SlotManager for cell recycling. Stable slot keys replace per-item
  // React keys so the Fiber survives recycling (prop UPDATE, not DELETE+CREATE).
  const slotManagerRef = useRef<SlotManager<any>>(null as any);
  if (!slotManagerRef.current) slotManagerRef.current = new SlotManager();
  // recyclePoolSize=undefined → auto mode: updated to window size just before sync().

  // Opt 7: element cache for incremental render loop.
  // Maps slotKey → cached ReactElement. If slot state is unchanged AND no
  // global rendering dep has changed, we reuse the element reference — React
  // reconciler sees referential equality and skips diffing the subtree entirely.
  type ElemCacheEntry = {
    gen: number; dataKey: string; cacheKey: string;
    measureOnly: boolean;
    // item reference — checked by reference equality (like React.memo).
    // If the consumer produces a new object for a changed item (React-idiomatic),
    // this misses and the cell re-renders. See COLLECTIONVIEW_INTERNALS.md §
    // "Consumer mutation contract" for the documented requirement and extraData
    // escape hatch.
    item: unknown;
    element: React.ReactElement;
  };
  const elementCacheRef = useRef<Map<string, ElemCacheEntry>>(new Map());
  // Monotonic counter — bumped whenever a rendering dep changes that requires
  // all cached elements to be invalidated (extraData, stickyConfig, layout, vpWidth).
  const renderGenRef = useRef(0);
  const prevCacheDepsRef = useRef<{
    extraData: unknown; stickyConfig: unknown; layout: unknown; vpWidth: number;
  } | null>(null);

  // P5.1 — counters for the debug HUD. Plain refs — no state, no re-renders.
  const coldMountCountRef        = useRef(0);
  const scrollCorrectionCountRef = useRef(0);
  // P5.3 / onBlankArea — last computed blank area, updated on every scroll event.
  const lastBlankAreaRef = useRef({ offsetStart: 0, offsetEnd: 0 });
  // F1.3 — last prefetch range for diff-based onPrefetch/onEvict firing.
  const prevPrefetchRangeRef = useRef<Range | null>(null);
  // F1.3 — pending setImmediate handle for coalesced prefetch/evict computation.
  const pendingPrefetchRef = useRef<ReturnType<typeof setImmediate> | null>(null);
  // Change C — frame data returned by processScroll to eliminate per-cell JSI.
  // Flat [x, y, w, h] per entry for flat indices [framesFirst .. framesFirst + frames.length/4 - 1].
  // gen: the renderGen at which this data was written. renderCell skips the cache when
  // gen !== current renderGen — prevents stale frame data (footer/header at wrong flat
  // indices) from being read during the first render after an insert/delete mutation.
  // cacheVersion: native LayoutCache version at the time these frames were generated.
  // renderCell rejects the entry when this differs from lastCacheVersionRef.current —
  // data-shape mutations (insert/delete) do not bump renderGen, but they DO bump the
  // native cache version via prepare(); without this guard, a stale frame array indexed
  // by NEW flat indices feeds an item the OLD width of a footer/header (and vice versa),
  // poisoning the cache via Yoga deltas.
  const frameDataRef = useRef<{ frames: number[]; first: number; gen: number; cacheVersion: number } | null>(null);
  // Last content size seen by the scroll handler. setLayoutCacheVersion is only
  // called when this changes — not on every raw _version bump. Position
  // corrections are applied natively by ShadowNode; JS re-render is only needed
  // when the scroll area dimensions shift.
  const lastContentSizeRef = useRef({ width: 0, height: 0 });
  // Snapshot function updated every render so the HUD always reads fresh values.
  const hudSnapshotRef = useRef<() => HUDSnapshot>(() => ({
    mountedCells: 0, coldMountCount: 0, scrollCorrectionCount: 0, offsetStart: 0, offsetEnd: 0,
  }));

  // P4.1 — memory pressure: multiplier applied to mountedWindowSize.
  // 1.0 = normal  0.75 = low memory  0.5 = critical memory pressure
  const [memoryMultiplier, setMemoryMultiplier] = useState(1.0);
  useEffect(() => {
    nativeMod.memory?.onPressure((level: number) => {
      if (level >= 2)      setMemoryMultiplier(0.5);
      else if (level >= 1) setMemoryMultiplier(0.75);
      else                 setMemoryMultiplier(1.0);
    });
  }, []);
  const effectiveMountedWindowSize = mountedWindowSize * memoryMultiplier;

  // H-3.5: Resolved H multiplier — falls back to V renderMultiplier when not set.
  // All H section windowing uses this instead of renderMultiplier directly.
  const hRenderMultiplier = hRenderMultiplierProp ?? renderMultiplier;

  // H-3.5: Per-section windowing override map, built from sections[].
  // Maps sectionIndex → the section's own renderMultiplier (when set).
  // Used by handleHScroll and the initial H-range computation in scrollContent.
  const sectionWindowingOverrides = useMemo(() => {
    const map = new Map<number, { renderMultiplier?: number }>();
    const secs = propSections ?? (propData !== undefined ? [{ key: '__single', data: propData }] : []);
    secs.forEach((sec, idx) => {
      if (sec.renderMultiplier !== undefined) {
        map.set(idx, { renderMultiplier: sec.renderMultiplier });
      }
    });
    return map;
  }, [propSections, propData]);

  // ── Phase 5: ShadowNode ↔ LayoutCache bridge ──────────────────────────────
  // B4.9: Each CollectionView instance creates its own isolated LayoutCache on
  // mount. The ID is stable for the lifetime of the component (useState init).
  // ShadowNode looks up the cache during layout() via this ID.
  const [layoutCacheId] = useState(() => nativeMod.createLayoutCache());
  const [layoutCacheVersion, setLayoutCacheVersion] = useState(0);

  // B4.9: Release per-instance cache when this CollectionView unmounts.
  useEffect(() => {
    return () => { nativeMod.destroyLayoutCache(layoutCacheId); };
  }, [layoutCacheId]);

  // H-section windowing: per-section horizontal render ranges.
  // Updated by handleHScroll when processHScroll returns a changed range.
  // hRangeVersion bumps trigger re-render so SlotManager can exclude H items
  // outside their section's H viewport.
  //
  // H-1: Each entry also carries the packed frame data returned by processHScroll
  // (flat [x, y_section_local, w, h] for indices in [framesFirst, framesFirst+N-1])
  // plus gen + cacheVersion bookkeeping for staleness detection. renderCell
  // reads cell width/height/x/y from this map for H cells, eliminating the
  // per-cell attributesForItem JSI call. Equivalent to V cells' frameDataRef
  // fast path. Y is section-local — invariant under V-section reflows above.
  type HRangeEntry = {
    first: number;
    last: number;
    frames?: number[];
    framesFirst?: number;
    gen: number;
    cacheVersion: number;
  };
  const hRenderRangesRef = useRef(new Map<number, HRangeEntry>());
  const [hRangeVersion, setHRangeVersion] = useState(0);
  // H-5: rAF-coalesced re-render for H range changes.
  // Multiple H sections can fire scroll events per frame; coalescing avoids
  // redundant React re-renders. The renderRangeRef mirrors renderRange state
  // so the callback can check V-range overlap without capturing stale state.
  const hRenderPendingRef = useRef(false);
  const renderRangeRef    = useRef<Range | null>(null);
  renderRangeRef.current  = renderRange;

  // Tracks which H section indices had at least one cell in the V render
  // window on the previous render. Used in the H-windowing block of
  // scrollContent to detect sections that are re-entering after being
  // V-scrolled away — those sections' RNCollectionSubContainer view was
  // recycled, contentOffset.x reset to 0 by prepareForRecycle, but the
  // cached hRange still points at the user's old scrollX. Clearing the
  // entry on re-entry forces a fresh processHScroll computation so the
  // wrapper renders the correct cells immediately.
  const prevHSectionsRenderedRef = useRef<Set<number>>(new Set());
  // Bug 2 fix: Save last known scrollX per H section so we can compute the
  // correct render range on re-entry. The native side independently saves
  // and restores contentOffset.x — this map keeps JS in sync.
  const hScrollXMapRef = useRef(new Map<number, number>());

  // ── Health diagnostic counters ───────────────────────────────────────────
  const healthRef = useRef({
    renders: 0, coldM: 0, h4Skip: 0, h4Compute: 0,
    hReRender: 0, hRestore: 0,
    // V-scroll render drivers — identify what triggers each re-render
    vRR: 0,     // setRenderRange from scroll handler
    vLCV: 0,    // setLayoutCacheVersion from scroll handler
    leRun: 0,   // useLayoutEffect executions
    leCH: 0,    // setContentHeight from useLayoutEffect (actual change)
    lastFlush: Date.now(),
  });
  if (__DEV__ && RNCV_HEALTH_DIAG) {
    healthRef.current.renders++;
    const h = healthRef.current;
    const now = Date.now();
    if (now - h.lastFlush >= 1000) {
      // eslint-disable-next-line no-console
      console.log(
        `[RNCV-HEALTH] renders=${h.renders} coldM=${h.coldM} ` +
        `h4Skip=${h.h4Skip} h4Compute=${h.h4Compute} ` +
        `hReRender=${h.hReRender} hRestore=${h.hRestore} | ` +
        `vRR=${h.vRR} vLCV=${h.vLCV} leRun=${h.leRun} leCH=${h.leCH}`
      );
      h.renders = 0; h.coldM = 0; h.h4Skip = 0; h.h4Compute = 0;
      h.hReRender = 0; h.hRestore = 0;
      h.vRR = 0; h.vLCV = 0; h.leRun = 0; h.leCH = 0;
      h.lastFlush = now;
    }
  }

  // Stable renderItem wrapper for MemoizedCellContent.
  // Keeps the latest consumer function in a ref so memo's prop comparison
  // always sees the same function reference — even if the consumer passes a
  // new arrow function on every render without useCallback.
  const renderItemRef    = useRef(renderItem);
  renderItemRef.current  = renderItem;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableRenderItem = useCallback((info: RiffRenderItemInfo<T>) => renderItemRef.current(info), []);

  const itemCount = data.length;

  // NOTE: isVariableHeight means "estimatedItemHeight was provided."
  // ALL consumer-provided dimensions are estimates; Yoga is always the authority.
  // This flag controls whether the default list layout uses the measurement path
  // (estimatedItemHeight) or falls back to a bare estimate without measurement.
  const isVariableHeight  = estimatedItemHeight !== undefined;
  const effectiveItemHeight = estimatedItemHeight ?? 44;
  const stride    = effectiveItemHeight + itemSpacing;
  const itemWidth = Math.max(0, viewportWidth - sectionInsetLeft - sectionInsetRight);

  // Track C++ LayoutCache version to detect when ShadowNode writes heights.
  const lastCacheVersionRef = useRef(0);
  // B4.9: per-instance cache object for this CollectionView.
  // useMemo so the JSI object is fetched once (re-fetched only if cacheId changes,
  // which only happens if the component remounts with a new ID — never in practice).
  const nativeLayoutCache = useMemo(
    () => nativeMod.layoutCacheById(layoutCacheId),
    [layoutCacheId],
  );

  // Scroll diagnostic counters — only allocated when RNCV_DEBUG_LOGS is true.
  // Accumulates per-second stats: total onScroll calls, band-skips, lcv re-renders, rr re-renders.
  const _diagRef = useRef({ totalScroll: 0, bandSkip: 0, lcvRender: 0, rrRender: 0, windowStart: Date.now() });

  // M4.1 measure-range — computed inside the layout effect (same batch as
  // renderRange) to prevent a render cascade. Extends the render range by
  // measureAhead viewport-heights in both directions.
  const [measureRange, setMeasureRange] = useState<Range>({ first: 0, last: -1 });
  const prevMeasureRef = useRef<Range>({ first: 0, last: -1 });

  // TS layout instances — created once per component instance (stable refs).

  // ── Layout protocol bridge ──────────────────────────────────────────────────
  // All layout types go through the protocol. When no `layout` prop is given,
  // a default ListLayout is created from the component's sizing props.

  // Default list layout — created when consumer doesn't provide a layout prop.
  const defaultLayout = useMemo(() => {
    if (layoutProp) return null;
    return listLayout({
      estimatedItemHeight: effectiveItemHeight,
      itemSpacing,
    });
  }, [layoutProp, effectiveItemHeight, itemSpacing]);

  const effectiveLayout = layoutProp ?? defaultLayout!;

  // Stable callback that resolves measured height for an item by index.
  // Reads from LayoutCache (ShadowNode writes Yoga-measured heights there).
  const measuredHeightForItemRef = useRef<(index: number, section: number) => number | undefined>(() => undefined);
  measuredHeightForItemRef.current = (index: number, section: number): number | undefined => {
    // Delegate key construction to the layout engine — single source of truth.
    // effectiveLayout.cacheKeyForItem matches what C++ writes to LayoutCache.
    const key = effectiveLayout.cacheKeyForItem?.(index, section)
      ?? (layoutContext?.sections[section]?.itemKeys?.[index]
        ?? `${effectiveLayout.keyPrefixForSection?.(section) ?? (effectiveLayout.type === 'list' ? 'item' : effectiveLayout.type)}-${section}-${index}`);
    const attr = nativeLayoutCache.getAttributes(key);
    return attr ? attr.frame.height : undefined;
  };

  const layoutContext: LayoutContext | null = useMemo(() => {
    if (viewportWidth === 0) return null;
    return {
      containerWidth: viewportWidth,
      containerHeight: viewportHeight,
      scrollOffset: { x: prevScrollXRef.current, y: prevScrollYRef.current },
      cacheId: layoutCacheId,
      sections: propSections
        ? propSections.map(s => ({
            itemCount: s.data.length,
            insets: s.insets ? { top: s.insets.top ?? 0, bottom: s.insets.bottom ?? 0, left: s.insets.left ?? 0, right: s.insets.right ?? 0 } : undefined,
            itemKeys: propKeyExtractor
              ? s.data.map((item, ii) => `${s.key}:${propKeyExtractor!(item, ii)}`)
              : undefined,
            supplementaryItems: [
              ...(s.header ? [{
                kind: 'header' as const,
                size: { width: viewportWidth, height: s.header.height },
                alignment: 'top' as const,
                pinToVisibleBounds: s.header.sticky ?? false,
                pinBehavior: 'push' as const,
              }] : []),
              ...(s.footer ? [{
                kind: 'footer' as const,
                size: { width: viewportWidth, height: s.footer.height },
                alignment: 'bottom' as const,
                pinToVisibleBounds: s.footer.sticky ?? false,
                pinBehavior: 'push' as const,
              }] : []),
            ],
          }))
        : [{
            itemCount: data.length,
            supplementaryItems: [],
            insets: {
              top: sectionInsetTop,
              bottom: sectionInsetBottom,
              left: sectionInsetLeft,
              right: sectionInsetRight,
            },
          }],
      measuredHeightForItem: (index: number, section: number) =>
        measuredHeightForItemRef.current(index, section),
    };
  }, [viewportWidth, viewportHeight, propSections, propKeyExtractor, data.length,
      sectionInsetTop, sectionInsetBottom, sectionInsetLeft, sectionInsetRight,
      layoutCacheId]);

  // Keep layoutContextRef in sync so sectionedKeyExtractorCb can read itemKeys.
  layoutContextRef.current = layoutContext;

  // B0.5 NOTE: No unmount cleanup here (removed).
  // An unmount cleanup that calls layoutCache.clear() races against the new
  // CollectionView instance's ShadowNode re-reads:
  //   1. New instance mounts → prepare() fills cache correctly
  //   2. ShadowNode.layout() reads cache → calls updateState() → schedules re-render
  //   3. Cleanup fires (async, after paint) → clears cache
  //   4. Re-render arrives → useMemo deps unchanged → prepare() skips
  //   5. ShadowNode.layout() reads EMPTY cache → wrong contentSize → broken layout
  // prepare() overwrites stale data from previous C++ layouts (computeSections
  // clears the cache internally), so a pre-clear is unnecessary. The ShadowNode
  // consistently reads correct data as long as nothing clears the cache after
  // prepare() has run.

  // Sync MVC enabled state to LayoutCache so the ShadowNode's snapshotAnchorIfNeeded()
  // can gate on it for size-change mutations (where layoutContext doesn't change and
  // snapshotAnchor() isn't called from the prepare useMemo below).
  useEffect(() => {
    nativeLayoutCache.setMVCEnabled(maintainVisibleContentPosition);
  }, [maintainVisibleContentPosition, nativeLayoutCache]);

  // Prepare the layout when context changes (data, container size).
  // Cache clearing is handled internally by each layout engine (e.g. list.ts)
  // using its own data-shape fingerprint — NOT here in the generic component.
  useMemo(() => {
    if (!layoutContext) {
      // viewportWidth = 0 (e.g. initialWidth={0} override) — container not measured yet.
      // Clear the cache so the ShadowNode doesn't commit a stale contentSize from
      // a previous layout session. prepare() will run on the next render when
      // onContainerLayout fires and viewportWidth becomes non-zero.
      nativeLayoutCache.clear();
      return;
    }
    // MVC: snapshot anchor BEFORE prepare() overwrites all positions in the cache.
    // Only when maintainVisibleContentPosition is enabled. The anchor is the item
    // with the smallest Y >= current scrollY — the first fully-visible item.
    if (maintainVisibleContentPosition) {
      rncvMvcTrace('prepare: calling snapshotAnchor() (MVC enabled, correctionConsumed reset)');
      nativeLayoutCache.snapshotAnchor();
      // H MVC: snapshot per-section H anchor before positions are overwritten.
      // Layout-agnostic — snapshotHAnchor just records the first visible item key + X;
      // computeHCorrection (called in native updateState) reads the item's new X from
      // the cache after applyMeasurements and applies the delta to the H scroll view.
      // Works for list, grid, masonry, flow, and any future H layout type.
      for (const [sIdx, hScrollX] of hScrollXMapRef.current) {
        nativeLayoutCache.snapshotHAnchor(sIdx, hScrollX);
      }
    }
    effectiveLayout.prepare(layoutContext);
    if (__DEV__ && RNCV_DEBUG_LOGS) {
      const sz = nativeLayoutCache.getTotalContentSize();
      console.log(`[RNCV-B05] prepare done type=${(effectiveLayout as any).type} contentSize=${sz.width.toFixed(0)}x${sz.height.toFixed(0)}`);
    }
    // NOTE: computeCorrection() is NOT called here. It runs in native updateState:
    // AFTER Yoga has measured new items via applyMeasurements. Calling it here
    // (pre-Yoga) would produce corrections based on estimate heights, not actual.
    // Sync version ref so scroll handler doesn't re-trigger.
    lastCacheVersionRef.current = nativeLayoutCache.version();
    // Clear H render ranges — flat indices may have shifted after insert/delete.
    // The proactive processHScroll(scrollX=0) in scrollContent will recompute them.
    hRenderRangesRef.current.clear();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveLayout, layoutContext]);

  // After each layout preparation, the ShadowNode may write Yoga-measured heights
  // to the LayoutCache in the Fabric commit that follows. This bumps the native
  // cache version beyond what prepare() wrote. Without a scroll event, the scroll
  // handler never detects the bump, so stickyConfigMap and layoutContentSize hold
  // stale estimate-based values (e.g. sticky headers appear at wrong positions).
  //
  // Fix: schedule a post-frame check. By the next rAF the ShadowNode will have
  // processed the commit, so any new Yoga measurements are already in the cache.
  //
  // Also triggered by extraData changes: a resize passes new extraData, which
  // causes a Fabric commit → applyMeasurements bumps the cache version. Without
  // this, naturalY stays stale until the 100ms polling timer fires, causing
  // sticky views to be offset by the height delta during that window.
  //
  // B0.1 fix: two nested RAFs instead of one.
  // The [effectiveLayout, layoutContext] effect above syncs lastCacheVersionRef
  // to the post-prepare version (e.g. 5). Fabric background layout then runs and
  // bumps the cache to 6 — but that bump completes AFTER the first RAF fires.
  // The second RAF fires one frame later (after Fabric background layout is done)
  // and reliably detects 6 != 5.
  useEffect(() => {
    let raf2: ReturnType<typeof requestAnimationFrame> | null = null;
    const raf1 = requestAnimationFrame(() => {
      const nv = nativeLayoutCache.version();
      if (nv !== lastCacheVersionRef.current) {
        lastCacheVersionRef.current = nv;
        if (__DEV__ && RNCV_HGEST_DIAG) diagRef.current.cvBumps++;
        setLayoutCacheVersion(v => v + 1);
      }
      raf2 = requestAnimationFrame(() => {
        const nv2 = nativeLayoutCache.version();
        if (nv2 !== lastCacheVersionRef.current) {
          lastCacheVersionRef.current = nv2;
          if (__DEV__ && RNCV_HGEST_DIAG) diagRef.current.cvBumps++;
          setLayoutCacheVersion(v => v + 1);
        }
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutContext, extraData]);

  // Read content size — updates when layoutCacheVersion changes (measurements
  // shift item positions) WITHOUT re-calling prepare().
  const layoutContentSize = useMemo(() => {
    if (!layoutContext) return null;
    return effectiveLayout.contentSize();
  }, [effectiveLayout, layoutContext, layoutCacheVersion]);

  const layoutContentHeight = layoutContentSize?.height ?? 0;

  // Query function: get attributes for items in a rect.
  // Used by the scroll handler and layout effect for range computation.
  const queryLayoutRect = useCallback((rect: { x: number; y: number; width: number; height: number }) => {
    return effectiveLayout.attributesForElements(rect);
  }, [effectiveLayout]);

  // Budget stride for applyBudget: estimated stride for budget calculation.
  const budgetStride = stride;

  // Resolve grid columns to scale the application budget natively.
  // budgetColumns() is the clean protocol path; fall back to reading delegate.columns
  // directly for single-layout engines (grid/masonry/compositional all expose it).
  const budgetCols = effectiveLayout.budgetColumns
    ? effectiveLayout.budgetColumns(viewportWidth)
    : (typeof (effectiveLayout as any).delegate?.columns === 'function'
      ? (effectiveLayout as any).delegate.columns(viewportWidth)
      : ((effectiveLayout as any).delegate?.columns ?? 1));

  // ── processScroll inputs ─────────────────────────────────────────────────────
  // Packed section info for processScroll: [start0, headerOffset0, dataCount0, ...]
  // null for single-section (C++ uses attr.index directly as flat index).
  const sectionInfoPacked = useMemo<number[] | null>(() => {
    if (!isSectioned || !propSections || !flattenResult) return null;
    const packed: number[] = [];
    propSections.forEach((s, si) => {
      packed.push(
        flattenResult.sectionStartFlatIndices[si] ?? 0,
        s.header ? 1 : 0,
        s.data.length,
      );
    });
    return packed;
  }, [isSectioned, propSections, flattenResult]);

  // ── Layout pass + initial window state ───────────────────────────────────────
  // useLayoutEffect so the accurate range (with real layout data) is committed
  // before the frame is painted — avoids a visible flash of stale positions.

  useLayoutEffect(() => {
    if (viewportWidth === 0 || viewportHeight === 0) return;
    if (!layoutContentSize) return;
    if (__DEV__ && RNCV_HEALTH_DIAG) healthRef.current.leRun++;

    // H-6: If the scroll handler already processed this cacheVersion bump,
    // skip the expensive processScroll + setRenderRange — scroll handler
    // already computed the correct range. Only sync contentHeight if it
    // actually changed (rare — only when Yoga measurement shifts total size).
    if (scrollHandledCVRef.current) {
      scrollHandledCVRef.current = false;
      // Always sync the size ref — width can change via H-list Width deltas
      // without changing height (H-6 guard was previously only syncing on height).
      layoutContentSizeRef.current = layoutContentSize;
      if (layoutContentHeight !== contentHeightRef.current) {
        if (__DEV__ && RNCV_HEALTH_DIAG) healthRef.current.leCH++;
        contentHeightRef.current = layoutContentHeight;
        setContentHeight(layoutContentHeight);
      }
      return;
    }

    nativeMod.signpost.begin(1);
    try {

    const chChanged = layoutContentHeight !== contentHeightRef.current;
    if (__DEV__ && RNCV_HEALTH_DIAG && chChanged) healthRef.current.leCH++;
    contentHeightRef.current = layoutContentHeight;
    layoutContentSizeRef.current = layoutContentSize;
    if (chChanged) setContentHeight(layoutContentHeight);

    if (itemCount === 0) {
      setRenderRange({ first: 0, last: -1 });
      return;
    }

    // Single C++ call replaces 2×spatial query + applyBudget + computeMeasureRange.
    const scrollY = prevScrollYRef.current;
    const scrollX = prevScrollXRef.current;
    const isHoriz = effectiveLayout.horizontal ?? false;

    const layoutResult = nativeWindowController.processScroll(
      layoutCacheId,                              // B4.9: per-instance cache
      isHoriz ? viewportWidth  : viewportHeight, // vpPrimary
      isHoriz ? viewportHeight : viewportWidth,  // vpCross
      isHoriz,
      renderMultiplier,
      budgetStride,
      measureAhead > 0 ? measureAhead : 0,
      effectiveMountedWindowSize,
      itemCount,
      sectionInfoPacked,
      budgetCols,
      !effectiveLayout.needsSpatialQuery, // sorted: binary search for list/grid
    );
    rncvVerboseLog(`[RNCVX] scrollY=${scrollY} sectioned=${isSectioned} processScroll -> [${layoutResult.renderFirst}, ${layoutResult.renderLast}]`);

    // Change C: store frame data returned by processScroll. On band-skip (stable-band
    // Opt 6), processScroll does not include frames — frameDataRef stays valid since
    // cacheVersion is unchanged meaning no layout mutations occurred.
    if (layoutResult.frames) {
      frameDataRef.current = { frames: layoutResult.frames, first: layoutResult.framesFirst!, gen: renderGenRef.current, cacheVersion: layoutResult.cacheVersion };
    }

    if (layoutResult.renderLast < layoutResult.renderFirst) {
      const empty = { first: 0, last: -1 };
      if (rangeChanged(prevRenderRef.current, empty)) {
        prevRenderRef.current = empty;
        setRenderRange(empty);
      }
    } else {
      // Keep windowing robust: always include visible span and pad by one cell
      // on both sides to avoid transient holes during fast/programmatic scroll.
      const budgeted = {
        first: Math.max(0, Math.min(layoutResult.renderFirst, layoutResult.visibleFirst) - 1),
        last: Math.min(itemCount - 1, Math.max(layoutResult.renderLast, layoutResult.visibleLast) + 1),
      };
      if (rangeChanged(prevRenderRef.current, budgeted)) {
        prevRenderRef.current = budgeted;
        setRenderRange(budgeted);
      }

      // Measure range: extend render range for pre-measurement of variable-height cells.
      if (measureAhead > 0) {
        const newMR = { first: layoutResult.measureFirst, last: layoutResult.measureLast };
        if (newMR.first !== prevMeasureRef.current.first || newMR.last !== prevMeasureRef.current.last) {
          prevMeasureRef.current = newMR;
          setMeasureRange(newMR);
        }
      }
    }

    } finally { nativeMod.signpost.end(1); }
  }, [
    viewportWidth,
    viewportHeight,
    itemCount,
    renderMultiplier,
    effectiveMountedWindowSize,
    measureAhead,
    stride,
    isVariableHeight,
    layoutCacheVersion,
    effectiveLayout,
    layoutContentSize,
    layoutContentHeight,
    sectionInfoPacked,
  ]);

  // F1.3 — cancel any pending prefetch/evict callback on unmount.
  useEffect(() => {
    return () => {
      if (pendingPrefetchRef.current !== null) {
        clearImmediate(pendingPrefetchRef.current);
        pendingPrefetchRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // P5.1 — start CADisplayLink when HUD is active, stop on unmount or HUD off.
  useEffect(() => {
    if (!RNCV_DEBUG_CALLBACKS || !showHUD) return;
    nativeMod.metrics.startFrameTimer();
    return () => { nativeMod.metrics.stopFrameTimer(); };
  }, [showHUD]); // eslint-disable-line react-hooks/exhaustive-deps

  // After initial mount, ShadowNode may have measured children via Yoga.
  // Check LayoutCache version to pick up any height updates.
  useEffect(() => {
    const timer = setTimeout(() => {
      const cacheVer = nativeLayoutCache.version();
      if (cacheVer !== lastCacheVersionRef.current) {
        lastCacheVersionRef.current = cacheVer;
        if (__DEV__ && RNCV_HGEST_DIAG) diagRef.current.cvBumps++;
        setLayoutCacheVersion(v => v + 1);
      }
    }, 100);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── F1.2: Imperative handle ───────────────────────────────────────────────────

  useImperativeHandle(ref, () => ({
    scrollToIndexPath: ({ section, item }: { section: number; item: number }, options?: RiffScrollOptions) => {
      const isHoriz  = effectiveLayout.horizontal ?? false;
      const position = options?.position ?? (isHoriz ? 'start' : 'top');
      // Single C++ call: resolves (section,item)→key via O(1) reverse index in LayoutCache.
      nativeMod.scrollToIndexPath(
        layoutCacheId, section, item, isHoriz,
        viewportWidthRef.current, viewportHeightRef.current,
        hasStickyHeaders, hasStickyFooters,
        position,
        isHoriz ? prevScrollXRef.current : prevScrollYRef.current,
        options?.animated ?? true,
      );
    },

    scrollToSection: (sectionIndex: number, options?: RiffScrollOptions) => {
      const isHoriz  = effectiveLayout.horizontal ?? false;
      const position = options?.position ?? (isHoriz ? 'start' : 'top');
      // Single C++ call: tries section header key first, falls back to first item of section.
      nativeMod.scrollToSection(
        layoutCacheId, sectionIndex, isHoriz,
        viewportWidthRef.current, viewportHeightRef.current,
        position,
        isHoriz ? prevScrollXRef.current : prevScrollYRef.current,
        options?.animated ?? true,
      );
    },

    scrollToTop: ({ animated = true }: { animated?: boolean } = {}) => {
      nativeMod.scrollTo(layoutCacheId, 0, 0, animated);
    },

    scrollToEnd: ({ animated = true }: { animated?: boolean } = {}) => {
      nativeMod.scrollToEnd(
        layoutCacheId,
        effectiveLayout.horizontal ?? false,
        viewportWidthRef.current, viewportHeightRef.current,
        animated,
      );
    },

    scrollToOffset: ({ x = 0, y = 0, animated = true }: RiffScrollOffsetOptions) => {
      nativeMod.scrollTo(layoutCacheId, x, y, animated);
    },

    scrollToItem: (key: string, options?: RiffScrollOptions) => {
      const isHoriz  = effectiveLayout.horizontal ?? false;
      const position = options?.position ?? (isHoriz ? 'start' : 'top');
      nativeMod.scrollToKey(
        layoutCacheId, key, isHoriz,
        viewportWidthRef.current, viewportHeightRef.current,
        hasStickyHeaders, hasStickyFooters,
        position,
        isHoriz ? prevScrollXRef.current : prevScrollYRef.current,
        options?.animated ?? true,
      );
    },

    getItemLayout: (key: string): LayoutAttributes | null => {
      return nativeLayoutCache.getAttributes(key) ?? null;
    },

    snapshot: () => new RiffSnapshot(data, keyExtractor),

    apply: (snap: RiffSnapshot<T>, setDataOrAnimated?: ((data: T[]) => void) | boolean, animated = true) => {
      // Resolve overloaded second arg: function = call-site setter, boolean = legacy animated flag.
      const callSiteSetter = typeof setDataOrAnimated === 'function' ? setDataOrAnimated : undefined;
      const isAnimated     = typeof setDataOrAnimated === 'boolean'  ? setDataOrAnimated : animated;
      const effectiveSetter = callSiteSetter ?? onDataChange;
      if (__DEV__ && !effectiveSetter) {
        console.warn(
          'Riff: apply() was called but no data setter is wired. ' +
          'Pass your state setter at the call site — ref.current.apply(snap, setData) — ' +
          'or wire onDataChange={setData} in JSX. Without one of these the data will not update.',
        );
      }
      // Build a raw-key → canonical-key map from current sections BEFORE the mutation.
      // Needed to normalize reloadedKeys (caller-supplied raw keys) to LayoutCache canonical format.
      // sectionedKeyExtractorCb already produces canonical keys via layoutContextRef.itemKeys,
      // so diff.removed is already canonical. Only reloadedKeys need this normalization.
      const rawToCanonical = new Map<string, string>();
      if (propSections && propKeyExtractor) {
        const ctx = layoutContextRef.current;
        for (let si = 0; si < propSections.length; si++) {
          const s = propSections[si]!;
          const sectionItemKeys = ctx?.sections[si]?.itemKeys;
          for (let ii = 0; ii < s.data.length; ii++) {
            const raw = propKeyExtractor(s.data[ii]!, ii);
            rawToCanonical.set(raw, sectionItemKeys?.[ii] ?? `${s.key}:${raw}`);
          }
        }
      }

      const { data: newData, reloadedKeys } = snap.apply();

      // Diff for LayoutAnimation — LayoutCache heights are managed by ShadowNode.
      // keyExtractor in sectioned mode reads from layoutContextRef.itemKeys (canonical).
      const oldKeys = data.map((item, i) =>
        keyExtractor ? keyExtractor(item, i) : String(i));
      const newKeys = newData.map((item, i) =>
        keyExtractor ? keyExtractor(item, i) : String(i));
      const diff = nativeMod.diffEngine.diff(oldKeys, newKeys);

      // Evict removed/reloaded items from LayoutCache so they re-measure.
      // diff.removed keys are canonical (from keyExtractor = sectionedKeyExtractorCb).
      // reloadedKeys are caller-supplied raw keys — normalize via rawToCanonical.
      for (const k of diff.removed) nativeLayoutCache.removeAttributes(k);
      for (const k of reloadedKeys) {
        nativeLayoutCache.removeAttributes(rawToCanonical.get(k) ?? k);
      }

      // LayoutAnimation for position changes (moves, shifts after insert/delete).
      // 350ms spring gives a clearly visible animation on absolute-positioned cells.
      if (isAnimated && (diff.moved.length > 0 || diff.removed.length > 0 || diff.inserted.length > 0)) {
        LayoutAnimation.configureNext({
          duration: 350,
          create:  { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
          update:  { type: LayoutAnimation.Types.spring, springDamping: 0.8 },
          delete:  { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
        });
      }

      // Commit inside startTransition so scroll is not interrupted
      React.startTransition(() => {
        effectiveSetter?.(newData);
      });
    },

    invalidateKeys: (keys: Iterable<string>) => {
      for (const k of keys) nativeLayoutCache.removeAttributes(k);
      if (__DEV__ && RNCV_HGEST_DIAG) diagRef.current.cvBumps++;
      setLayoutCacheVersion(v => v + 1);
    },

    scrollToIndex: (index: number, options?: RiffScrollOptions) => {
      const isHoriz  = effectiveLayout.horizontal ?? false;
      const position = options?.position ?? (isHoriz ? 'start' : 'top');
      nativeMod.scrollToIndexPath(
        layoutCacheId, 0, index, isHoriz,
        viewportWidthRef.current, viewportHeightRef.current,
        hasStickyHeaders, hasStickyFooters,
        position,
        isHoriz ? prevScrollXRef.current : prevScrollYRef.current,
        options?.animated ?? true,
      );
    },

    getItemLayoutAt: (index: number): LayoutAttributes | null => {
      const item = data[index];
      if (item == null) return null;
      const key = keyExtractor ? keyExtractor(item, index) : String(index);
      return nativeLayoutCache.getAttributes(key) ?? null;
    },

    invalidateAt: (indices: number[]) => {
      for (const index of indices) {
        const item = data[index];
        if (item == null) continue;
        const k = keyExtractor ? keyExtractor(item, index) : String(index);
        nativeLayoutCache.removeAttributes(k);
      }
      setLayoutCacheVersion(v => v + 1);
    },

    invalidateItem: (sectionIndex: number, itemIndex: number) => {
      const key = layoutContextRef.current?.sections[sectionIndex]?.itemKeys?.[itemIndex];
      if (key) nativeLayoutCache.removeAttributes(key);
      setLayoutCacheVersion(v => v + 1);
    },
  }), [data, keyExtractor, onDataChange, propSections, propKeyExtractor]); // eslint-disable-line react-hooks/exhaustive-deps -- onDataChange intentionally included; callSiteSetter is pass-through

  // ── remeasureOnItemChange — auto height-cache invalidation ───────────────────
  // Tracks item object identity per key. When data changes, scans items in the
  // current render+measure range (O(window), never O(n)). If an item reference
  // changed and remeasureOnItemChange returns true, evicts the cached height so
  // the cell re-measures on the next render.
  // Fires on any data prop change — including non-scroll triggers like a widget
  // content update — not just on scroll events.
  const prevItemMapRef = useRef<Map<string, T>>(new Map());
  useEffect(() => {
    // In sections mode, data[] contains FlatItem wrappers. Unwrap to get the raw T.
    const unwrap = (raw: T): T | null => {
      if (!isSectioned) return raw;
      const fi = raw as unknown as FlatItem<T>;
      return fi._kind === 'item' ? fi.item : null;
    };

    if (!remeasureOnItemChange) {
      // Still keep the map current so it's accurate if the prop is added later.
      if (data.length > 0 && keyExtractor) {
        for (let i = 0; i < data.length; i++) {
          const raw = data[i]!;
          const item = unwrap(raw);
          if (item == null) continue;
          const key = keyExtractor(raw, i);
          prevItemMapRef.current.set(key, item);
        }
      }
      return;
    }

    // Determine the range to scan: union of render + measure ranges.
    const rr = renderRange;
    const mr = measureRange;
    const scanFirst = Math.max(0, Math.min(rr?.first ?? 0, mr.first));
    const scanLast  = Math.min(data.length - 1, Math.max(rr?.last ?? -1, mr.last));

    const keysToInvalidate: string[] = [];
    for (let i = scanFirst; i <= scanLast; i++) {
      const raw = data[i];
      if (!raw) continue;
      const item = unwrap(raw);
      if (item == null) continue;
      const key = keyExtractor ? keyExtractor(raw, i) : String(i);
      const prev = prevItemMapRef.current.get(key);
      if (prev !== undefined && prev !== item && remeasureOnItemChange(prev, item)) {
        keysToInvalidate.push(key);
      }
      prevItemMapRef.current.set(key, item);
    }

    if (keysToInvalidate.length > 0) {
      setLayoutCacheVersion(v => v + 1);
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps -- intentional: only recheck when data changes

  // ── Debug callbacks ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!RNCV_DEBUG_CALLBACKS || !onRenderCountChange) return;
    const count = renderRange === null
      ? itemCount
      : Math.max(0, renderRange.last - renderRange.first + 1);
    onRenderCountChange(count, itemCount);
  }, [renderRange, itemCount, onRenderCountChange]);

  // Report mounted decoration count after every render.
  useLayoutEffect(() => {
    if (RNCV_DEBUG_CALLBACKS) onDecorationCountChange?.(decorationCountRef.current);
  });  // no deps — runs after every render

  // ── Layout helpers ───────────────────────────────────────────────────────────

  const onContainerLayout = useCallback((e: any) => {
    const w = Math.round(e.nativeEvent.layout.width);
    const h = Math.round(e.nativeEvent.layout.height);
    const wChanged = w !== viewportWidthRef.current;
    const hChanged = h !== viewportHeightRef.current;
    if (wChanged) { viewportWidthRef.current = w; setViewportWidth(w); }
    if (hChanged) { viewportHeightRef.current = h; setViewportHeight(h); }
    if ((wChanged || hChanged) && onContainerSizeChange) { onContainerSizeChange(w, h); }

    // ── Eager initial range: eliminate the blank-frame flash ────────────────
    // On the very first layout, renderRange is still null and the useEffect
    // hasn't run yet. We can compute a good-enough initial range right here
    // using the stride estimate — no layout cache needed. This lets React
    // mount the first screenful of cells in the SAME commit as the viewport
    // measurement, before any frame is painted.
    if (prevRenderRef.current === null && w > 0 && h > 0) {
      // Use stride-based arithmetic for the very first range (before layout cache is seeded).
      // Multi-column layouts (grid, masonry) pack N items per row, so the effective stride
      // per flat index is rowHeight / N. Without this, Phase A under-counts the visible range.
      const rawCols = (effectiveLayout.type === 'grid' || effectiveLayout.type === 'masonry')
        ? (effectiveLayout as any).delegate?.columns
        : undefined;
      const colCount = rawCols ? (typeof rawCols === 'function' ? rawCols(w) : rawCols as number) : 1;
      const effectiveStride = colCount > 1 ? stride / colCount : stride;
      const wc = nativeWindowController;
      const ws = wc.computeRanges(0, h, itemCount, effectiveStride, renderMultiplier, sectionInsetTop, 0);
      const budgeted = wc.applyBudget(ws.render.first, ws.render.last, ws.visible.first, ws.visible.last, effectiveMountedWindowSize, h, effectiveStride);
      prevRenderRef.current = budgeted;
      setRenderRange(budgeted);

      if (onViewableRangeChange) {
        const vF = ws.visible.first, vL = ws.visible.last;
        const rF = budgeted.first,   rL = budgeted.last;
        prevViewableRef.current = { visFirst: vF, visLast: vL, renFirst: rF, renLast: rL, measFirst: -1, measLast: -1 };
        onViewableRangeChange({ visible: { first: vF, last: vL }, render: { first: rF, last: rL } });
      }

      // Seed content height from estimates so scroll view has a size.
      const estContent = sectionInsetTop + itemCount * effectiveStride - itemSpacing + sectionInsetBottom;
      contentHeightRef.current = estContent;
      setContentHeight(estContent);
    }
  }, [itemCount, stride, budgetStride, renderMultiplier, sectionInsetTop, sectionInsetBottom, itemSpacing, effectiveMountedWindowSize]);

  // ── Scroll props ─────────────────────────────────────────────────────────────
  // ShadowNode handles measurement (Yoga) and scroll corrections natively.
  // No JS-side onCellLayout or batching needed.

  const contractProps: ScrollViewProps = {
    scrollEventThrottle: 16,
    ...scrollViewProps,
    onScroll: (e: any) => {
      nativeMod.signpost.begin(0);
      const { contentOffset, layoutMeasurement } = e.nativeEvent;
      const scrollY = contentOffset.y;
      const scrollX = contentOffset.x;
      const vpH     = layoutMeasurement.height || viewportHeight;
      const isHorizontal = effectiveLayout.horizontal ?? false;

      // Velocity is now derived natively in LayoutCache via CACurrentMediaTime —
      // no JS-side estimation needed. See PERF-PLAN.md "Scroll Path Ownership".
      prevScrollYRef.current  = scrollY;
      prevScrollXRef.current  = scrollX;

      const vpW = layoutMeasurement.width || viewportWidth;

      // Single C++ call: version check + 2×spatial query + applyBudget + computeMeasureRange.
      // Replaces 4-6 individual JSI calls. LayoutAttributes are never marshalled to JS —
      // spatial queries run entirely in C++ and return 7 integers.
      const scrollResult = nativeWindowController.processScroll(
        layoutCacheId,                           // B4.9: per-instance cache
        isHorizontal ? vpW    : vpH,             // vpPrimary
        isHorizontal ? vpH    : vpW,             // vpCross
        isHorizontal,
        renderMultiplier,
        budgetStride,
        measureAhead > 0 ? measureAhead : 0,
        effectiveMountedWindowSize,
        itemCount,
        sectionInfoPacked,                       // null for single-section
        budgetCols,
        !effectiveLayout.needsSpatialQuery,      // sorted: binary search for list/grid
      );

      // Change C: store frame data from processScroll. Not present on band-skip —
      // frameDataRef stays valid (cacheVersion unchanged = positions unchanged).
      if (scrollResult.frames) {
        frameDataRef.current = { frames: scrollResult.frames, first: scrollResult.framesFirst!, gen: renderGenRef.current, cacheVersion: scrollResult.cacheVersion };
      }

      // Cache version — check after processScroll so we read the same version
      // that was active during the spatial queries.
      const _lcvChanged = scrollResult.cacheVersion !== lastCacheVersionRef.current;
      if (_lcvChanged) {
        lastCacheVersionRef.current = scrollResult.cacheVersion;
        if (__DEV__ && RNCV_HGEST_DIAG) diagRef.current.cvBumps++;
        // Only trigger a JS re-render when content dimensions actually changed.
        // Most _version bumps are ShadowNode position corrections (cell heights
        // measured, items shifted) — those are applied natively and don't
        // require CollectionView to re-render. Without this guard, every
        // endBatch() in the ShadowNode produces a re-render (~60/s during
        // V scroll), even when neither the scroll area nor the render range changed.
        const _newSize = effectiveLayout.contentSize();
        if (_newSize.width  !== lastContentSizeRef.current.width ||
            _newSize.height !== lastContentSizeRef.current.height) {
          lastContentSizeRef.current = { width: _newSize.width, height: _newSize.height };
          if (__DEV__ && RNCV_HEALTH_DIAG) healthRef.current.vLCV++;
          scrollHandledCVRef.current = true; // H-6: tell useLayoutEffect to skip
          setLayoutCacheVersion(v => v + 1);
        }
      }

      // Keep windowing robust: always include visible span and pad by one cell
      // on both sides to avoid transient holes during fast/programmatic scroll.
      const budgetedR = {
        first: Math.max(0, Math.min(scrollResult.renderFirst, scrollResult.visibleFirst) - 1),
        last: Math.min(itemCount - 1, Math.max(scrollResult.renderLast, scrollResult.visibleLast) + 1),
      };
      const _rrChanged = rangeChanged(prevRenderRef.current, budgetedR);
      if (_rrChanged) {
        prevRenderRef.current = budgetedR;
        if (__DEV__ && RNCV_HEALTH_DIAG) healthRef.current.vRR++;
        setRenderRange(budgetedR);
      }

      // ── Scroll diagnostic (RNCV_DEBUG_LOGS) ────────────────────────────────
      // Logs a per-second summary: scroll rate, band-skip rate, and which state
      // changes are driving React re-renders. Use to confirm Opt 6 (band-skip)
      // and diagnose what's causing JS thread load.
      //
      // Band-skip: processScroll returned the same cacheVersion as last frame AND
      // the same render range → C++ skipped all spatial queries (Opt 6 fired).
      // lcvRender: Yoga measured a cell, cacheVersion bumped → full React re-render.
      // rrRender:  render window boundary moved → React re-render for new cells.
      //
      // Healthy steady-state scroll: bandSkip/s ≈ totalScroll/s, lcvRender/s ≈ 0.
      // Variable-height initial scroll: lcvRender/s ≈ totalScroll/s (measurements).
      if (__DEV__ && RNCV_DEBUG_LOGS) {
        const d = _diagRef.current;
        d.totalScroll++;
        const _isBandSkip = !_lcvChanged && !_rrChanged &&
          scrollResult.renderFirst === prevRenderRef.current.first &&
          scrollResult.renderLast  === prevRenderRef.current.last;
        if (_isBandSkip) d.bandSkip++;
        if (_lcvChanged) d.lcvRender++;
        if (_rrChanged)  d.rrRender++;
        const elapsed = Date.now() - d.windowStart;
        if (elapsed >= 1000) {
          const s = (elapsed / 1000).toFixed(1);
          console.log(
            `[RNCV-SCROLL] per ${s}s: scroll=${d.totalScroll} bandSkip=${d.bandSkip}` +
            ` lcvRender=${d.lcvRender} rrRender=${d.rrRender}` +
            ` (recycling: see [RNCV-CACHE] hitRate)`
          );
          d.totalScroll = 0; d.bandSkip = 0; d.lcvRender = 0; d.rrRender = 0;
          d.windowStart = Date.now();
        }
      }

      // Measure range — returned by processScroll when measureAheadMult > 0.
      if (measureAhead > 0) {
        const newMR = { first: scrollResult.measureFirst, last: scrollResult.measureLast };
        if (newMR.first !== prevMeasureRef.current.first || newMR.last !== prevMeasureRef.current.last) {
          prevMeasureRef.current = newMR;
          setMeasureRange(newMR);
        }
      }

      // P5.3 / onBlankArea — blank px computed inside processScroll (C++), zero marginal cost.
      // JS work (ref write + callback) only runs when RNCV_DEBUG_CALLBACKS is enabled.
      if (RNCV_DEBUG_CALLBACKS && onBlankArea && budgetedR.last >= budgetedR.first) {
        const offsetStart = scrollResult.blankBefore ?? 0;
        const offsetEnd   = scrollResult.blankAfter  ?? 0;
        lastBlankAreaRef.current = { offsetStart, offsetEnd };
        onBlankArea({ offsetStart, offsetEnd });
      }

      // onViewableRangeChange — fires only when a boundary actually changes.
      // visibleFirst/Last come directly from processScroll (already computed).
      if (onViewableRangeChange) {
        const vF = scrollResult.visibleFirst;
        const vL = scrollResult.visibleLast;
        const rF = budgetedR.first;
        const rL = budgetedR.last;
        const mF = measureAhead > 0 ? scrollResult.measureFirst : -1;
        const mL = measureAhead > 0 ? scrollResult.measureLast  : -1;
        const prev = prevViewableRef.current;
        if (!prev || prev.visFirst !== vF || prev.visLast !== vL ||
            prev.renFirst !== rF || prev.renLast !== rL ||
            prev.measFirst !== mF || prev.measLast !== mL) {
          prevViewableRef.current = { visFirst: vF, visLast: vL, renFirst: rF, renLast: rL, measFirst: mF, measLast: mL };
          const ranges: Parameters<typeof onViewableRangeChange>[0] = {
            visible: { first: vF, last: vL },
            render:  { first: rF, last: rL },
          };
          if (measureAhead > 0) ranges.measure = { first: mF, last: mL };
          onViewableRangeChange(ranges);
        }
      }

      // F1.3 — Prefetch/evict callbacks.
      // Range arithmetic is cheap (stays synchronous). The entering/leaving loops
      // — which iterate up to prefetchAhead × viewport items calling keyExtractor —
      // are deferred to setImmediate so they don't block the scroll handler.
      if ((onPrefetch || onEvict) && itemCount > 0 && prefetchAhead > 0) {
        const aheadItems = Math.ceil(prefetchAhead * vpH / stride);
        const newPR: Range = {
          first: Math.max(0, budgetedR.first - aheadItems),
          last:  Math.min(itemCount - 1, budgetedR.last + aheadItems),
        };
        const prevPR = prevPrefetchRangeRef.current;
        if (prevPR === null || newPR.first !== prevPR.first || newPR.last !== prevPR.last) {
          // Update the ref eagerly so the next scroll event sees the new range
          // even if the deferred callback hasn't executed yet.
          prevPrefetchRangeRef.current = newPR;

          // Coalesce: cancel any pending callback before scheduling a new one.
          if (pendingPrefetchRef.current !== null) {
            clearImmediate(pendingPrefetchRef.current);
          }

          // Snapshot prev/new ranges; close over props by reference (same JS thread).
          const snapshotPrev = prevPR;
          const snapshotNew  = newPR;
          pendingPrefetchRef.current = setImmediate(() => {
            pendingPrefetchRef.current = null;
            if (onPrefetch) {
              const entering: string[] = [];
              for (let i = snapshotNew.first; i <= snapshotNew.last; i++) {
                if (snapshotPrev === null || i < snapshotPrev.first || i > snapshotPrev.last) {
                  const d = data[i];
                  if (d !== undefined) entering.push(keyExtractor ? keyExtractor(d, i) : String(i));
                }
              }
              if (entering.length > 0) onPrefetch(entering);
            }
            if (onEvict && snapshotPrev !== null) {
              const leaving: string[] = [];
              for (let i = snapshotPrev.first; i <= snapshotPrev.last; i++) {
                if (i < snapshotNew.first || i > snapshotNew.last) {
                  const d = data[i];
                  if (d !== undefined) leaving.push(keyExtractor ? keyExtractor(d, i) : String(i));
                }
              }
              if (leaving.length > 0) onEvict(leaving);
            }
          });
        }
      }

      nativeMod.signpost.end(0);

      // Synthesize onContentSizeChange — topContentSizeChange is not a registered
      // Fabric event, so we detect size changes from the onScroll payload instead.
      // Native fires onScroll (with updated contentSize) from updateState: when
      // content size changes, even without user scrolling.
      const cs = e.nativeEvent.contentSize;
      const prev = prevContentSizeRef.current;
      if (isHorizontal && cs) {
        const vpCross = layoutMeasurement.height || viewportHeight;
        const nextAuto = Math.ceil(Math.max(0, cs.height));
        const looksLikeBootstrapViewportValue = Math.abs(nextAuto - vpCross) <= 1;
        const hasStableAuto = internalHorizontalHeightRef.current != null;
        // Avoid latching the initial full-viewport placeholder (creates a feedback loop).
        // Accept values that differ from viewport, or any value after we've established a stable baseline.
        if (nextAuto > 0 && (!looksLikeBootstrapViewportValue || hasStableAuto)) {
          if (internalHorizontalHeightRef.current !== nextAuto) {
            internalHorizontalHeightRef.current = nextAuto;
            setInternalHorizontalHeight(nextAuto);
          }
        }
      }

      const contentSizeChangeCb = onContentSizeChange ?? scrollViewProps?.onContentSizeChange;
      if (contentSizeChangeCb) {
        if (Math.abs(cs.width - prev.width) > 0.5 || Math.abs(cs.height - prev.height) > 0.5) {
          prevContentSizeRef.current = { width: cs.width, height: cs.height };
          contentSizeChangeCb(cs.width, cs.height);
        }
      }

      scrollViewProps?.onScroll?.(e);
    },
  };

  // ── Phase 2: H-section helpers ───────────────────────────────────────────────
  // Expose isHSection / hSectionInfo from CompositionalLayoutEngine when present.
  // CollectionView.tsx is layout-agnostic; these are optional protocol extensions.
  const isHSectionFn = ((effectiveLayout as any).isHSection as
    ((s: number) => boolean) | undefined)?.bind(effectiveLayout);
  const hSectionInfoFn = ((effectiveLayout as any).hSectionInfo as
    ((s: number) => HSectionMeta | null) | undefined)?.bind(effectiveLayout);
  // L-1: per-section layout type. H-list cells must not have width locked so
  // Yoga can measure intrinsic width freely. Only available on CompositionalLayout.
  const hSectionTypes = (effectiveLayout as any).sectionTypes as string[] | undefined;
  const handleHScroll = useCallback((event: any) => {
    // onHScroll fires from RNCollectionSubContainer (H-2) — adapted via
    // handleHSubScroll defined after this callback. Previously fired from
    // RNOrthogonalSectionView.
    // processHScroll returns the windowed H render range for this section,
    // plus a packed frame array (H-1) that renderCell uses to skip per-cell
    // attributesForItem JSI calls for H cells.
    //
    // Always overwrite the stored entry — even if the range didn't change,
    // the frame data may have updated (cacheVersion bump from a Yoga
    // measurement) and renderCell's H fast path needs the latest frames.
    // We only bump hRangeVersion (which forces a React re-render) when the
    // range actually changes, preserving the existing render-trigger semantics.
    if (!viewportWidth) return;
    const { sectionIndex, scrollX } = event.nativeEvent;
    // Save scrollX so re-entry can restore the correct render range.
    hScrollXMapRef.current.set(sectionIndex, scrollX);
    if (__DEV__ && RNCV_HGEST_DIAG) {
      const m = diagRef.current.hScrolls;
      m.set(sectionIndex, (m.get(sectionIndex) ?? 0) + 1);
    }
    const meta = hSectionInfoFn?.(sectionIndex);
    if (!meta || !meta.itemCount) return;
    // H-3.5: Section-specific override → hRenderMultiplier → renderMultiplier.
    const sectionMult = sectionWindowingOverrides.get(sectionIndex)?.renderMultiplier
      ?? hRenderMultiplier;
    const result = nativeWindowController.processHScroll(
      layoutCacheId,
      sectionIndex, scrollX, viewportWidth, sectionMult,
      meta.sectionY, meta.sectionHeight, meta.flatBase, meta.itemCount,
    );
    // H-4: Stable-band skip — C++ returns {unchanged: true} when range + cacheVersion
    // are identical to last call. Skip frame-data overwrite and React re-render.
    if (result.unchanged) {
      if (__DEV__ && RNCV_HEALTH_DIAG) healthRef.current.h4Skip++;
      return;
    }
    if (__DEV__ && RNCV_HEALTH_DIAG) healthRef.current.h4Compute++;
    const prev = hRenderRangesRef.current.get(sectionIndex);
    hRenderRangesRef.current.set(sectionIndex, {
      first: result.renderFirst,
      last: result.renderLast,
      frames: result.frames,
      framesFirst: result.framesFirst,
      gen: renderGenRef.current,
      cacheVersion: result.cacheVersion ?? lastCacheVersionRef.current,
    });
    const rangeChanged = !prev || prev.first !== result.renderFirst || prev.last !== result.renderLast;
    if (__DEV__ && RNCV_HGEST_DIAG) {
      // eslint-disable-next-line no-console
      console.log(`RNCV-H-GEST [s${sectionIndex}] handleHScroll x=${scrollX.toFixed(1)} ` +
        `range=${result.renderFirst}..${result.renderLast} ` +
        `frames=${result.frames?.length ?? 0} cw=${meta.contentWidth.toFixed(1)} ` +
        `cv=${result.cacheVersion ?? 'n/a'} bumpRender=${rangeChanged}`);
    }
    if (__DEV__ && RNCV_HSUB_LOGS) {
      const prevRange = prev ? `${prev.first}..${prev.last}` : 'NONE';
      const newRange  = `${result.renderFirst}..${result.renderLast}`;
      // eslint-disable-next-line no-console
      console.log(
        `[RNCV-HSUB-JS-SCROLL] s=${sectionIndex} x=${scrollX.toFixed(1)} ` +
        `vpW=${viewportWidth.toFixed(0)} mult=${sectionMult.toFixed(2)} ` +
        `cw=${meta.contentWidth.toFixed(1)} sectionH=${meta.sectionHeight.toFixed(1)} ` +
        `prevRange=${prevRange} newRange=${newRange} ` +
        `delta=${rangeChanged ? 'CHANGED' : 'same'} ` +
        `framesLen=${result.frames?.length ?? 0} cv=${result.cacheVersion ?? 'n/a'} ` +
        `willReRender=${rangeChanged}`
      );
    }
    // H-5: Coalesce H range changes into one React re-render per frame.
    // Multiple H sections scrolling simultaneously each fire separate native
    // events; without coalescing each would trigger its own full re-render.
    // The rAF callback also checks whether the delta cells overlap the current
    // V render range — if no V-mounted cells are affected, skip re-render
    // entirely (the ref is already updated and the next V-driven render will
    // pick up the new H range naturally).
    if (rangeChanged && !hRenderPendingRef.current) {
      hRenderPendingRef.current = true;
      requestAnimationFrame(() => {
        hRenderPendingRef.current = false;
        if (__DEV__ && RNCV_HEALTH_DIAG) healthRef.current.hReRender++;
        setHRangeVersion(v => v + 1);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportWidth, hRenderMultiplier, sectionWindowingOverrides, hSectionInfoFn]);

  // H-2: adapter that lets RNCollectionSubContainer drive the same windowing
  // logic as the old RNOrthogonalSectionView. The new event payload includes
  // both scrollX and scrollY; for horizontal sub-containers we only need scrollX.
  const handleHSubScroll = useCallback((event: any) => {
    handleHScroll({ nativeEvent: {
      sectionIndex: event.nativeEvent.sectionIndex,
      scrollX: event.nativeEvent.scrollX,
    }});
  }, [handleHScroll]);

  // ── Sticky supplementary config for ScrollCoordinatedView ───────────────────
  // Build a map: flatIndex → { kind, naturalY, boundaryY, primaryAxisExtent }
  // Each sticky cell is wrapped in RNScrollCoordinatedView in renderCell.
  // The native component handles the transform on the UI thread.
  // MUST be defined before renderCell / scrollContent IIFE that consumes it.

  const stickyConfigMap = useMemo(() => {
    if (!hasStickyHeaders && !hasStickyFooters) return null;
    const isHoriz = effectiveLayout.horizontal ?? false;
    const map = new Map<number, { kind: 'header' | 'footer'; naturalY: number; boundaryY: number; boundaryX: number; primaryAxisExtent: number }>();

    const allSticky = [
      ...stickyHeaderFlatIndices.map(fi => ({ fi, kind: 'header' as const })),
      ...stickyFooterFlatIndices.map(fi => ({ fi, kind: 'footer' as const })),
    ].sort((a, b) => a.fi - b.fi);

    for (let i = 0; i < allSticky.length; i++) {
      const { fi, kind: stickyKind } = allSticky[i]!;
      const fiDesc = isSectioned ? flattenResult?.flatData[fi] : null;
      
      let attr = null;
      if (isSectioned && fiDesc?._kind === 'header') {
        attr = effectiveLayout.attributesForSupplementary('header', fiDesc.sectionIndex);
      } else if (isSectioned && fiDesc?._kind === 'footer') {
        attr = effectiveLayout.attributesForSupplementary('footer', fiDesc.sectionIndex);
      } else {
        attr = effectiveLayout.attributesForItem(isSectioned ? ((fiDesc as any)?.itemIndex ?? fi) : fi, isSectioned ? (fiDesc?.sectionIndex ?? 0) : 0);
      }
      
      const naturalY = attr ? attr.frame.y : sectionInsetTop + fi * stride;
      // primaryAxisExtent: size along the scroll axis (width for horizontal, height for vertical).
      // For horizontal headers/footers frame.width is the primary-axis extent (e.g. 80px),
      // while frame.height is the cross-axis extent (viewportHeight). Native _headerHeight
      // must receive the primary-axis value for both push-boundary and footer positioning.
      const primaryAxisExtent = attr
        ? (isHoriz ? attr.frame.width : attr.frame.height)
        : effectiveItemHeight;

      // Push boundary differs by kind:
      // - Header: next section start — the next header pushes this one away from viewport top.
      // - Footer: current section start — footer shouldn't be pulled above its own section.
      let boundaryY = 999999;
      if (isSectioned && typeof fiDesc?.sectionIndex === 'number') {
        if (stickyKind === 'footer') {
          // Footer boundary = section's own header Y (or first item Y if no header).
          const sectionHeader = effectiveLayout.attributesForSupplementary('header', fiDesc.sectionIndex);
          if (sectionHeader) {
            boundaryY = sectionHeader.frame.y;
          } else {
            const firstItem = effectiveLayout.attributesForItem(0, fiDesc.sectionIndex);
            if (firstItem) boundaryY = firstItem.frame.y;
          }
        } else {
          // Header boundary = next section start.
          const nextSection = fiDesc.sectionIndex + 1;
          if (propSections && nextSection < propSections.length) {
            const nextHeader = effectiveLayout.attributesForSupplementary('header', nextSection);
            if (nextHeader) {
              boundaryY = nextHeader.frame.y;
            } else {
              const nextFirst = effectiveLayout.attributesForItem(0, nextSection);
              if (nextFirst) boundaryY = nextFirst.frame.y;
            }
          }
        }
      }

      // Horizontal: compute X-axis boundary (mirrors Y-axis logic above).
      let boundaryX = 999999;
      if (isHoriz && isSectioned && typeof fiDesc?.sectionIndex === 'number') {
        if (stickyKind === 'footer') {
          const sectionHeader = effectiveLayout.attributesForSupplementary('header', fiDesc.sectionIndex);
          if (sectionHeader) {
            boundaryX = sectionHeader.frame.x;
          } else {
            const firstItem = effectiveLayout.attributesForItem(0, fiDesc.sectionIndex);
            if (firstItem) boundaryX = firstItem.frame.x;
          }
        } else {
          const nextSection = fiDesc.sectionIndex + 1;
          if (propSections && nextSection < propSections.length) {
            const nextHeader = effectiveLayout.attributesForSupplementary('header', nextSection);
            if (nextHeader) {
              boundaryX = nextHeader.frame.x;
            } else {
              const nextFirst = effectiveLayout.attributesForItem(0, nextSection);
              if (nextFirst) boundaryX = nextFirst.frame.x;
            }
          }
        }
      }

      rncvVerboseLog(`[RNCVX-STICKY] kind=${stickyKind} sIdx=${fiDesc?.sectionIndex} naturalY=${naturalY} boundaryY=${boundaryY} attrOk=${!!attr} fi=${fi}`);
      rncvLog('RNCV-JS-STICKY', {
        op: 'stickyConfigMap-entry',
        fi,
        sectionIndex: fiDesc?.sectionIndex,
        kind: stickyKind,
        attrHit: !!attr,
        naturalY,
        boundaryY,
        boundaryX,
        primaryAxisExtent,
      });
      map.set(fi, { kind: stickyKind, naturalY, boundaryY, boundaryX, primaryAxisExtent });
    }
    return map;
  }, [hasStickyHeaders, hasStickyFooters, stickyHeaderFlatIndices, stickyFooterFlatIndices,
      effectiveLayout, effectiveItemHeight, sectionInsetTop, stride, isSectioned, flattenResult, propSections,
      // eslint-disable-next-line react-hooks/exhaustive-deps
      layoutCacheVersion]);

  // ── Content ──────────────────────────────────────────────────────────────────

  const rr = renderRange;

  // measureOnly=true  → cell is in the measure range but NOT the render range.
  //   Parked at top:-9999 so it's invisible; CellMeasureContainer captures its
  //   height; Activity=hidden suppresses user-cell effects.
  //   When the cell scrolls into the render range it is promoted in-place (just
  //   a style update — no unmount/remount) so positions are already known.
  // measureOnly=false → normal render-range cell (existing behaviour).
  // reactKey: when provided (slot mode), overrides the React key derived from
  // keyExtractor. Stable slot keys let the Fiber survive recycling (Opt 4).
  const renderCell = (item: T, index: number, measureOnly = false, reactKey?: string) => {
    const key  = reactKey ?? (keyExtractor ? keyExtractor(item, index) : String(index));
    // cacheKey: LayoutCache identity. Use the shared computeCacheKey helper so
    // SlotManager and renderCell always produce the same key for a given index.
    const cacheKey = computeCacheKey(index);
    // fiDesc needed for attr lookup, supplementary detection, and sticky config below.
    const fiDesc = isSectioned ? flattenResult?.flatData[index] : null;

    // Render-range cells are Activity=visible. Measure-range cells use
    // Activity=hidden so Fabric computes their Yoga layout without painting.
    // ShadowNode measures all children via Yoga and writes heights to LayoutCache.
    const mode: 'visible' | 'hidden' = measureOnly ? 'hidden' : 'visible';

    let cellWidth = itemWidth;
    // attrHeight: cross-axis (height for V, width for H) — only used for H supplementaries.
    let attrHeight = 0;
    // frameX/frameY: absolute position from LayoutCache — used for H-section absolute CSS.
    let frameX = 0;
    let frameY = 0;

    // Early H-section detection: needed for both the H-cell fast path below
    // and to choose the right Y semantic in containerStyle (section-local vs V-absolute).
    const cellSectionIdxEarly = (fiDesc as any)?.sectionIndex ?? 0;
    const isHCellEarly = !measureOnly && fiDesc?._kind === 'item' && !!isHSectionFn?.(cellSectionIdxEarly);

    // Change C / H-1: read width/height/x/y from a packed frame array instead
    // of making a per-cell attributesForItem JSI call.
    //
    //  - V cells use frameDataRef populated by processScroll (whole render range).
    //  - H cells (H-1) use hRenderRangesRef[sectionIndex] populated by
    //    processHScroll. H frames are stored in section-local Y so they remain
    //    valid even when MVC reflows V sections above this section.
    //
    // Guards (both paths):
    //  - gen === renderGen        — invalidates on extraData/layout/vpWidth changes.
    //  - cacheVersion match       — invalidates on data-shape mutations
    //                                (insert/delete/resize). prepare() runs
    //                                synchronously in a useMemo above, so
    //                                lastCacheVersionRef.current already reflects
    //                                the post-mutation version when renderCell
    //                                executes. Without this check, the OLD frame
    //                                array would be re-indexed by NEW flat
    //                                indices, handing items header/footer widths
    //                                and vice versa.
    let frameSource: 'fd' | 'jsi' = 'jsi';
    // frameYIsLocal: true when frameY came from the H fast path (section-local).
    // false when from V fast path (V-absolute) or JSI fallback (V-absolute).
    // Drives the containerStyle top semantic for H cells below.
    let frameYIsLocal = false;

    if (isHCellEarly) {
      const hf = hRenderRangesRef.current.get(cellSectionIdxEarly);
      if (
        hf?.frames &&
        hf.framesFirst !== undefined &&
        hf.gen === renderGen &&
        hf.cacheVersion === lastCacheVersionRef.current &&
        index >= hf.framesFirst &&
        index < hf.framesFirst + (hf.frames.length >> 2)
      ) {
        frameSource = 'fd';
        frameYIsLocal = true;
        const off = (index - hf.framesFirst) * 4;
        frameX = hf.frames[off];
        frameY = hf.frames[off + 1];  // section-local
        const w = hf.frames[off + 2];
        if (w > 0) cellWidth = w;
        attrHeight = hf.frames[off + 3];
      }
    } else {
      const fd = frameDataRef.current;
      if (
        fd &&
        fd.gen === renderGen &&
        fd.cacheVersion === lastCacheVersionRef.current &&
        index >= fd.first &&
        index < fd.first + (fd.frames.length >> 2)
      ) {
        frameSource = 'fd';
        const off = (index - fd.first) * 4;
        frameX = fd.frames[off];
        frameY = fd.frames[off + 1];
        const w = fd.frames[off + 2];
        if (w > 0) cellWidth = w;
        attrHeight = fd.frames[off + 3];
      }
    }

    if (frameSource === 'jsi') {
      // Fallback to attributesForItem JSI for cases the fast path doesn't cover:
      //   - V cells outside frameDataRef range (e.g. sticky cells outside [measureFirst, measureLast])
      //   - H cells when hRenderRangesRef entry is stale or absent
      //   - supplementaries (headers/footers) — never in the H frame array
      let attr = null;
      if (isSectioned) {
        if (fiDesc?._kind === 'header') {
          attr = effectiveLayout.attributesForSupplementary('header', fiDesc.sectionIndex);
        } else if (fiDesc?._kind === 'footer') {
          attr = effectiveLayout.attributesForSupplementary('footer', fiDesc.sectionIndex);
        } else {
          attr = effectiveLayout.attributesForItem((fiDesc as any)?.itemIndex ?? index, fiDesc?.sectionIndex ?? 0);
        }
      } else {
        attr = effectiveLayout.attributesForItem(index, 0);
      }
      if (attr) {
        frameX = attr.frame.x;
        frameY = attr.frame.y;  // V-absolute (LayoutCache stores V-absolute after finalizeHSection)
        cellWidth = attr.frame.width;
        attrHeight = attr.frame.height;
      }
    }
    rncvLog('RNCV-JS-CELL', {
      op: 'layout-attr',
      index,
      measureOnly,
      kind: fiDesc?._kind,
      sectionIndex: fiDesc?.sectionIndex,
      cacheKey,
      attrHeight,
      cellWidth,
    });

    // For horizontal layouts the cross-axis dimension (height) is determined by the engine:
    //
    // H-grid / H-list cross-axis height locking:
    //   Cells are NEVER height-locked — Yoga measures natural content height.
    //   Engine tracks global max measured item height and updates container accordingly.
    //   Supplementaries ARE locked — their height = computed cross extent from engine.
    const isHorizLayout = (effectiveLayout.horizontal ?? false);
    const isHorizSupplementary = isHorizLayout &&
        (fiDesc?._kind === 'header' || fiDesc?._kind === 'footer');

    // Phase 2: H-section cells (orthogonal sections in compositional layout).
    //
    // H-2: H-section cells are children of RNCollectionSubContainer, whose
    // own ShadowNode reads cache positions and the iOS view applies frames
    // natively via tag→view map (same model as the main container). Cells
    // therefore need NO absolute positioning in JS — they live as flex
    // children and get repositioned by the native side every state update.
    //
    // We still hint a width when the layout has computed one, so Yoga lays
    // out content at the correct cross-axis size on first frame (before the
    // ShadowNode's apply pass runs). Height is left unconstrained so Yoga
    // can measure naturally; the sub-container ShadowNode reads that
    // measured height back via Yoga's layout metrics on the next pass.
    const cellSectionIndex = fiDesc?.sectionIndex ?? 0;
    const isHSectionCell = !measureOnly && !!isHSectionFn?.(cellSectionIndex);

    // L-1/L-2/L-3: cells that should NOT have width locked so Yoga measures
    // intrinsic content width freely. applyMeasurements reads it back as a
    // Width delta and reflows positions.
    //   L-1: standalone H-list + compositional H-list scroll items
    //   L-2: standalone H-grid + compositional H-grid scroll items
    //   L-3: standalone V-flow scroll items — widths drive bin-packing row
    //        assignment; FlowLayout::applyMeasurements does a full reflow.
    // Supplementaries (header/footer) are excluded in all cases.
    // H-masonry/flow and V-list/grid/masonry keep width = container/column width.
    const isScrollItem = fiDesc?._kind !== 'header' && fiDesc?._kind !== 'footer';
    // L-3: standalone V-flow cell (not in an H-section sub-container).
    const isVFlowCell = !isHorizLayout && effectiveLayout.type === 'flow' && !isHSectionCell && isScrollItem;
    const isHFreeWidthCell =
      (isHorizLayout && !isHSectionCell && isScrollItem)                            // standalone H-list/grid items (L-1/L-2)
      || (isHSectionCell && isScrollItem && (
           hSectionTypes?.[cellSectionIndex] === 'list' ||
           hSectionTypes?.[cellSectionIndex] === 'grid'
         ))                                                                          // compositional H-list and H-grid items (L-1/L-2)
      || isVFlowCell;                                                               // standalone V-flow items (L-3)

    const containerStyle: StyleProp<ViewStyle> = isHSectionCell ? [
      {
        // H-2: no position:absolute. Frame applied natively by ShadowNode.
        // L-1/L-2: omit width + alignSelf:flex-start so Yoga measures intrinsic
        // content width (not stretched to container/viewport width).
        // H-masonry/flow: keep width hint from cache.
        ...(!isHFreeWidthCell && viewportWidth > 0 && cellWidth > 0 ? { width: cellWidth } : {}),
        ...(isHFreeWidthCell ? { alignSelf: 'flex-start' as const } : {}),
      },
    ] : [
      {
        // V layouts: keep width = container width. Standalone H-list/grid (L-1/L-2): omit width.
        // L-3 V-flow: omit width, cap at viewport so content can't overflow.
        ...(viewportWidth > 0 && !isHFreeWidthCell ? { width: cellWidth } : {}),
        ...(isHorizSupplementary && attrHeight > 0 ? { height: attrHeight } : {}),
        ...(isHFreeWidthCell ? { alignSelf: 'flex-start' as const } : {}),
        ...(isVFlowCell && viewportWidth > 0 ? { maxWidth: viewportWidth } : {}),
      },
    ];

    // ShadowNode measures via Yoga — no RNMeasuredCell wrapping needed.
    // For H-free-width cells: wrap in a thin View with alignSelf+alignItems=flex-start.
    // Without this, the consumer's cell (alignSelf:auto) inherits the outer wrapper's
    // alignItems:stretch, causing a circular Yoga sizing dependency that resolves to
    // vpWidth. The inner wrapper breaks the cycle: its alignItems:flex-start propagates
    // to the consumer cell via alignSelf:auto inheritance, so the cell measures to its
    // actual text/content width instead of filling the container.
    const cellContent = <MemoizedCellContent item={item} index={index} renderItem={stableRenderItem} extraData={extraData} />;
    const content = (
      <CellWrapper mode={mode}>
        {isHFreeWidthCell
          ? <View style={hFreeWidthInnerStyle}>{cellContent}</View>
          : cellContent}
      </CellWrapper>
    );

    const stickyConfig = stickyConfigMap?.get(index);
    rncvLog('RNCV-JS-CELL', {
      op: 'render-branch',
      index,
      measureOnly,
      kind: fiDesc?._kind,
      sectionIndex: fiDesc?.sectionIndex,
      cacheKey,
      stickyConfig: !!stickyConfig,
      branch: stickyConfig && !measureOnly ? 'RNScrollCoordinatedView' : 'RNMeasuredCell',
    });

    if (stickyConfig && !measureOnly) {
      // RNScrollCoordinatedView IS the cell container — its transform must be
      // on the direct child of the scroll content view.  If it were wrapped in
      // a plain <View>, UIScrollView's clipsToBounds would clip the wrapper
      // once it scrolled above the viewport, hiding the transformed child.
      const isHorizLayout = effectiveLayout.horizontal ?? false;
      return (
        <RNScrollCoordinatedView
          key={key}
          style={containerStyle}
          behavior={stickyMode}
          naturalY={stickyConfig.naturalY}
          boundaryY={stickyConfig.boundaryY}
          boundaryX={stickyConfig.boundaryX}
          horizontal={isHorizLayout}
          headerHeight={stickyConfig.primaryAxisExtent}
          enabled={true}
          type="supplementary"
          kind={stickyConfig.kind}
          index={index}
          cacheKey={cacheKey}
          isMeasureOnly={measureOnly}
        >
          {content}
        </RNScrollCoordinatedView>
      );
    }

    // H-section cell measurement is handled by ShadowNode grandchild iteration:
    // correctChildPositionsIfNeeded() iterates RNOrthogonalSectionView children,
    // reads Yoga-measured heights, and builds MVC deltas — no JS onLayout needed.

    return (
      <RNMeasuredCell
        key={key}
        style={containerStyle}
        type="cell"
        index={index}
        cacheKey={cacheKey}
        isMeasureOnly={measureOnly}
      >
        {content}
      </RNMeasuredCell>
    );
  };

  // Compute the effective rendering range:
  //   · Fixed height: just the render range (no measure extension needed).
  //   · Variable height: union of renderRange + measureRange so pre-measurement
  //     cells are mounted off-screen while render-range cells stay at their
  //     correct positions. The union ensures render-range cells are always
  //     included even if startTransition for measureRange hasn't flushed yet.
  // Build a Set of ALL sticky indices (O(1) lookup in windowed loop)
  // and a windowed Set of the ones we actually mount this frame.
  // We keep: 1 before active + active + 2 after = 4 max.
  // This is enough for smooth push transitions and fast-scroll buffer,
  // without mounting every sticky in a 1000-section list.
  const STICKY_BUFFER_BEFORE = 1;
  const STICKY_BUFFER_AFTER  = 2;

  // In ShadowNode mode, the `cells` array no longer needs to be contiguous.
  // The C++ layer explicitly identifies each child by its `index` prop.
  // We can safely prepend sticky headers and skip them in the main loop!

  // ── Opt 7: render generation — bump when any global rendering dep changes ──
  // extraData, effectiveLayout, viewportWidth all affect how cells are rendered
  // regardless of which slot they're in. When these change, all cached elements
  // are stale and must be re-created on next render.
  //
  // stickyConfigMap is intentionally excluded: sticky cells are rendered outside
  // the slot-based element cache loop (prepended separately). Including it caused
  // a cascade: layoutCacheVersion bump → new stickyConfigMap reference → renderGen++
  // → ALL element cache entries invalidated → O(window_size) re-render on every
  // scroll tick where a Yoga measurement occurred (defeating Opt 4+7 entirely).
  const _curCacheDeps = { extraData, layout: effectiveLayout, vpWidth: viewportWidth };
  if (
    prevCacheDepsRef.current === null ||
    _curCacheDeps.extraData !== prevCacheDepsRef.current.extraData ||
    _curCacheDeps.layout    !== prevCacheDepsRef.current.layout ||
    _curCacheDeps.vpWidth   !== prevCacheDepsRef.current.vpWidth
  ) {
    renderGenRef.current++;
    prevCacheDepsRef.current = _curCacheDeps;
    // Bug fix: invalidate decoration cache synchronously on layout/data change.
    // layoutCacheVersion is bumped async (RAF) so without this, the decoration
    // cache hits on the insert render, serving the stale section background frame.
    lastDecoCacheRef.current = { ...lastDecoCacheRef.current, lcv: -1 };
  }
  const renderGen = renderGenRef.current;

  // ── computeCacheKey: LayoutCache identity key for a flat index ─────────────
  // Extracted from renderCell so SlotManager can pre-compute it in sync().
  // Must stay in sync with the cacheKey derivation inside renderCell below.
  const computeCacheKey = (index: number): string => {
    const fd = isSectioned ? flattenResult?.flatData[index] : null;
    const sk = fd ? fd.sectionIndex : 0;
    const ik = fd && fd._kind === 'item' ? fd.itemIndex : index;
    // Delegate key construction to the layout engine — single source of truth.
    // cacheKeyForSupplementary/cacheKeyForItem match what C++ writes to LayoutCache.
    if (fd?._kind === 'header') {
      return effectiveLayout.cacheKeyForSupplementary?.('header', sk)
        ?? `${effectiveLayout.type === 'list' ? 'item' : effectiveLayout.type}-${sk}-header`;
    }
    if (fd?._kind === 'footer') {
      return effectiveLayout.cacheKeyForSupplementary?.('footer', sk)
        ?? `${effectiveLayout.type === 'list' ? 'item' : effectiveLayout.type}-${sk}-footer`;
    }
    return effectiveLayout.cacheKeyForItem?.(ik, sk)
      ?? (layoutContext?.sections[sk]?.itemKeys?.[ik]
        ?? `${effectiveLayout.keyPrefixForSection?.(sk) ?? (effectiveLayout.type === 'list' ? 'item' : effectiveLayout.type)}-${sk}-${ik}`);
  };

  let effFirst = 0;
  let effLast = -1;

  const stickyIndexSet = useMemo(
    () => stickyConfigMap ? new Set(stickyConfigMap.keys()) : null,
    [stickyConfigMap],
  );

  let mountedStickySet: Set<number> | null = null;
  let stickyHeaderCells: React.ReactElement[] | null = null;
  let stickyFooterCells: React.ReactElement[] | null = null;

  if (stickyConfigMap && stickyIndexSet && (stickyHeaderFlatIndices.length > 0 || stickyFooterFlatIndices.length > 0)) {
    const isHoriz = effectiveLayout.horizontal ?? false;
    const scrollPrimary = isHoriz ? prevScrollXRef.current : prevScrollYRef.current;
    const vpPrimary = isHoriz
      ? (viewportWidthRef.current || viewportWidth)
      : (viewportHeightRef.current || viewportHeight);

    mountedStickySet = new Set<number>();

    if (stickyHeaderFlatIndices.length > 0) {
      // Active header: last one whose natural position ≤ scroll offset
      let activeSlot = 0;
      for (let i = stickyHeaderFlatIndices.length - 1; i >= 0; i--) {
        const fi = stickyHeaderFlatIndices[i]!;
        const sd = isSectioned ? flattenResult?.flatData[fi] : null;
        const attr = (isSectioned && sd?._kind === 'header')
          ? effectiveLayout.attributesForSupplementary('header', sd.sectionIndex)
          : effectiveLayout.attributesForItem(isSectioned ? ((sd as any)?.itemIndex ?? fi) : fi, isSectioned ? (sd?.sectionIndex ?? 0) : 0);
        const pos = attr
          ? (isHoriz ? attr.frame.x : attr.frame.y)
          : sectionInsetTop + fi * stride;
        if (pos <= scrollPrimary) { activeSlot = i; break; }
      }

      const first = Math.max(0, activeSlot - STICKY_BUFFER_BEFORE);
      const last  = Math.min(stickyHeaderFlatIndices.length - 1, activeSlot + STICKY_BUFFER_AFTER);
      stickyHeaderCells = [];
      for (let s = first; s <= last; s++) {
        const fi = stickyHeaderFlatIndices[s]!;
        if (!data[fi]) continue;
        mountedStickySet.add(fi);
        stickyHeaderCells.push(renderCell(data[fi]!, fi, false));
      }
    }

    if (stickyFooterFlatIndices.length > 0) {
      // Active footer: last one whose natural position ≤ (scroll + viewport - size)
      let activeSlot = 0;
      for (let i = stickyFooterFlatIndices.length - 1; i >= 0; i--) {
        const fi = stickyFooterFlatIndices[i]!;
        const sd = isSectioned ? flattenResult?.flatData[fi] : null;
        const attr = (isSectioned && sd?._kind === 'footer')
          ? effectiveLayout.attributesForSupplementary('footer', sd.sectionIndex)
          : effectiveLayout.attributesForItem(isSectioned ? ((sd as any)?.itemIndex ?? fi) : fi, isSectioned ? (sd?.sectionIndex ?? 0) : 0);
        const pos = attr
          ? (isHoriz ? attr.frame.x : attr.frame.y)
          : sectionInsetTop + fi * stride;
        const sz = attr
          ? (isHoriz ? attr.frame.width : attr.frame.height)
          : effectiveItemHeight;
        if (pos <= (scrollPrimary + vpPrimary - sz)) { activeSlot = i; break; }
      }

      const first = Math.max(0, activeSlot - STICKY_BUFFER_BEFORE);
      const last  = Math.min(stickyFooterFlatIndices.length - 1, activeSlot + STICKY_BUFFER_AFTER);
      stickyFooterCells = [];
      for (let s = first; s <= last; s++) {
        const fi = stickyFooterFlatIndices[s]!;
        if (!data[fi]) continue;
        mountedStickySet.add(fi);
        stickyFooterCells.push(renderCell(data[fi]!, fi, false));
      }
    }
  }

  const scrollContent = (() => {
    if (!viewportWidth && rr !== null) return null;

    // ── Opt 4 + Opt 7: SlotManager-based cell rendering ─────────────────────
    //
    // SlotManager assigns stable slot keys to flat indices. When the render
    // window shifts, slots are recycled — the Fiber for slot_N survives and
    // receives prop updates instead of being unmounted and remounted.
    //
    // Opt 7 (element cache): if a slot's state (dataKey, cacheKey, measureOnly)
    // hasn't changed AND no global rendering dep has changed (same renderGen),
    // we reuse the cached ReactElement reference. React's reconciler sees
    // referential equality and skips diffing the subtree entirely — O(delta)
    // render loop instead of O(window_size).

    const smFirst = rr !== null ? rr.first : 0;
    const smLast  = rr !== null
      ? Math.min(rr.last, data.length - 1)
      : Math.min(initialNumToRender - 1, data.length - 1);
    const hasMR = measureRange.last >= measureRange.first;

    // Auto pool size: track render window so all exiting items can be pooled,
    // guaranteeing zero steady-state cold mounts. Consumer can override with
    // recyclePoolSize prop to cap memory at the cost of more cold mounts.
    //
    // Floor includes max H render window. Each H section's render range fits
    // entirely in one pool (cells of the same itemType), and during bounce
    // the visible cells churn in and out of the pool a full window's worth.
    // Without this floor, a pure-H demo with V window=1 (single section)
    // would set maxPoolSize=4, overflow the pool on bounce-back, discard
    // slots, and cold-mount the rebound cells — visible as the `MISSING tag`
    // → new tag transition seen in user logs at the bounce edge.
    let _maxHWindow = 0;
    for (const [, r] of hRenderRangesRef.current) {
      const span = r.last - r.first + 1;
      if (span > _maxHWindow) _maxHWindow = span;
    }
    slotManagerRef.current.maxPoolSize =
      recyclePoolSize !== undefined
        ? recyclePoolSize
        : Math.max(smLast - smFirst + 1, _maxHWindow * 2, 8);

    // H-section windowing: build exclusion set for items outside their H viewport.
    // Items in an H section that are within the V render range but outside the
    // H render range don't get slots — they're released to the recycle pool.
    //
    // We only initialize an entry when none exists (first render or after
    // prepare() clears the map on data-shape mutations). On every actual H
    // scroll tick, handleHScroll overwrites the entry with the current
    // scrollX result — that path is the authority for window updates.
    //
    // CRITICAL: do NOT recompute here when the entry is "stale" by gen/
    // cacheVersion. cacheVersion bumps on every Yoga measurement, and a
    // recompute at scrollX=0 would wipe the user's actual H scroll position
    // (we don't track per-section scrollX in JS, so we can't recompute
    // meaningfully). renderCell's H fast path already gates on
    // gen+cacheVersion and falls through to JSI when frames are stale, so
    // frame freshness is handled there — windowing is independent.
    let hExcludeIndices: Set<number> | undefined;
    const currHSectionsRendered = new Set<number>();
    if (isHSectionFn && hSectionInfoFn && layoutContext) {
      const sectionCount = layoutContext.sections.length;
      const prevHSet = prevHSectionsRenderedRef.current;
      for (let sIdx = 0; sIdx < sectionCount; sIdx++) {
        if (!isHSectionFn(sIdx)) continue;
        const meta = hSectionInfoFn(sIdx);
        if (!meta || !meta.itemCount) continue;

        // Detect whether this H section has ANY items in the V render range
        // [smFirst, smLast]. Sections that re-enter after being scrolled away
        // had their wrapper recycled by Fabric and their UIScrollView's
        // contentOffset.x restored to the saved position by native code.
        // Clear the cached hRange on re-entry so the !hRange branch below
        // recomputes a window at the saved scrollX (matching native restore).
        const sectionStartFi = meta.flatBase;
        const sectionEndFi   = meta.flatBase + meta.itemCount - 1;
        const isInVRange     = !(sectionEndFi < smFirst || sectionStartFi > smLast);
        let didReEntryClear = false;
        if (isInVRange) {
          currHSectionsRendered.add(sIdx);
          if (!prevHSet.has(sIdx)) {
            hRenderRangesRef.current.delete(sIdx);
            didReEntryClear = true;
          }
        }

        let hRange = hRenderRangesRef.current.get(sIdx);
        let didInitCompute = false;
        if (!hRange && viewportWidth > 0) {
          // Compute initial window. On first render this is scrollX=0.
          // On re-entry after recycle, use the saved scrollX so the render
          // range matches what the native view will restore to.
          const savedX = hScrollXMapRef.current.get(sIdx) ?? 0;
          if (__DEV__ && RNCV_HEALTH_DIAG && savedX > 0) healthRef.current.hRestore++;
          const initMult = sectionWindowingOverrides.get(sIdx)?.renderMultiplier
            ?? hRenderMultiplier;
          const result = nativeWindowController.processHScroll(
            layoutCacheId,
            sIdx, savedX, viewportWidth, initMult,
            meta.sectionY, meta.sectionHeight, meta.flatBase, meta.itemCount,
          );
          hRange = {
            first: result.renderFirst,
            last: result.renderLast,
            frames: result.frames,
            framesFirst: result.framesFirst,
            gen: renderGenRef.current,
            cacheVersion: result.cacheVersion ?? lastCacheVersionRef.current,
          };
          hRenderRangesRef.current.set(sIdx, hRange);
          didInitCompute = true;
        }
        if (!hRange) {
          if (__DEV__ && RNCV_HSUB_LOGS && isInVRange) {
            // eslint-disable-next-line no-console
            console.log(
              `[RNCV-HSUB-JS-WIN] s=${sIdx} inV=YES vpW=${viewportWidth.toFixed(0)} ` +
              `prevHSet=${prevHSet.has(sIdx) ? 'YES' : 'NO'} ` +
              `reentry=${didReEntryClear ? 'YES' : 'no'} ` +
              `hRange=NONE skipped (no viewport yet)`
            );
          }
          continue;
        }

        let excludedForSection = 0;
        for (let fi = meta.flatBase; fi < meta.flatBase + meta.itemCount; fi++) {
          if (fi < hRange.first || fi > hRange.last) {
            if (!hExcludeIndices) hExcludeIndices = new Set<number>();
            hExcludeIndices.add(fi);
            excludedForSection++;
          }
        }

        if (__DEV__ && RNCV_HSUB_LOGS) {
          // eslint-disable-next-line no-console
          console.log(
            `[RNCV-HSUB-JS-WIN] s=${sIdx} inV=${isInVRange ? 'YES' : 'no'} ` +
            `prevHSet=${prevHSet.has(sIdx) ? 'YES' : 'NO'} ` +
            `reentry=${didReEntryClear ? 'YES' : 'no'} ` +
            `init=${didInitCompute ? 'YES' : 'no'} ` +
            `range=${hRange.first}..${hRange.last} ` +
            `flatBase=${meta.flatBase} itemCount=${meta.itemCount} ` +
            `cw=${meta.contentWidth.toFixed(1)} sectionH=${meta.sectionHeight.toFixed(1)} ` +
            `gen=${hRange.gen} cv=${hRange.cacheVersion} ` +
            `excluded=${excludedForSection}`
          );
        }
      }
      // Snapshot the current set for next render's re-entry detection.
      prevHSectionsRenderedRef.current = currHSectionsRendered;
    }

    const activeSlots: Map<string, SlotInfo<any>> = slotManagerRef.current.sync(
      smFirst,
      smLast,
      hasMR ? measureRange.first : null,
      hasMR ? measureRange.last  : null,
      (i) => keyExtractor ? keyExtractor(data[i], i) : String(i),
      (i) => {
        const fd = isSectioned ? (flattenResult?.flatData[i] as any) : null;
        const kind = fd?._kind;
        if (kind === 'header' || kind === 'footer') {
          // Use consumer-supplied supplementary type when provided.
          return propGetSupplementaryType
            ? propGetSupplementaryType(kind, fd.sectionIndex ?? 0)
            : kind;
        }
        // Items use consumer-supplied type when provided, else single 'item' pool.
        return propGetItemType ? propGetItemType(data[i], i) : 'item';
      },
      computeCacheKey,
      // Section index source — captured once per assignment into SlotInfo
      // so pooled slots route to their original H sub-container without
      // re-reading the (possibly mutated) flat data on each render.
      (i) => isSectioned ? ((flattenResult?.flatData[i] as any)?.sectionIndex ?? 0) : 0,
      // Kind source — same rationale as sectionIndex. Pooled headers/footers
      // must keep their kind across pooling so they aren't misrouted as items
      // into an H sub-container's bucket.
      (i) => {
        if (!isSectioned) return 'item';
        const k = (flattenResult?.flatData[i] as any)?._kind;
        return k === 'header' || k === 'footer' ? k : 'item';
      },
      (i) => data[i],
      data.length,
      mountedStickySet,
      hExcludeIndices,
      renderGen,
    );
    const _lastCold = slotManagerRef.current.lastColdMounts;
    coldMountCountRef.current += _lastCold;
    if (__DEV__ && RNCV_HEALTH_DIAG) healthRef.current.coldM += _lastCold;

    // Build cells array from slots, using element cache for unchanged slots.
    // H-section cells are grouped by section index for RNOrthogonalSectionView wrapping.
    const cells: React.ReactElement[] = [];
    const hSectionCells = new Map<number, React.ReactElement[]>();
    let minIdx = data.length;
    let maxIdx = -1;
    let _cacheHits = 0, _cacheMisses = 0; // Opt 7 hit counter

    for (const [slotKey, slot] of activeSlots) {
      // Guard non-pooled slots against OOB indices (data shrink).
      // Pooled slots always render (Activity=hidden, uses preserved slot.item)
      // so the Fiber stays alive for the next pool reclaim.
      if (!slot.isPooled && !data[slot.dataIndex]) continue;

      // Track effFirst / effLast from active (non-pooled) slot indices.
      if (!slot.isPooled) {
        if (slot.dataIndex < minIdx) minIdx = slot.dataIndex;
        if (slot.dataIndex > maxIdx) maxIdx = slot.dataIndex;
      }

      // Detect H-section cells early — needed for both cache invalidation
      // and routing. sectionIndex and kind both come from SlotInfo (single
      // source of truth, captured at every slot assignment by SlotManager.sync
      // and preserved across pooling). This makes routing of POOLED slots
      // — H cells, headers, footers — survive arbitrary data mutations
      // without re-reading flatData[slot.dataIndex] (which may be stale or
      // out-of-bounds for pooled entries).
      const slotSectionIdx = slot.sectionIndex;
      const slotKind = slot.kind;
      const slotIsHCell = slotKind === 'item' && !!isHSectionFn?.(slotSectionIdx);

      // Opt 7: reuse element if slot state and render gen are unchanged.
      // item reference check mirrors React.memo semantics — if the consumer
      // produces a new object for a changed item, this misses and the cell
      // re-renders. See COLLECTIONVIEW_INTERNALS.md § "Consumer mutation contract".
      const prev = elementCacheRef.current.get(slotKey);
      let el: React.ReactElement;
      if (
        prev &&
        prev.gen         === renderGen &&
        prev.dataKey     === slot.dataKey &&
        prev.cacheKey    === slot.cacheKey &&
        prev.measureOnly === slot.measureOnly &&
        prev.item        === slot.item
      ) {
        el = prev.element;
        _cacheHits++;
      } else {
        // Slot changed — (re-)render and update cache.
        el = renderCell(slot.item as T, slot.dataIndex, slot.measureOnly, slotKey);
        elementCacheRef.current.set(slotKey, {
          gen: renderGen, dataKey: slot.dataKey, cacheKey: slot.cacheKey,
          measureOnly: slot.measureOnly,
          item: slot.item, element: el,
        });
        _cacheMisses++;
      }

      // Phase 2: route H-section item cells into their section bucket.
      // POOLED H cells go to the same bucket as visible H cells of that
      // section, so the H sub-container's ShadowNode owns their positioning
      // (H-local coordinates) and Activity hides their content. Routing
      // survives data mutations because slot.sectionIndex / slot.kind are
      // captured at every assignment by SlotManager and preserved across
      // pooling — see SlotInfo jsdoc for the underlying contract.
      // Headers/footers stay in the V array — they are V-positioned above/below
      // the UIScrollView, not inside it.
      if (slotIsHCell) {
        const bucket = hSectionCells.get(slotSectionIdx) ?? [];
        bucket.push(el);
        hSectionCells.set(slotSectionIdx, bucket);
      } else {
        cells.push(el);
      }
    }


    // Opt 7 diagnostic — enable RNCV_DEBUG_LOGS to see element cache effectiveness.
    if (__DEV__ && RNCV_DEBUG_LOGS) {
      const total = _cacheHits + _cacheMisses;
      const pct = total > 0 ? Math.round(100 * _cacheHits / total) : 0;
      console.log(`[RNCV-CACHE] hits=${_cacheHits} misses=${_cacheMisses} total=${total} hitRate=${pct}% renderGen=${renderGen} lcv=${layoutCacheVersion}`);
    }

    // Evict cache entries for slots that no longer exist.
    for (const k of elementCacheRef.current.keys()) {
      if (!activeSlots.has(k)) elementCacheRef.current.delete(k);
    }

    effFirst = minIdx <= maxIdx ? minIdx : smFirst;
    effLast  = minIdx <= maxIdx ? maxIdx : smLast;

    // ── Phase 2: Build sub-container wrappers for H-sections ──────────────────
    // H-2: each H section is hosted inside RNCollectionSubContainer, which
    // embeds its own UIScrollView and applies cell frames + transforms +
    // opacity natively from a CollectionSubContainerShadowNode (no JS work
    // in the per-frame apply path). The sub-container's onSubScroll event
    // is mapped through handleHSubScroll so existing windowing logic keeps
    // working unchanged (same handleHScroll under the hood).
    //
    // H-2.1: section content size (contentWidth / contentHeight) is NOT
    // passed as props. The C++ ShadowNode reads it directly from the layout
    // cache (`h-section-cw-{N}` for the scroll-axis extent and
    // `h-section-wrapper-{N}` for the cross-axis section height — both
    // written by CompositionalLayout::finalizeHSection). Round-tripping
    // section size through JS as a Fabric prop created a feedback loop:
    // cell measurements drift → cache update → finalizeHSection updates
    // section size → JS reads cache → JS re-renders this wrapper with new
    // contentHeight prop → Fabric commits the new prop → wrapper bounds
    // change → Yoga re-runs on the subtree → cells re-measure → drift
    // lands differently → loop. Symptoms: unnatural slow-decay bounce,
    // gestures wedged after edge bounce, JS render storm during decel.
    // Cutting the round-trip here lets the cache flow stay native end to
    // end; section size updates appear as state-driven UIScrollView
    // contentSize changes, never as React renders.
    const hSectionWrappers: React.ReactElement[] = [];
    if (hSectionCells.size > 0) {
      for (const [sIdx, sectionCells] of hSectionCells) {
        if (__DEV__ && RNCV_HSUB_LOGS) {
          const hRangeForLog = hRenderRangesRef.current.get(sIdx);
          // eslint-disable-next-line no-console
          console.log(
            `[RNCV-HSUB-JS-PROPS] s=${sIdx} ` +
            `cellCount=${sectionCells.length} ` +
            `range=${hRangeForLog ? `${hRangeForLog.first}..${hRangeForLog.last}` : 'NONE'} ` +
            `lcv=${layoutCacheVersion} ` +
            `(content size flows native via cache; not passed as prop)`
          );
        }
        hSectionWrappers.push(
          <RNCollectionSubContainer
            key={`h-section-${sIdx}`}
            layoutCacheId={layoutCacheId}
            sectionIndex={sIdx}
            scrollDirection="horizontal"
            onSubScroll={handleHSubScroll}
          >
            {sectionCells}
          </RNCollectionSubContainer>
        );
      }
    }

    // ── Decoration views ─────────────────────────────────────────────────────
    // Query the layout cache for decoration entries (section backgrounds,
    // separators) that fall within the current render window.
    // Off-screen decorations are NOT mounted — same windowing as cells.
    let decorationElements: React.ReactElement[] = [];
    const hasDecoRenderers = !!(decorationRenderers || renderSectionBackground);
    // Read separator config from any layout's delegate — not just list.
    const layoutDelegate = (effectiveLayout as any)?.delegate ?? null;
    const hasSeparators = !!(layoutDelegate?.separator);
    if ((hasDecoRenderers || hasSeparators) && viewportWidth > 0) {
      const isHorizDeco = effectiveLayout.horizontal ?? false;
      const scrollX = prevScrollXRef.current;
      const scrollY = prevScrollYRef.current;

      // Decoration cache: skip JSI query when lcv and scroll position match.
      // Decorations only change when positions shift (lcv bump) or scroll moves
      // enough that different decorations enter/leave the render window.
      const _decoCacheHit =
        lastDecoCacheRef.current.lcv === layoutCacheVersion &&
        Math.abs(lastDecoCacheRef.current.scrollY - scrollY) < 1.0 &&
        Math.abs(lastDecoCacheRef.current.scrollX - scrollX) < 1.0;
      if (_decoCacheHit) {
        decorationElements = lastDecoCacheRef.current.elements;
      } else {

      const vpH = viewportHeightRef.current || viewportHeight;
      const vpW = viewportWidth;
      const margin = (isHorizDeco ? vpW : vpH) * renderMultiplier;
      const decoRect = isHorizDeco ? {
        x: Math.max(0, scrollX - margin),
        y: 0,
        width: vpW + margin * 2,
        height: vpH,
      } : {
        x: 0,
        y: Math.max(0, scrollY - margin),
        width: vpW,
        height: vpH + margin * 2,
      };
      const decoAttrs = nativeLayoutCache.getAttributesInRect(decoRect)
        .filter((a: any) => a.isDecoration);

      const sepColor: string = layoutDelegate?.separator?.color ?? '#FFFFFF';

      // Merge old renderSectionBackground into decorationRenderers.sectionBackground.
      const bgRenderer =
        decorationRenderers?.sectionBackground ??
        (renderSectionBackground
          ? (si: number, _frame: any) => renderSectionBackground(si)
          : undefined);

      for (const attrs of decoAttrs) {
        const { key, decorationKind, section: si, frame } = attrs;
        let innerContent: React.ReactElement | null = null;

        if (decorationKind === 'separator') {
          innerContent = (
            <View
              style={{ width: frame.width, height: frame.height, backgroundColor: sepColor }}
              pointerEvents="none"
            />
          );
        } else if (decorationKind === 'sectionBackground' && bgRenderer) {
          const rendered = bgRenderer(si, frame);
          if (!rendered) continue;
          innerContent = (
            <View style={{ width: frame.width, height: frame.height }} pointerEvents="none">
              {rendered}
            </View>
          );
        } else if (decorationKind && decorationRenderers?.[decorationKind]) {
          const rendered = decorationRenderers[decorationKind]!(si, frame);
          if (!rendered) continue;
          innerContent = (
            <View style={{ width: frame.width, height: frame.height }} pointerEvents="none">
              {rendered}
            </View>
          );
        } else {
          continue; // no renderer for this kind
        }

        decorationElements.push(
          <RNMeasuredCell
            key={key}
            style={{ width: frame.width, height: frame.height, zIndex: attrs.zIndex }}
            type="decoration"
            index={-1}
            cacheKey={key}
            isMeasureOnly={false}
          >
            {innerContent}
          </RNMeasuredCell>,
        );
      }

      lastDecoCacheRef.current = { lcv: layoutCacheVersion, scrollY, scrollX, elements: decorationElements };
      } // end else (decoration cache miss)
    }

    decorationCountRef.current = decorationElements.length;
    return <>{decorationElements}{stickyHeaderCells}{stickyFooterCells}{hSectionWrappers}{cells}</>;
  })();

  // ── P5.1: HUD snapshot ───────────────────────────────────────────────────────
  // Updated every render so HUD interval always reads current values.
  // Blank area values come from the last onScroll computation (lastBlankAreaRef)
  // — same numbers the onBlankArea callback delivers to the consumer.
  hudSnapshotRef.current = () => {
    const mountedCells = rr ? Math.max(0, rr.last - rr.first + 1) : initialNumToRender;
    const { offsetStart, offsetEnd } = lastBlankAreaRef.current;
    return {
      mountedCells,
      coldMountCount:        coldMountCountRef.current,
      scrollCorrectionCount: scrollCorrectionCountRef.current,
      offsetStart,
      offsetEnd,
    };
  };

  // (stickyConfigMap moved above renderCell — it must be defined before the
  //  scrollContent IIFE that calls renderCell)

  // ── Render ───────────────────────────────────────────────────────────────────

  const hud = (RNCV_DEBUG_CALLBACKS && showHUD)
    ? <CollectionViewHUD snapshotRef={hudSnapshotRef} nativeMod={nativeMod} />
    : null;

  const renderRangeStart = effFirst;
  const renderRangeEnd   = effLast;
  const isHorizontalLayout = effectiveLayout.horizontal ?? false;
  const fallbackHorizontalHeight = Math.max(1, Math.ceil(effectiveItemHeight + sectionInsetTop + sectionInsetBottom));
  const horizontalAutoHeight = internalHorizontalHeight ?? fallbackHorizontalHeight;
  const rootStyle = isHorizontalLayout
    ? [{ height: horizontalAutoHeight }, style]
    : [{ flex: 1 }, style];

  return (
    <View style={rootStyle} onLayout={onContainerLayout}>
      <RNCollectionViewContainer
        style={{ flex: 1 }}
        layoutCacheId={layoutCacheId}
        layoutCacheVersion={layoutCacheVersion}
        layoutType={effectiveLayout.type as any}
        estimatedItemHeight={effectiveItemHeight}
        renderRangeStart={renderRangeStart}
        renderRangeEnd={renderRangeEnd}
        rowSpacing={itemSpacing}
        sectionInsetTop={sectionInsetTop}
        sectionInsetBottom={sectionInsetBottom}
        sectionInsetLeft={sectionInsetLeft}
        sectionInsetRight={sectionInsetRight}
        scrollEnabled={scrollViewProps?.scrollEnabled ?? true}
        bounces={scrollViewProps?.bounces ?? true}
        horizontal={effectiveLayout.horizontal ?? false}
        showsVerticalScrollIndicator={scrollViewProps?.showsVerticalScrollIndicator ?? true}
        scrollEventThrottle={16}
        onScroll={contractProps.onScroll}
        onScrollBeginDrag={scrollViewProps?.onScrollBeginDrag as any}
        onScrollEndDrag={scrollViewProps?.onScrollEndDrag as any}
        onMomentumScrollBegin={scrollViewProps?.onMomentumScrollBegin as any}
        onMomentumScrollEnd={scrollViewProps?.onMomentumScrollEnd as any}
      >
        {scrollContent}
      </RNCollectionViewContainer>
      {hud}
    </View>
  );
}

// React.forwardRef doesn't preserve generics in TypeScript, so we cast the
// result back to the generic function signature. This gives consumers the
// correct <T> inference on both React 18 (RN 0.80.x) and React 19 (RN 0.83+).
export const Riff = React.forwardRef(RiffBase) as <T = unknown>(
  props: RiffProps<T> & React.RefAttributes<RiffHandle<T>>,
) => React.ReactElement | null;
