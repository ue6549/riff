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
 * ScrollViewComponent / renderScrollView are legacy — warn if provided.
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
  ScrollView,
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

import NativeCollectionViewModule from './NativeCollectionViewModule';
import RNMeasuredCell from './RNMeasuredCellNativeComponent';
import RNScrollCoordinatedView from './RNScrollCoordinatedViewNativeComponent';
import RNCollectionViewContainer from './RNCollectionViewContainerNativeComponent';
import { RiffSnapshot } from './CollectionSnapshot';
import type { CollectionViewLayout, LayoutContext } from '@riff/types/protocol';
import { list as listLayout } from '@riff/layouts/list';

// ─── JSI module types ─────────────────────────────────────────────────────────

type NativeRange = { first: number; last: number };
type NativeWindowState = { render: NativeRange; visible: NativeRange };

const nativeMod = NativeCollectionViewModule as unknown as {
  layoutCacheId: number;
  layoutCache: {
    clear(): void;
    setAttributes(attrs: object): void;
    getAttributes(key: string): any;
    removeAttributes(key: string): void;
    getItemHeights(section: number, count: number): number[];
    getTotalContentSize(): { width: number; height: number };
    version(): number;
    /** MVC: snapshot anchor before prepare() rewrites positions. Reads scroll offset from LayoutCache. */
    snapshotAnchor(): void;
    /** MVC: compare anchor's new Y after prepare(). Stores pending correction. */
    computeCorrection(): number;
    /** MVC: consume and clear pending correction (called by native view). */
    consumePendingCorrection(): number;
  };
  metrics: {
    startFrameTimer(): void;
    stopFrameTimer(): void;
    getFrameMetrics(): { fps: number; frameTimeMs: number };
    resetMetrics(): void;
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
  };
};
const nativeWindowController = nativeMod.windowController;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RenderItemInfo<T> {
  item: T;
  index: number;
}

// ── Section model ──────────────────────────────────────────────────────────────

export interface SectionConfig<T> {
  key: string;
  data: T[];
  header?: {
    render: () => React.ReactElement | null;
    height: number;
    sticky?: boolean;
  };
  footer?: {
    render: () => React.ReactElement | null;
    height: number;
    sticky?: boolean;
  };
  insets?: { top?: number; bottom?: number; left?: number; right?: number };
}

export interface SectionedRenderItemInfo<T> {
  item: T;
  sectionIndex: number;
  itemIndex: number;
}

/**
 * F1.2 — Imperative handle exposed via the `handle` prop.
 * Generic forwardRef doesn't compose well with TypeScript generics, so we use
 * a handle prop instead — identical ergonomics without the casting ceremony.
 *
 * Usage:
 *   const ref = useRef<RiffHandle<MyItem>>(null);
 *   <Riff handle={ref} ... />
 *   const snap = ref.current.snapshot();
 *   snap.appendItems(newItems);
 *   ref.current.apply(snap);   // diff + LayoutAnimation + startTransition
 */
export interface RiffHandle<T = unknown> {
  /**
   * Create a snapshot seeded with the current data array and key extractor.
   * Record mutations on it, then pass to apply().
   */
  snapshot(): RiffSnapshot<T>;

  /**
   * Apply a snapshot: compute new data, evict stale heights for
   * removed/reloaded items, trigger LayoutAnimation for position changes,
   * and commit the update inside startTransition.
   * The new data is delivered via the onDataChange prop.
   */
  apply(snap: RiffSnapshot<T>, animated?: boolean): void;

  /**
   * Evict cached heights for the given keys so they are re-measured on the
   * next render. Call this when item content changes behind the same key.
   */
  invalidateKeys(keys: Iterable<string>): void;
}

export interface RiffProps<T = unknown> {
  /** Flat mode data. Mutually exclusive with `sections`. */
  data?: T[];
  /** Sectioned mode. Mutually exclusive with `data`. */
  sections?: SectionConfig<T>[];

  /**
   * Layout engine conforming to the CollectionViewLayout protocol.
   * When provided, the layout handles position computation, content sizing,
   * and invalidation. Built-in props (itemHeight, estimatedItemHeight) are
   * ignored — the layout's delegate owns sizing.
   *
   * Usage:
   *   import { list, masonry, grid, flow, customLayout } from 'riff/layouts';
   *   <CollectionView layout={masonry({ columns: 3, heightForItem: fn })} ... />
   */
  layout?: CollectionViewLayout;

  /**
   * Flat mode: (info: { item: T; index: number }) => element
   * Sectioned mode: (info: { item: T; sectionIndex: number; itemIndex: number }) => element
   */
  renderItem: (info: any) => React.ReactElement | null;
  keyExtractor?: (item: T, ...args: any[]) => string;
  /** Like FlatList's extraData — pass any value here to force re-renders when it changes. */
  extraData?: unknown;

  /** Fixed item height. Use this when all cells have the same known height. */
  itemHeight?: number;
  /**
   * M4.1 — Estimated height for variable-height mode.
   * Cells will measure themselves via onLayout and report actual heights.
   * The layout is updated incrementally and scroll position is corrected so
   * the viewport content does not jump when an item above it changes size.
   * Exactly one of itemHeight / estimatedItemHeight must be provided.
   */
  estimatedItemHeight?: number;
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
   * Called whenever the number of rendered items changes.
   * Useful for debug overlays: (renderCount, totalCount) => void.
   */
  onRenderCountChange?: (renderCount: number, totalCount: number) => void;

  /**
   * Fires when the container's measured size changes.
   * Useful for coordinating external UI (animations, other components) with container resize.
   * The layout itself re-computes automatically — this callback is for consumer side effects only.
   */
  onContainerSizeChange?: (width: number, height: number) => void;

  /**
   * P5.3 / FlashList-compatible blank area callback.
   * Fires on every scroll event with the number of blank (unrendered) pixels
   * at the top and bottom of the visible viewport.
   *   offsetStart: blank px at the leading edge (top when scrolling down)
   *   offsetEnd:   blank px at the trailing edge (bottom when scrolling down)
   * Both are 0 when the render window fully covers the viewport.
   */
  onBlankArea?: (event: { offsetStart: number; offsetEnd: number }) => void;

  /**
   * F1.2 — Imperative handle ref. Exposes snapshot(), apply(), invalidateKeys().
   * Pass a ref created with useRef<RiffHandle<T>>(null).
   */
  handle?: React.RefObject<RiffHandle<T>>;

  /**
   * F1.2 — Called by handle.apply(snap) with the new data array.
   * The consumer should update their data state with this value.
   * Already wrapped in startTransition internally — no extra wrapping needed.
   */
  onDataChange?: (data: T[]) => void;

  /**
   * Called whenever item Y-positions are recomputed in variable-height mode.
   * `positions[i]` = top-Y of item i in scroll-content space.
   * Used internally to position sticky headers and decoration
   * views at the true measured positions rather than analytical estimates.
   * Only fires in variable-height mode (estimatedItemHeight prop).
   */
  onItemPositionsChange?: (positions: number[]) => void;

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

  /** Per-section background decoration, rendered inside scroll content. */
  renderSectionBackground?: (sectionIndex: number) => React.ReactElement | null;

  scrollViewProps?: ScrollViewProps;
  ScrollViewComponent?: React.ComponentType<ScrollViewProps>;
  renderScrollView?: (
    props: ScrollViewProps & { children: React.ReactNode },
  ) => React.ReactElement;

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
  const budget = Math.ceil((mountedWindowSize * vpHeight) / stride);
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
  keyToFlatIndex:            Map<string, number>;
}

const RNCV_DEBUG_LOGS = false;

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

function flattenSections<T>(sections: SectionConfig<T>[]): FlattenResult<T> {
  const flatData:                FlatItem<T>[] = [];
  const stickyHeaderFlatIndices: number[]      = [];
  const stickyFooterFlatIndices: number[]      = [];
  const sectionStartFlatIndices: number[]      = [];
  const declaredHeights                        = new Map<string, number>();
  const keyToFlatIndex                         = new Map<string, number>();

  for (let si = 0; si < sections.length; si++) {
    const s = sections[si]!;
    sectionStartFlatIndices.push(flatData.length);

    if (s.header) {
      const fi = flatData.length;
      if (s.header.sticky) stickyHeaderFlatIndices.push(fi);
      declaredHeights.set(`__h_${s.key}`, s.header.height);
      keyToFlatIndex.set(`item-${si}-header`, fi);
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
      keyToFlatIndex.set(`item-${si}-${ii}`, fi);
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
      keyToFlatIndex.set(`item-${si}-footer`, fi);
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
    keyToFlatIndexSize: keyToFlatIndex.size,
    keyToFlatIndexSample: Array.from(keyToFlatIndex.entries()).slice(0, 16),
  });

  return { flatData, stickyHeaderFlatIndices, stickyFooterFlatIndices, sectionStartFlatIndices, declaredHeights, keyToFlatIndex };
}

/** Flat-mode key extractor for sectioned items. */
function sectionedKeyExtractor<T>(
  sections: SectionConfig<T>[],
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
// renderItem is typed `any` here because this is a module-level component
// that must be generic-agnostic. CollectionView passes a stable wrapper
// (renderItemRef pattern) so memo's prop comparison always sees the same
// function reference, preventing reference-equality false positives.
const MemoizedCellContent = React.memo(function MemoizedCellContent({
  item,
  index,
  renderItem,
  extraData: _extraData,
}: {
  item: any;
  index: number;
  renderItem: (info: any) => React.ReactElement | null;
  extraData?: unknown;
}) {
  return renderItem({ item, index });
});

// ─── Component ────────────────────────────────────────────────────────────────

export function Riff<T = unknown>({
  data: propData,
  sections: propSections,
  layout: layoutProp,
  renderItem: propRenderItem,
  keyExtractor: propKeyExtractor,
  itemHeight,
  estimatedItemHeight,
  itemSpacing = 0,
  sectionInsetTop = 0,
  sectionInsetBottom = 0,
  sectionInsetLeft = 0,
  sectionInsetRight = 0,
  renderMultiplier = 1.0,
  mountedWindowSize = 5.0,
  measureAhead = 2.0,
  initialNumToRender = 10,
  onRenderCountChange,
  onBlankArea,
  handle,
  onDataChange,
  onItemPositionsChange,
  onPrefetch,
  onEvict,
  prefetchAhead = 12,
  stickyHeaderIndices: propStickyHeaderIndices,
  stickyFooterIndices: propStickyFooterIndices,
  stickyMode = 'push',
  extraData,
  renderSectionBackground,
  ScrollViewComponent,
  scrollViewProps,
  renderScrollView: propRenderScrollView,
  style,
  showHUD = false,
  onContainerSizeChange,
  initialWidth,
  initialHeight,
  maintainVisibleContentPosition = false,
}: RiffProps<T>) {

  // ── Section flattening ──────────────────────────────────────────────────────
  // If `sections` is provided, flatten to a flat item array. The rest of the
  // component operates on flat data — it doesn't know about sections.

  const isSectioned = !!propSections;

  const flattenResult = useMemo(() => {
    if (!propSections) return null;
    const result = flattenSections(propSections);
    // Add stable key → flat index mappings alongside positional ones.
    // Cache keys for list items are now stable when keyExtractor is present,
    // so keyToFlatIndex.get(attr.key) must resolve to the correct flat index.
    if (propKeyExtractor) {
      for (let si = 0; si < propSections.length; si++) {
        const s = propSections[si]!;
        for (let ii = 0; ii < s.data.length; ii++) {
          const stableKey = `${s.key}:${propKeyExtractor(s.data[ii]!, ii)}`;
          const positionalKey = `item-${si}-${ii}`;
          const fi = result.keyToFlatIndex.get(positionalKey);
          if (fi !== undefined) {
            result.keyToFlatIndex.set(stableKey, fi);
          }
        }
      }
    }
    return result;
  }, [propSections, propKeyExtractor]);

  useEffect(() => {
    if (!isSectioned || !flattenResult) return;
    rncvLog('RNCV-JS-FLAT', {
      op: 'useMemo-result',
      flatCount: flattenResult.flatData.length,
      stickyHeaders: flattenResult.stickyHeaderFlatIndices,
      stickyFooters: flattenResult.stickyFooterFlatIndices,
      sectionStartFlatIndices: flattenResult.sectionStartFlatIndices,
      keyToFlatIndexSize: flattenResult.keyToFlatIndex.size,
    });
  }, [isSectioned, flattenResult]);

  // In sectioned mode, wrap the consumer's renderItem to dispatch
  // headers/footers to their section render functions.
  const sectionedRenderItem = useCallback((info: RenderItemInfo<any>) => {
    if (!propSections) return propRenderItem(info);
    const fi = info.item as FlatItem<T>;
    if (fi._kind === 'header') return propSections[fi.sectionIndex]?.header?.render() ?? null;
    if (fi._kind === 'footer') return propSections[fi.sectionIndex]?.footer?.render() ?? null;
    return propRenderItem({ item: fi.item, sectionIndex: fi.sectionIndex, itemIndex: fi.itemIndex });
  }, [propSections, propRenderItem]);

  const sectionedKeyExtractorCb = useCallback((item: any, index: number) => {
    if (!propSections) return propKeyExtractor ? propKeyExtractor(item, index) : String(index);
    const fi = item as FlatItem<T>;
    const k = sectionedKeyExtractor(propSections, propKeyExtractor, fi, index);
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
  const [viewportWidth,  setViewportWidth]  = useState(seedW);
  const [viewportHeight, setViewportHeight] = useState(seedH);
  const [contentHeight,  setContentHeight]  = useState(0);

  // null = not yet initialized. onContainerLayout computes an eager initial
  // range from stride estimates so the first screenful mounts immediately.
  const [renderRange, setRenderRange] = useState<Range | null>(null);

  // Previous range for O(1) change detection — compared by value, not string.
  const prevRenderRef = useRef<Range | null>(null);

  // Velocity tracking for M3.4 adaptive window (px/ms, positive = down).
  const prevScrollYRef   = useRef(0);
  const prevScrollTimeRef = useRef(0);
  const velocityRef      = useRef(0);

  // P5.1 — counters for the debug HUD. Plain refs — no state, no re-renders.
  const coldMountCountRef        = useRef(0);
  const scrollCorrectionCountRef = useRef(0);
  // P5.3 / onBlankArea — last computed blank area, updated on every scroll event.
  const lastBlankAreaRef = useRef({ offsetStart: 0, offsetEnd: 0 });
  // F1.3 — last prefetch range for diff-based onPrefetch/onEvict firing.
  const prevPrefetchRangeRef = useRef<Range | null>(null);
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

  // ── Phase 5: ShadowNode ↔ LayoutCache bridge ──────────────────────────────
  // layoutCacheId: opaque ID registered in CollectionViewModule's static registry.
  // ShadowNode looks up the shared LayoutCache during layout() via this ID.
  // layoutCacheVersion: bumped to trigger Fabric re-commit when cache content
  // changes (e.g. after heightForItem seeding or batch measurement updates).
  const layoutCacheId = nativeMod.layoutCacheId;
  const [layoutCacheVersion, setLayoutCacheVersion] = useState(0);

  // Stable renderItem wrapper for MemoizedCellContent.
  // Keeps the latest consumer function in a ref so memo's prop comparison
  // always sees the same function reference — even if the consumer passes a
  // new arrow function on every render without useCallback.
  const renderItemRef    = useRef(renderItem);
  renderItemRef.current  = renderItem;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableRenderItem = useCallback((info: RenderItemInfo<T>) => renderItemRef.current(info), []);

  const itemCount = data.length;

  // Variable-height mode (M4.1) — active when estimatedItemHeight is set.
  // Still used to choose fixed vs variable window controller path.
  const isVariableHeight  = estimatedItemHeight !== undefined;
  const effectiveItemHeight = estimatedItemHeight ?? itemHeight ?? 44;
  const stride    = effectiveItemHeight + itemSpacing;
  const itemWidth = Math.max(0, viewportWidth - sectionInsetLeft - sectionInsetRight);

  // Track C++ LayoutCache version to detect when ShadowNode writes heights.
  const lastCacheVersionRef = useRef(0);
  const nativeLayoutCache = nativeMod.layoutCache;

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
      itemHeight: isVariableHeight ? undefined : effectiveItemHeight,
      estimatedItemHeight: isVariableHeight ? effectiveItemHeight : undefined,
      itemSpacing,
    });
  }, [layoutProp, isVariableHeight, effectiveItemHeight, itemSpacing]);

  const effectiveLayout = layoutProp ?? defaultLayout!;

  // Stable callback that resolves measured height for an item by index.
  // Reads from LayoutCache (ShadowNode writes Yoga-measured heights there).
  const measuredHeightForItemRef = useRef((index: number, section: number): number | undefined => {
    const attr = nativeLayoutCache.getAttributes(`item-${section}-${index}`);
    return attr ? attr.frame.height : undefined;
  });
  measuredHeightForItemRef.current = (index: number, section: number): number | undefined => {
    // Use the same identity key that list.ts writes to the cache when keyExtractor is set.
    // Positional keys (item-S-I) always miss for identity-keyed lists, causing every
    // prepare() call to fall back to estimates and producing false measurement deltas.
    const sec = propSections?.[section];
    const item = sec?.data[index];
    const key = (sec && propKeyExtractor && item !== undefined)
      ? `${sec.key}:${propKeyExtractor(item, index)}`
      : `item-${section}-${index}`;
    const attr = nativeLayoutCache.getAttributes(key);
    return attr ? attr.frame.height : undefined;
  };

  const layoutContext: LayoutContext | null = useMemo(() => {
    if (viewportWidth === 0) return null;
    return {
      containerWidth: viewportWidth,
      containerHeight: viewportHeight,
      scrollOffset: { x: 0, y: prevScrollYRef.current },
      sections: propSections
        ? propSections.map(s => ({
            itemCount: s.data.length,
            insets: s.insets,
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
      sectionInsetTop, sectionInsetBottom, sectionInsetLeft, sectionInsetRight]);

  // Prepare the layout when context changes (data, container size).
  // Cache clearing is handled internally by each layout engine (e.g. list.ts)
  // using its own data-shape fingerprint — NOT here in the generic component.
  useMemo(() => {
    if (!layoutContext) return;
    // MVC: snapshot anchor BEFORE prepare() overwrites all positions in the cache.
    // Only when maintainVisibleContentPosition is enabled. The anchor is the item
    // with the smallest Y >= current scrollY — the first fully-visible item.
    if (maintainVisibleContentPosition) {
      nativeLayoutCache.snapshotAnchor();
    }
    effectiveLayout.prepare(layoutContext);
    // NOTE: computeCorrection() is NOT called here. It runs in native updateState:
    // AFTER Yoga has measured new items via applyMeasurements. Calling it here
    // (pre-Yoga) would produce corrections based on estimate heights, not actual.
    // Sync version ref so scroll handler doesn't re-trigger.
    lastCacheVersionRef.current = nativeLayoutCache.version();
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
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const nv = nativeLayoutCache.version();
      if (nv !== lastCacheVersionRef.current) {
        lastCacheVersionRef.current = nv;
        setLayoutCacheVersion(v => v + 1);
      }
    });
    return () => cancelAnimationFrame(raf);
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

  // ── Layout pass + initial window state ───────────────────────────────────────
  // useLayoutEffect so the accurate range (with real layout data) is committed
  // before the frame is painted — avoids a visible flash of stale positions.

  useLayoutEffect(() => {
    if (viewportWidth === 0 || viewportHeight === 0) return;
    if (!layoutContentSize) return;
    nativeMod.signpost.begin(1);
    try {

    setContentHeight(layoutContentHeight);

    if (itemCount === 0) {
      setRenderRange({ first: 0, last: -1 });
      return;
    }

    // Query the layout for items in the render window (spatial query).
    const scrollY = prevScrollYRef.current;
    const speed = Math.abs(velocityRef.current);
    const leadBoost = Math.min(4, speed) * renderMultiplier;
    const leadMult = renderMultiplier + leadBoost;
    const trailMult = Math.max(0.25, renderMultiplier - leadBoost * 0.5);
    const goingDown = velocityRef.current >= 0;
    const abovePad = (goingDown ? trailMult : leadMult) * viewportHeight;
    const belowPad = (goingDown ? leadMult : trailMult) * viewportHeight;

    const attrs = effectiveLayout.attributesForElements({
      x: 0,
      y: scrollY - abovePad,
      width: viewportWidth,
      height: viewportHeight + abovePad + belowPad,
    });

    if (attrs.length === 0) {
      setRenderRange({ first: 0, last: -1 });
    } else {
      let minIdx = Infinity, maxIdx = -Infinity;
      let missedKeys = [];
      for (const attr of attrs) {
        const fi = isSectioned ? (flattenResult?.keyToFlatIndex?.get(attr.key) ?? -1) : attr.index;
        if (fi === -1) {
          missedKeys.push(attr.key);
          continue;
        }
        if (fi < minIdx) minIdx = fi;
        if (fi > maxIdx) maxIdx = fi;
      }
      
      if (missedKeys.length > 0) rncvVerboseLog(`[RNCVX] scrollY=${scrollY} MISSING KEYS (first 3):`, missedKeys.slice(0, 3));
      rncvVerboseLog(`[RNCVX] scrollY=${scrollY} sectioned=${isSectioned} C++_attr_count=${attrs.length} -> max_fi=${maxIdx} min_fi=${minIdx}`);
      const render = { first: minIdx === Infinity ? 0 : minIdx, last: maxIdx === -Infinity ? -1 : maxIdx };

      const visAttrs = effectiveLayout.attributesForElements({
        x: 0, y: scrollY, width: viewportWidth, height: viewportHeight,
      });
      let visFirst = Infinity, visLast = -Infinity;
      for (const a of visAttrs) {
        const fi = isSectioned ? (flattenResult?.keyToFlatIndex?.get(a.key) ?? -1) : a.index;
        if (fi === -1) continue;
        if (fi < visFirst) visFirst = fi;
        if (fi > visLast) visLast = fi;
      }
      const visible = { first: visFirst === Infinity ? 0 : visFirst, last: visLast === -Infinity ? -1 : visLast };

      const budgeted = nativeWindowController.applyBudget(render.first, render.last, visible.first, visible.last, effectiveMountedWindowSize, viewportHeight, budgetStride);
      prevRenderRef.current = budgeted;
      setRenderRange(budgeted);

      // Measure range: extend render range for pre-measurement of variable-height cells.
      if (isVariableHeight && measureAhead > 0) {
        const ahead = Math.ceil(measureAhead * viewportHeight / stride);
        const newMR = nativeWindowController.computeMeasureRange(budgeted.first, budgeted.last, ahead, itemCount);
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
  ]);

  // P5.1 — start CADisplayLink when HUD is active, stop on unmount or HUD off.
  useEffect(() => {
    if (!showHUD) return;
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
        setLayoutCacheVersion(v => v + 1);
      }
    }, 100);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── F1.2: Imperative handle ───────────────────────────────────────────────────

  useImperativeHandle(handle, () => ({
    snapshot: () => new RiffSnapshot(data, keyExtractor),

    apply: (snap: RiffSnapshot<T>, animated = true) => {
      const { data: newData, reloadedKeys } = snap.apply();

      // Diff for LayoutAnimation — LayoutCache heights are managed by ShadowNode.
      const oldKeys = data.map((item, i) =>
        keyExtractor ? keyExtractor(item, i) : String(i));
      const newKeys = newData.map((item, i) =>
        keyExtractor ? keyExtractor(item, i) : String(i));
      const diff = nativeMod.diffEngine.diff(oldKeys, newKeys);

      // Evict removed/reloaded items from LayoutCache so they re-measure.
      for (const k of diff.removed) nativeLayoutCache.removeAttributes(k);
      for (const k of reloadedKeys) nativeLayoutCache.removeAttributes(k);

      // LayoutAnimation for position changes (moves, shifts after insert/delete).
      // 350ms spring gives a clearly visible animation on absolute-positioned cells.
      if (animated && (diff.moved.length > 0 || diff.removed.length > 0 || diff.inserted.length > 0)) {
        LayoutAnimation.configureNext({
          duration: 350,
          create:  { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
          update:  { type: LayoutAnimation.Types.spring, springDamping: 0.8 },
          delete:  { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
        });
      }

      // Commit inside startTransition so scroll is not interrupted
      React.startTransition(() => {
        onDataChange?.(newData);
      });
    },

    invalidateKeys: (keys: Iterable<string>) => {
      for (const k of keys) nativeLayoutCache.removeAttributes(k);
      setLayoutCacheVersion(v => v + 1);
    },
  }), [data, keyExtractor, onDataChange]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Debug callback ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (onRenderCountChange) {
      const count = renderRange === null
        ? itemCount
        : Math.max(0, renderRange.last - renderRange.first + 1);
      onRenderCountChange(count, itemCount);
    }
  }, [renderRange, itemCount, onRenderCountChange]);

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
      const wc = nativeWindowController;
      const ws = wc.computeRanges(0, h, itemCount, stride, renderMultiplier, sectionInsetTop, 0);
      const budgeted = wc.applyBudget(ws.render.first, ws.render.last, ws.visible.first, ws.visible.last, effectiveMountedWindowSize, h, budgetStride);
      prevRenderRef.current = budgeted;
      setRenderRange(budgeted);

      // Seed content height from estimates so scroll view has a size.
      const estContent = sectionInsetTop + itemCount * stride - itemSpacing + sectionInsetBottom;
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
      const vpH     = layoutMeasurement.height || viewportHeight;

      // Update velocity estimate (px/ms). Ignore readings with stale timestamps
      // (> 100ms gap means the user paused, velocity should reset toward 0).
      const now = Date.now();
      const dt  = now - prevScrollTimeRef.current;
      if (dt > 0 && dt <= 100) {
        velocityRef.current = (scrollY - prevScrollYRef.current) / dt;
      } else if (dt > 100) {
        velocityRef.current = 0;
      }
      prevScrollYRef.current  = scrollY;
      prevScrollTimeRef.current = now;

      // Check if ShadowNode wrote new measurements to LayoutCache.
      // If so, bump layoutCacheVersion to trigger position recomputation.
      const cacheVer = nativeLayoutCache.version();
      if (cacheVer !== lastCacheVersionRef.current) {
        lastCacheVersionRef.current = cacheVer;
        setLayoutCacheVersion(v => v + 1);
      }

      // Spatial query for render range — works for all layout types.
      const speed = Math.abs(velocityRef.current);
      const leadBoost = Math.min(4, speed) * renderMultiplier;
      const leadMult = renderMultiplier + leadBoost;
      const trailMult = Math.max(0.25, renderMultiplier - leadBoost * 0.5);
      const goingDown = velocityRef.current >= 0;
      const abovePad = (goingDown ? trailMult : leadMult) * vpH;
      const belowPad = (goingDown ? leadMult : trailMult) * vpH;

      const attrs = effectiveLayout.attributesForElements({
        x: 0, y: scrollY - abovePad, width: viewportWidth, height: vpH + abovePad + belowPad,
      });

      let rFirst = Infinity, rLast = -Infinity;
      for (const a of attrs) {
        const fi = isSectioned ? (flattenResult?.keyToFlatIndex?.get(a.key) ?? -1) : a.index;
        if (fi === -1) continue;
        if (fi < rFirst) rFirst = fi;
        if (fi > rLast) rLast = fi;
      }
      const newR = { first: rFirst === Infinity ? 0 : rFirst, last: rLast === -Infinity ? -1 : rLast };

      const visAttrs = effectiveLayout.attributesForElements({
        x: 0, y: scrollY, width: viewportWidth, height: vpH,
      });
      let vFirst = Infinity, vLast = -Infinity;
      for (const a of visAttrs) {
        const fi = isSectioned ? (flattenResult?.keyToFlatIndex?.get(a.key) ?? -1) : a.index;
        if (fi === -1) continue;
        if (fi < vFirst) vFirst = fi;
        if (fi > vLast) vLast = fi;
      }
      const newV = { first: vFirst === Infinity ? 0 : vFirst, last: vLast === -Infinity ? -1 : vLast };

      const budgetedR = applyBudget(newR, newV, effectiveMountedWindowSize, vpH, budgetStride);
      const renderChanged = rangeChanged(prevRenderRef.current, budgetedR);
      if (renderChanged) {
        prevRenderRef.current = budgetedR;
        setRenderRange(budgetedR);
      }

      // Update measure range (same frame as render range).
      if (isVariableHeight && measureAhead > 0) {
        const ahead = Math.ceil(measureAhead * vpH / stride);
        const newMR = nativeWindowController.computeMeasureRange(budgetedR.first, budgetedR.last, ahead, itemCount);
        if (newMR.first !== prevMeasureRef.current.first || newMR.last !== prevMeasureRef.current.last) {
          prevMeasureRef.current = newMR;
          setMeasureRange(newMR);
        }
      }

      // P5.3 / onBlankArea — compute blank px at top and bottom of viewport.
      if (budgetedR.last >= budgetedR.first) {
        const firstAttr = effectiveLayout.attributesForItem(budgetedR.first, 0);
        const lastAttr  = effectiveLayout.attributesForItem(budgetedR.last, 0);
        const firstTop  = firstAttr ? firstAttr.frame.y : sectionInsetTop + budgetedR.first * stride;
        const lastTop   = lastAttr ? lastAttr.frame.y : sectionInsetTop + budgetedR.last * stride;
        const lastH     = lastAttr ? lastAttr.frame.height : effectiveItemHeight;
        const offsetStart = Math.max(0, firstTop - scrollY);
        const offsetEnd   = Math.max(0, scrollY + vpH - (lastTop + lastH));
        lastBlankAreaRef.current = { offsetStart, offsetEnd };
        onBlankArea?.({ offsetStart, offsetEnd });
      }

      // F1.3 — Prefetch/evict callbacks.
      if ((onPrefetch || onEvict) && itemCount > 0 && prefetchAhead > 0) {
        const aheadItems = Math.ceil(prefetchAhead * vpH / stride);
        const newPR: Range = {
          first: Math.max(0, budgetedR.first - aheadItems),
          last:  Math.min(itemCount - 1, budgetedR.last + aheadItems),
        };
        const prevPR = prevPrefetchRangeRef.current;
        if (prevPR === null || newPR.first !== prevPR.first || newPR.last !== prevPR.last) {
          if (onPrefetch) {
            const entering: string[] = [];
            for (let i = newPR.first; i <= newPR.last; i++) {
              if (prevPR === null || i < prevPR.first || i > prevPR.last) {
                const d = data[i];
                if (d !== undefined) entering.push(keyExtractor ? keyExtractor(d, i) : String(i));
              }
            }
            if (entering.length > 0) onPrefetch(entering);
          }
          if (onEvict && prevPR !== null) {
            const leaving: string[] = [];
            for (let i = prevPR.first; i <= prevPR.last; i++) {
              if (i < newPR.first || i > newPR.last) {
                const d = data[i];
                if (d !== undefined) leaving.push(keyExtractor ? keyExtractor(d, i) : String(i));
              }
            }
            if (leaving.length > 0) onEvict(leaving);
          }
          prevPrefetchRangeRef.current = newPR;
        }
      }

      nativeMod.signpost.end(0);
      scrollViewProps?.onScroll?.(e);
    },
  };

  // ── Sticky supplementary config for ScrollCoordinatedView ───────────────────
  // Build a map: flatIndex → { kind, naturalY, boundaryY, sizeHeight }
  // Each sticky cell is wrapped in RNScrollCoordinatedView in renderCell.
  // The native component handles the transform on the UI thread.
  // MUST be defined before renderCell / scrollContent IIFE that consumes it.

  const stickyConfigMap = useMemo(() => {
    if (!hasStickyHeaders && !hasStickyFooters) return null;
    const map = new Map<number, { kind: 'header' | 'footer'; naturalY: number; boundaryY: number; sizeHeight: number }>();

    const allSticky = [
      ...stickyHeaderFlatIndices.map(fi => ({ fi, kind: 'header' as const })),
      ...stickyFooterFlatIndices.map(fi => ({ fi, kind: 'footer' as const })),
    ].sort((a, b) => a.fi - b.fi);

    for (let i = 0; i < allSticky.length; i++) {
      const { fi, kind: stickyKind } = allSticky[i]!;
      const fiDesc = isSectioned ? flattenResult?.flatData[fi] : null;
      
      let attr = null;
      if (isSectioned && fiDesc?._kind === 'header') {
        attr = nativeMod.layoutCache.getAttributes(`item-${fiDesc.sectionIndex}-header`);
      } else if (isSectioned && fiDesc?._kind === 'footer') {
        attr = nativeMod.layoutCache.getAttributes(`item-${fiDesc.sectionIndex}-footer`);
      } else {
        attr = effectiveLayout.attributesForItem(isSectioned ? ((fiDesc as any)?.itemIndex ?? fi) : fi, isSectioned ? (fiDesc?.sectionIndex ?? 0) : 0);
      }
      
      const naturalY = attr ? attr.frame.y : sectionInsetTop + fi * stride;
      const sizeHeight = attr ? attr.frame.height : effectiveItemHeight;

      // Push boundary differs by kind:
      // - Header: next section start — the next header pushes this one away from viewport top.
      // - Footer: current section start — footer shouldn't be pulled above its own section.
      let boundaryY = 999999;
      if (isSectioned && typeof fiDesc?.sectionIndex === 'number') {
        if (stickyKind === 'footer') {
          // Footer boundary = section's own header Y (or first item Y if no header).
          const sectionHeader = nativeMod.layoutCache.getAttributes(`item-${fiDesc.sectionIndex}-header`);
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
            const nextHeader = nativeMod.layoutCache.getAttributes(`item-${nextSection}-header`);
            if (nextHeader) {
              boundaryY = nextHeader.frame.y;
            } else {
              const nextFirst = effectiveLayout.attributesForItem(0, nextSection);
              if (nextFirst) boundaryY = nextFirst.frame.y;
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
        headerHeight: sizeHeight,
      });
      map.set(fi, { kind: stickyKind, naturalY, boundaryY, sizeHeight });
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
  const renderCell = (item: T, index: number, measureOnly = false) => {
    const key  = keyExtractor ? keyExtractor(item, index) : String(index);

    const fiDesc = isSectioned ? flattenResult?.flatData[index] : null;
    const sk = fiDesc ? fiDesc.sectionIndex : 0;
    const ik = fiDesc && fiDesc._kind === 'item' ? fiDesc.itemIndex : index;
    
    let cacheKey: string;
    if (fiDesc?._kind === 'header') {
      cacheKey = `item-${sk}-header`;
    } else if (fiDesc?._kind === 'footer') {
      cacheKey = `item-${sk}-footer`;
    } else if (effectiveLayout.type !== 'list') {
      cacheKey = `${effectiveLayout.type}-${index}`;
    } else {
      // Use stable key from layoutContext when keyExtractor is available.
      const sectionKeys = layoutContext?.sections[sk]?.itemKeys;
      cacheKey = sectionKeys?.[ik] ?? `item-${sk}-${ik}`;
    }
    rncvLog('RNCV-JS-CELL', {
      op: 'derive-cell-key',
      index,
      measureOnly,
      layoutType: effectiveLayout.type,
      kind: fiDesc?._kind,
      sectionIndex: fiDesc?.sectionIndex,
      itemIndex: (fiDesc as any)?.itemIndex,
      cacheKey,
    });

    // Render-range cells are Activity=visible. Measure-range cells use
    // Activity=hidden so Fabric computes their Yoga layout without painting.
    // ShadowNode measures all children via Yoga and writes heights to LayoutCache.
    const mode: 'visible' | 'hidden' = measureOnly ? 'hidden' : 'visible';

    const useRealPosition = !!Activity; // true on RN 0.83+

    let estimatedTop: number;
    let cellLeft = sectionInsetLeft;
    let cellWidth = itemWidth;

    let attr = null;
    if (isSectioned) {
      if (fiDesc?._kind === 'header') {
        attr = nativeMod.layoutCache.getAttributes(`item-${fiDesc.sectionIndex}-header`);
      } else if (fiDesc?._kind === 'footer') {
        attr = nativeMod.layoutCache.getAttributes(`item-${fiDesc.sectionIndex}-footer`);
      } else {
        attr = effectiveLayout.attributesForItem((fiDesc as any)?.itemIndex ?? index, fiDesc?.sectionIndex ?? 0);
      }
    } else {
      attr = effectiveLayout.attributesForItem(index, 0);
    }

    if (attr) {
      estimatedTop = attr.frame.y;
      cellLeft = attr.frame.x;
      cellWidth = attr.frame.width;
    } else {
      estimatedTop = sectionInsetTop + index * stride;
    }
    rncvLog('RNCV-JS-CELL', {
      op: 'layout-attr',
      index,
      measureOnly,
      kind: fiDesc?._kind,
      sectionIndex: fiDesc?.sectionIndex,
      cacheKey,
      attrHit: !!attr,
      attrY: attr?.frame?.y,
      attrH: attr?.frame?.height,
      estimatedTop,
      cellLeft,
      cellWidth,
    });

    const top  = (measureOnly && !useRealPosition) ? -9999 : estimatedTop;
    const left = (measureOnly && !useRealPosition) ? -9999 : cellLeft;

    // No explicit height — Yoga measures from content. The ShadowNode reads
    // Yoga's measured height, compares with the LayoutCache estimate, and
    // cascades position corrections if they differ (zero-frame correction).
    const containerStyle = [
      {
        position: 'absolute' as const,
        left,
        top,
        ...(viewportWidth > 0 ? { width: cellWidth } : {}),
      },
    ];

    // ShadowNode measures via Yoga — no RNMeasuredCell wrapping needed.
    const content = (
      <CellWrapper mode={mode}>
        <MemoizedCellContent item={item} index={index} renderItem={stableRenderItem} extraData={extraData} />
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
      return (
        <RNScrollCoordinatedView
          key={key}
          style={containerStyle}
          behavior={stickyMode}
          naturalY={stickyConfig.naturalY}
          boundaryY={stickyConfig.boundaryY}
          headerHeight={stickyConfig.sizeHeight}
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
    const scrollY = prevScrollYRef.current;
    const vpH = viewportHeightRef.current || viewportHeight;

    mountedStickySet = new Set<number>();

    if (stickyHeaderFlatIndices.length > 0) {
      // Active header: last one whose naturalY ≤ scrollY
      let activeSlot = 0;
      for (let i = stickyHeaderFlatIndices.length - 1; i >= 0; i--) {
        const fi = stickyHeaderFlatIndices[i]!;
        const sd = isSectioned ? flattenResult?.flatData[fi] : null;
        const attr = (isSectioned && sd?._kind === 'header')
          ? nativeMod.layoutCache.getAttributes(`item-${sd.sectionIndex}-header`)
          : effectiveLayout.attributesForItem(isSectioned ? ((sd as any)?.itemIndex ?? fi) : fi, isSectioned ? (sd?.sectionIndex ?? 0) : 0);
        const posY = attr ? attr.frame.y : sectionInsetTop + fi * stride;
        if (posY <= scrollY) { activeSlot = i; break; }
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
      // Active footer: last one whose naturalY ≤ (scrollY + vpH - footerH)
      let activeSlot = 0;
      for (let i = stickyFooterFlatIndices.length - 1; i >= 0; i--) {
        const fi = stickyFooterFlatIndices[i]!;
        const sd = isSectioned ? flattenResult?.flatData[fi] : null;
        const attr = (isSectioned && sd?._kind === 'footer')
          ? nativeMod.layoutCache.getAttributes(`item-${sd.sectionIndex}-footer`)
          : effectiveLayout.attributesForItem(isSectioned ? ((sd as any)?.itemIndex ?? fi) : fi, isSectioned ? (sd?.sectionIndex ?? 0) : 0);
        const posY = attr ? attr.frame.y : sectionInsetTop + fi * stride;
        const h = attr ? attr.frame.height : effectiveItemHeight;
        if (posY <= (scrollY + vpH - h)) { activeSlot = i; break; }
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

    let cells: React.ReactElement[];

    if (rr === null) {
      effFirst = 0;
      effLast = Math.min(initialNumToRender, itemCount) - 1;
      effLast = Math.min(effLast, data.length - 1);
      cells = [];
      for (let i = effFirst; i <= effLast; i++) {
        if (mountedStickySet?.has(i)) continue;
        if (!data[i]) continue;
        cells.push(renderCell(data[i]!, i, false));
      }
    } else if (!isVariableHeight || measureRange.last < measureRange.first) {
      effFirst = rr.first;
      effLast = Math.min(rr.last, data.length - 1);
      cells = [];
      for (let i = effFirst; i <= effLast; i++) {
        if (mountedStickySet?.has(i)) continue;
        if (!data[i]) continue;
        cells.push(renderCell(data[i]!, i, false));
      }
    } else {
      effFirst = Math.min(rr.first, measureRange.first);
      effLast  = Math.max(rr.last,  measureRange.last);
      effLast  = Math.min(effLast, data.length - 1);
      cells = [];
      for (let i = effFirst; i <= effLast; i++) {
        if (mountedStickySet?.has(i)) continue;
        if (!data[i]) continue;
        const measureOnly = i < rr.first || i > rr.last;
        cells.push(renderCell(data[i]!, i, measureOnly));
      }
    }
    rncvLog('RNCV-JS-RANGE', {
      op: 'scrollContent',
      rr,
      measureRange,
      effFirst,
      effLast,
      cellsCount: cells.length,
      stickyCellsCount: (stickyHeaderCells?.length ?? 0) + (stickyFooterCells?.length ?? 0),
      mountedStickyIndices: mountedStickySet ? Array.from(mountedStickySet.values()) : [],
      isVariableHeight,
    });

    return <>{stickyHeaderCells}{stickyFooterCells}{cells}</>;
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

  // ── Section heights + decoration backgrounds ────────────────────────────────

  const sectionHeights = useMemo(() => {
    if (!propSections || !flattenResult) return [];
    const startIndices = flattenResult.sectionStartFlatIndices;
    return propSections.map((_, i) => {
      const startAttr = effectiveLayout.attributesForItem(startIndices[i]!, 0);
      const startY = startAttr ? startAttr.frame.y : 0;
      let endY: number;
      if (i + 1 < propSections.length) {
        const endAttr = effectiveLayout.attributesForItem(startIndices[i + 1]!, 0);
        endY = endAttr ? endAttr.frame.y : startY;
      } else {
        endY = Math.max(contentHeight, startY);
      }
      return Math.max(0, endY - startY);
    });
  }, [propSections, flattenResult, contentHeight, effectiveLayout,
      // eslint-disable-next-line react-hooks/exhaustive-deps
      layoutCacheVersion]);

  // Inject decoration backgrounds into scroll content via renderScrollView.
  const renderScrollView = useMemo(() => {
    if (!renderSectionBackground || !propSections || !flattenResult) return propRenderScrollView;
    const startIndices = flattenResult.sectionStartFlatIndices;
    return (props: any) => {
      const { children: cvContent, ...scrollProps } = props;
      const decorations = propSections.map((s, i) => {
        const bg = renderSectionBackground(i);
        if (!bg) return null;
        const startAttr = effectiveLayout.attributesForItem(startIndices[i]!, 0);
        return (
          <View
            key={s.key + '_bg'}
            pointerEvents="none"
            style={{
              position: 'absolute',
              top:    startAttr ? startAttr.frame.y : 0,
              left:   0,
              right:  0,
              height: sectionHeights[i] ?? 0,
            }}
          >
            {bg}
          </View>
        );
      });
      if (propRenderScrollView) {
        return propRenderScrollView({ ...props, children: <>{decorations}{cvContent}</> });
      }
      return (
        <ScrollView {...scrollProps}>
          {decorations}
          {cvContent}
        </ScrollView>
      );
    };
  }, [renderSectionBackground, propSections, flattenResult, sectionHeights, propRenderScrollView]);

  // ── Render ───────────────────────────────────────────────────────────────────

  const hud = showHUD
    ? <CollectionViewHUD snapshotRef={hudSnapshotRef} nativeMod={nativeMod} />
    : null;


  if (__DEV__ && (renderScrollView || ScrollViewComponent)) {
    console.warn(
      'CollectionView: ScrollViewComponent and renderScrollView are not supported ' +
      'in ShadowNode mode. The native RNCollectionViewContainer owns the scroll view.',
    );
  }

  const renderRangeStart = effFirst;
  const renderRangeEnd   = effLast;

  return (
    <View style={[{ flex: 1 }, style]} onLayout={onContainerLayout}>
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
        showsVerticalScrollIndicator={scrollViewProps?.showsVerticalScrollIndicator ?? true}
        scrollEventThrottle={16}
        onScroll={contractProps.onScroll}
      >
        {scrollContent}
      </RNCollectionViewContainer>
      {hud}
    </View>
  );
}
