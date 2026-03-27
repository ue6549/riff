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
 *   Heights are reported via RNMeasuredCell (M4.2): a Fabric view that fires
 *   onMeasured from layoutSubviews — before the frame reaches the screen —
 *   eliminating the JS ref.measure() roundtrip entirely.
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
 * Scroll container is fully pluggable via three layers (§4.2):
 *   1. scrollViewProps      — forward extra props to the default ScrollView
 *   2. ScrollViewComponent  — swap the component class entirely
 *   3. renderScrollView     — full render control (render prop)
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
  findNodeHandle,
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

import NativeCollectionViewModule from 'riff/src/specs/NativeCollectionViewModule';
import { RiffSnapshot } from './CollectionSnapshot';
import RNMeasuredCell from './RNMeasuredCellNativeComponent';
import RNScrollCoordinatedView from './RNScrollCoordinatedViewNativeComponent';
import { layoutCache } from 'riff/src/LayoutCache';
import type { CollectionViewLayout, LayoutContext } from 'riff/src/types/protocol';

// ─── JSI module types ─────────────────────────────────────────────────────────

type NativeRange = { first: number; last: number };
type NativeWindowState = { render: NativeRange; visible: NativeRange };

const nativeMod = NativeCollectionViewModule as unknown as {
  listLayout: { computeListLayout(params: object): void };
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
    attachScrollView(reactTag: number): void;
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
const nativeListLayout       = nativeMod.listLayout;
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

/**
 * Computes render and visible index ranges from scroll position.
 * O(1) — pure arithmetic, no cache or JSI access.
 *
 * Item i has:  top = sectionInsetTop + i * stride
 *              bottom = top + itemHeight
 *
 * Velocity-adaptive (M3.4): the render window is asymmetric.
 * The leading edge expands as scroll speed increases so cells mount
 * before the viewport reaches them. The trailing edge contracts to
 * evict cells behind the user sooner and free memory faster.
 *
 * velocity: px/ms, positive = scrolling down. 0 = symmetric.
 * Each 1 px/ms of speed adds 1 additional viewport on the leading edge
 * (capped at +4 viewports). Trailing edge shrinks to a minimum of 0.25×.
 *
 * We add ±1 to both ends as an off-by-one safety margin.
 */
function computeRanges(
  scrollY: number,
  vpHeight: number,
  itemCount: number,
  stride: number,
  renderMult: number,
  sectionInsetTop: number,
  velocity: number = 0,
): { render: Range; visible: Range } {
  if (itemCount === 0 || stride <= 0) {
    return { render: { first: 0, last: -1 }, visible: { first: 0, last: -1 } };
  }

  const speed      = Math.abs(velocity);
  const leadBoost  = Math.min(4, speed) * renderMult;
  const leadMult   = renderMult + leadBoost;
  const trailMult  = Math.max(0.25, renderMult - leadBoost * 0.5);
  const goingDown  = velocity >= 0;

  const abovePad = (goingDown ? trailMult : leadMult) * vpHeight;
  const belowPad = (goingDown ? leadMult  : trailMult) * vpHeight;

  const adj = scrollY - sectionInsetTop;
  return {
    render: {
      first: Math.max(0,             Math.floor((adj - abovePad) / stride) - 1),
      last:  Math.min(itemCount - 1, Math.ceil((adj + vpHeight + belowPad) / stride) + 1),
    },
    visible: {
      first: Math.max(0,             Math.floor(adj / stride) - 1),
      last:  Math.min(itemCount - 1, Math.ceil((adj + vpHeight) / stride) + 1),
    },
  };
}

function rangeChanged(a: Range | null, b: Range): boolean {
  if (a === null) return true;
  return a.first !== b.first || a.last !== b.last;
}

/**
 * Binary-search helpers for variable-height range computation.
 * `positions[i]` = top-Y of item i (from itemPositionsRef).
 */
function posFirst(positions: number[], bound: number): number {
  // Last index where positions[i] < bound (i.e. item top is above bound).
  let lo = 0, hi = positions.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (positions[mid]! < bound) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

function posLast(positions: number[], bound: number): number {
  // Last index where positions[i] <= bound (item top at or above bound).
  let lo = 0, hi = positions.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (positions[mid]! <= bound) lo = mid;
    else hi = mid - 1;
  }
  return positions[lo]! <= bound ? lo : -1;
}

/**
 * Variable-height variant of computeRanges.
 * Uses actual item positions from the JS-side positions array
 * so the range is accurate regardless of height variance.
 */
function computeVariableRanges(
  scrollY:   number,
  vpHeight:  number,
  positions: number[],
  itemCount: number,
  renderMult: number,
  velocity:  number = 0,
): { render: Range; visible: Range } {
  if (itemCount === 0 || positions.length === 0) {
    return { render: { first: 0, last: -1 }, visible: { first: 0, last: -1 } };
  }

  const speed     = Math.abs(velocity);
  const leadBoost = Math.min(4, speed) * renderMult;
  const leadMult  = renderMult + leadBoost;
  const trailMult = Math.max(0.25, renderMult - leadBoost * 0.5);
  const goingDown = velocity >= 0;

  const abovePad = (goingDown ? trailMult : leadMult) * vpHeight;
  const belowPad = (goingDown ? leadMult  : trailMult) * vpHeight;

  const rFirst = posFirst(positions, scrollY - abovePad);
  const rLast  = Math.min(itemCount - 1, posLast(positions, scrollY + vpHeight + belowPad) + 1);
  const vFirst = posFirst(positions, scrollY);
  const vLast  = Math.min(itemCount - 1, posLast(positions, scrollY + vpHeight) + 1);

  return {
    render:  { first: rFirst, last: rLast },
    visible: { first: vFirst, last: vLast },
  };
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
}

function flattenSections<T>(sections: SectionConfig<T>[]): FlattenResult<T> {
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
    }

    for (let ii = 0; ii < s.data.length; ii++) {
      flatData.push({ _kind: 'item', sectionIndex: si, item: s.data[ii]!, itemIndex: ii });
    }

    if (s.footer) {
      const fi = flatData.length;
      if (s.footer.sticky) stickyFooterFlatIndices.push(fi);
      declaredHeights.set(`__f_${s.key}`, s.footer.height);
      flatData.push({ _kind: 'footer', sectionIndex: si });
    }
  }

  return { flatData, stickyHeaderFlatIndices, stickyFooterFlatIndices, sectionStartFlatIndices, declaredHeights };
}

/** Flat-mode key extractor for sectioned items. */
function sectionedKeyExtractor<T>(
  sections: SectionConfig<T>[],
  userKE: ((item: T, ...args: any[]) => string) | undefined,
  fi: FlatItem<T>,
  flatIndex: number,
): string {
  const sk = sections[fi.sectionIndex]?.key ?? String(fi.sectionIndex);
  if (fi._kind === 'header') return `__h_${sk}`;
  if (fi._kind === 'footer') return `__f_${sk}`;
  const raw = userKE ? userKE(fi.item, fi.sectionIndex, fi.itemIndex) : String(flatIndex);
  return `${sk}:${raw}`;
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
}: {
  item: any;
  index: number;
  renderItem: (info: any) => React.ReactElement | null;
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
  renderSectionBackground,
  ScrollViewComponent,
  scrollViewProps,
  renderScrollView: propRenderScrollView,
  style,
  showHUD = false,
}: RiffProps<T>) {

  // ── Section flattening ──────────────────────────────────────────────────────
  // If `sections` is provided, flatten to a flat item array. The rest of the
  // component operates on flat data — it doesn't know about sections.

  const isSectioned = !!propSections;

  const flattenResult = useMemo(
    () => propSections ? flattenSections(propSections) : null,
    [propSections],
  );

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
    return sectionedKeyExtractor(propSections, propKeyExtractor, item as FlatItem<T>, index);
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

  // ── Core state ──────────────────────────────────────────────────────────────
  const viewportWidthRef  = useRef(0);
  const viewportHeightRef = useRef(0);
  const [viewportWidth,  setViewportWidth]  = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
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

  // Stable renderItem wrapper for MemoizedCellContent.
  // Keeps the latest consumer function in a ref so memo's prop comparison
  // always sees the same function reference — even if the consumer passes a
  // new arrow function on every render without useCallback.
  const renderItemRef    = useRef(renderItem);
  renderItemRef.current  = renderItem;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableRenderItem = useCallback((info: RenderItemInfo<T>) => renderItemRef.current(info), []);

  const scrollRef = useRef<ScrollView>(null);
  const itemCount = data.length;

  // (Pre-populated heights are seeded into measuredHeightsRef below.)

  // Variable-height mode (M4.1) — active when estimatedItemHeight is set.
  // P1.1: C++ window controller — always active, independent of layout engine.
  const useCppWindow = !!nativeWindowController.computeRanges;
  const isVariableHeight  = estimatedItemHeight !== undefined;
  // Effective height used for stride/window computations. In variable mode this
  // is the estimate; actual heights come in asynchronously via onLayout.
  const effectiveItemHeight = estimatedItemHeight ?? itemHeight ?? 44;
  const stride    = effectiveItemHeight + itemSpacing;
  const itemWidth = Math.max(0, viewportWidth - sectionInsetLeft - sectionInsetRight);

  // In variable-height mode, use actual average measured height for budget
  // calculations once measurements are available. `stride` uses the estimate
  // which can be significantly off — budget would over/under-count items.

  // M4.1 — per-key measured heights (filled by cell onLayout, survives re-renders).
  // In sectioned mode, supplementary views with declared heights are pre-seeded.
  const measuredHeightsRef  = useRef(new Map<string, number>());
  if (flattenResult) {
    for (const [k, h] of flattenResult.declaredHeights) {
      if (!measuredHeightsRef.current.has(k)) measuredHeightsRef.current.set(k, h);
    }
  }
  // JS-side top-Y for each item. Updated synchronously during render (useMemo)
  // so that stickyConfigMap and the layout effect both see fresh positions
  // in the same render cycle when measuredVersion changes.
  const itemPositionsRef    = useRef<number[]>([]);
  // Bumping this triggers a new layout pass so measured heights are applied.
  const [measuredVersion, setMeasuredVersion] = useState(0);
  // RAF-based batch accumulator — all onLayout callbacks within a single frame
  // are collected here and flushed together so we trigger at most one re-layout
  // and one scroll correction per frame instead of one per cell.
  const pendingMeasurementsRef = useRef(new Map<string, { index: number; height: number }>());
  const flushScheduledRef      = useRef(false);
  // Separate microtask flush for measure-only (off-screen) cells.
  // They don't need scroll correction and don't need to wait a full RAF frame.
  const microFlushScheduledRef = useRef(false);

  // M4.1 measure-range — computed inside the layout effect (same batch as
  // renderRange) to prevent a render cascade. Extends the render range by
  // measureAhead viewport-heights in both directions.
  const [measureRange, setMeasureRange] = useState<Range>({ first: 0, last: -1 });
  const prevMeasureRef = useRef<Range>({ first: 0, last: -1 });

  // TS layout instances — created once per component instance (stable refs).

  // ── Layout protocol bridge ──────────────────────────────────────────────────
  // When `layout` prop is provided, use it instead of the internal layout engine.
  // Build LayoutContext from current state and call prepare() when deps change.
  // The layout writes to the shared LayoutCache (C++ layouts) or maintains its
  // own position state (TS layouts), and provides spatial queries.

  const useLayoutProtocol = !!layoutProp;

  const layoutContext: LayoutContext | null = useMemo(() => {
    if (!layoutProp || viewportWidth === 0) return null;
    return {
      containerWidth: viewportWidth,
      containerHeight: viewportHeight,
      scrollOffset: { x: 0, y: prevScrollYRef.current },
      sections: propSections
        ? propSections.map(s => ({
            itemCount: s.data.length,
            insets: undefined,
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
        : [{ itemCount: data.length, supplementaryItems: [] }],
    };
  }, [layoutProp, viewportWidth, viewportHeight, propSections, data.length]);

  // Prepare the layout when context changes (data, container size).
  // This replaces the C++ layoutCache.clear() + computeListLayout() calls
  // for layouts that conform to the protocol.
  const layoutContentSize = useMemo(() => {
    if (!layoutProp || !layoutContext) return null;
    layoutProp.prepare(layoutContext);
    return layoutProp.contentSize();
  }, [layoutProp, layoutContext, measuredVersion]);

  // When using layout protocol, the layout provides content height.
  // This is consumed in the layout effect below.
  const layoutProtocolContentHeight = layoutContentSize?.height ?? 0;

  // Query function: get attributes for items in a rect.
  // Used by the scroll handler and layout effect when layout protocol is active.
  const queryLayoutRect = useCallback((rect: { x: number; y: number; width: number; height: number }) => {
    if (!layoutProp) return [];
    return layoutProp.attributesForElements(rect);
  }, [layoutProp]);

  // ── Positions computation (synchronous, during render) ─────────────────────
  // Must run BEFORE stickyConfigMap and the layout effect so both see fresh
  // positions in the same render cycle when measuredVersion changes.
  // Previously this lived inside useLayoutEffect — that meant stickyConfigMap
  // (a useMemo) always read stale positions from the previous render.
  const computedPositions = useMemo(() => {
    if (!isVariableHeight) return null; // fixed mode: positions = index * stride
    const itemKeys = data.map((item, i) =>
      keyExtractor ? keyExtractor(item, i) : String(i),
    );
    let avgH = estimatedItemHeight ?? 44;
    if (measuredHeightsRef.current.size > 0) {
      let sum = 0;
      for (const h of measuredHeightsRef.current.values()) sum += h;
      avgH = sum / measuredHeightsRef.current.size;
    }
    let y = sectionInsetTop;
    const positions = new Array<number>(data.length);
    for (let i = 0; i < data.length; i++) {
      positions[i] = y;
      const h = measuredHeightsRef.current.get(itemKeys[i]!) ?? avgH;
      y += h + itemSpacing;
    }
    if (data.length > 0) y -= itemSpacing;
    y += sectionInsetBottom;
    // Update the ref synchronously so downstream useMemos see fresh data.
    itemPositionsRef.current = positions;
    return { positions, contentHeight: y, avgHeight: avgH };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVariableHeight, data, keyExtractor, estimatedItemHeight,
      sectionInsetTop, sectionInsetBottom, itemSpacing, measuredVersion]);

  // Budget stride: in variable-height mode, use actual average measured height
  // once available. Falls back to the estimated stride before any measurements.
  const budgetStride = (isVariableHeight && computedPositions)
    ? computedPositions.avgHeight + itemSpacing
    : stride;

  // ── Layout pass + initial window state ───────────────────────────────────────
  // useLayoutEffect so the accurate range (with real layout data) is committed
  // before the frame is painted — avoids a visible flash of stale positions.

  useLayoutEffect(() => {
    if (viewportWidth === 0 || viewportHeight === 0) return;
    nativeMod.signpost.begin(1);
    try {

    // ── Layout Protocol path ──────────────────────────────────────────────────
    // When a layout prop is provided, it has already been prepared (in the
    // layoutContentSize useMemo). Use its spatial query to determine the
    // render range instead of index-arithmetic.
    if (useLayoutProtocol && layoutProp && layoutContentSize) {
      setContentHeight(layoutProtocolContentHeight);

      if (itemCount === 0) {
        setRenderRange({ first: 0, last: -1 });
        return;
      }

      // Query the layout for items in the render window
      const scrollY = prevScrollYRef.current;
      const speed = Math.abs(velocityRef.current);
      const leadBoost = Math.min(4, speed) * renderMultiplier;
      const leadMult = renderMultiplier + leadBoost;
      const trailMult = Math.max(0.25, renderMultiplier - leadBoost * 0.5);
      const goingDown = velocityRef.current >= 0;
      const abovePad = (goingDown ? trailMult : leadMult) * viewportHeight;
      const belowPad = (goingDown ? leadMult : trailMult) * viewportHeight;

      const attrs = layoutProp.attributesForElements({
        x: 0,
        y: scrollY - abovePad,
        width: viewportWidth,
        height: viewportHeight + abovePad + belowPad,
      });

      if (attrs.length === 0) {
        setRenderRange({ first: 0, last: -1 });
      } else {
        // Convert attributes to index range
        let minIdx = Infinity, maxIdx = -Infinity;
        for (const attr of attrs) {
          if (attr.index < minIdx) minIdx = attr.index;
          if (attr.index > maxIdx) maxIdx = attr.index;
        }
        const render = { first: minIdx, last: maxIdx };

        // Apply budget
        const visAttrs = layoutProp.attributesForElements({
          x: 0, y: scrollY, width: viewportWidth, height: viewportHeight,
        });
        let visFirst = Infinity, visLast = -Infinity;
        for (const a of visAttrs) {
          if (a.index < visFirst) visFirst = a.index;
          if (a.index > visLast) visLast = a.index;
        }
        const visible = { first: visFirst === Infinity ? 0 : visFirst, last: visLast === -Infinity ? -1 : visLast };

        const budgeted = useCppWindow
          ? nativeWindowController.applyBudget(render.first, render.last, visible.first, visible.last, effectiveMountedWindowSize, viewportHeight, budgetStride)
          : applyBudget(render, visible, effectiveMountedWindowSize, viewportHeight, budgetStride);
        prevRenderRef.current = budgeted;
        setRenderRange(budgeted);
      }

      return; // finally block fires
    }

    // ── Legacy path (no layout prop) ──────────────────────────────────────────

    const itemKeys = data.map((item, i) =>
      keyExtractor ? keyExtractor(item, i) : String(i),
    );

    // In variable-height mode, pass per-item heights (measured if known, else
    // the running average of already-measured cells). As more cells are measured
    // the average converges toward the true mean, so position estimates for
    // unmeasured items become progressively more accurate. This directly fixes
    // the forward-scroll render-range drift where binary search on underestimated
    // positions returns the wrong first/last index.
    let avgMeasuredHeight = estimatedItemHeight ?? 44;
    if (isVariableHeight && measuredHeightsRef.current.size > 0) {
      let sum = 0;
      for (const h of measuredHeightsRef.current.values()) sum += h;
      avgMeasuredHeight = sum / measuredHeightsRef.current.size;
    }

    const itemHeightsArr = isVariableHeight
      ? data.map((_, i) => measuredHeightsRef.current.get(itemKeys[i]!) ?? avgMeasuredHeight)
      : undefined;

    const layoutParams = {
      itemCount,
      itemHeight: effectiveItemHeight,
      viewportWidth,
      sectionInsetTop,
      sectionInsetBottom,
      sectionInsetLeft,
      sectionInsetRight,
      itemSpacing,
      section: 0,
      keys: itemKeys,
      ...(itemHeightsArr ? { itemHeights: itemHeightsArr } : {}),
    };

    if (itemCount === 0) {
      setContentHeight(sectionInsetTop + sectionInsetBottom);
      setRenderRange({ first: 0, last: -1 });
      return; // finally block fires here
    }

    if (isVariableHeight) {
      // ── Variable-height path ────────────────────────────────────────────────
      // Positions already computed in the computedPositions useMemo (runs during
      // render, before this effect). itemPositionsRef.current is already fresh.
      const positions = itemPositionsRef.current;
      if (computedPositions) {
        onItemPositionsChange?.(positions);
        setContentHeight(computedPositions.contentHeight);
      }

      // Use JS-tracked scroll position (prevScrollYRef) so the range is accurate
      // even immediately after a programmatic scrollTo correction.
      const scrollY = prevScrollYRef.current;

      // P1.1: use C++ window controller for variable-height range computation.
      let render: Range, visible: Range;
      if (useCppWindow) {
        const ws = nativeWindowController.computeVariableRanges(
          scrollY, viewportHeight, positions, itemCount, renderMultiplier,
          velocityRef.current);
        render = ws.render; visible = ws.visible;
      } else {
        const ws = computeVariableRanges(
          scrollY, viewportHeight, positions, itemCount, renderMultiplier,
          velocityRef.current);
        render = ws.render; visible = ws.visible;
      }
      const budgeted = useCppWindow
        ? nativeWindowController.applyBudget(render.first, render.last, visible.first, visible.last, effectiveMountedWindowSize, viewportHeight, budgetStride)
        : applyBudget(render, visible, effectiveMountedWindowSize, viewportHeight, budgetStride);
      prevRenderRef.current = budgeted;
      setRenderRange(budgeted);

      // Measure range: computed here (same effect, same batch as setRenderRange)
      // to avoid a separate useEffect that would create a render cascade.
      if (isVariableHeight && measureAhead > 0) {
        const ahead = Math.ceil(measureAhead * viewportHeight / stride);
        const newMR = useCppWindow
          ? nativeWindowController.computeMeasureRange(budgeted.first, budgeted.last, ahead, itemCount)
          : { first: Math.max(0, budgeted.first - ahead), last: Math.min(itemCount - 1, budgeted.last + ahead) };
        if (newMR.first !== prevMeasureRef.current.first || newMR.last !== prevMeasureRef.current.last) {
          prevMeasureRef.current = newMR;
          setMeasureRange(newMR);
        }
      }

    } else {
      // ── Fixed-height path ─────────────────────────────────────────────────────
      layoutCache.clear();
      nativeListLayout.computeListLayout(layoutParams);
      setContentHeight(layoutCache.getTotalContentSize().height);

      // Read current scroll position from native atomics (UI thread is 1 frame ahead).
      // Independent of layout engine — RNCVScrollObserver writes these always.
      const scrollY = nativeWindowController.getScrollPosition().y;

      // P1.1: use C++ window controller for range computation when available.
      let render: Range, visible: Range;
      if (useCppWindow) {
        const ws = nativeWindowController.computeRanges(
          scrollY, viewportHeight, itemCount, stride, renderMultiplier, sectionInsetTop, 0);
        render = ws.render; visible = ws.visible;
      } else {
        const ws = computeRanges(
          scrollY, viewportHeight, itemCount, stride, renderMultiplier, sectionInsetTop);
        render = ws.render; visible = ws.visible;
      }
      const budgeted = useCppWindow
        ? nativeWindowController.applyBudget(render.first, render.last, visible.first, visible.last, effectiveMountedWindowSize, viewportHeight, budgetStride)
        : applyBudget(render, visible, effectiveMountedWindowSize, viewportHeight, budgetStride);
      prevRenderRef.current = budgeted;
      setRenderRange(budgeted);
    }

    } finally { nativeMod.signpost.end(1); }
  }, [
    viewportWidth,
    viewportHeight,
    data,
    itemCount,
    itemHeight,
    itemSpacing,
    sectionInsetTop,
    sectionInsetBottom,
    sectionInsetLeft,
    sectionInsetRight,
    renderMultiplier,
    effectiveMountedWindowSize,
    measureAhead,
    stride,
    estimatedItemHeight,
    measuredVersion,
    isVariableHeight,
    computedPositions,
    // keyExtractor intentionally omitted — keys derive from `data` (already a dep).
    // Including it would cause infinite re-fires when consumers pass inline arrows.
    useLayoutProtocol,
    layoutProp,
    layoutContentSize,
    layoutProtocolContentHeight,
  ]);

  // ── M2.2b: attach UI-thread scroll observer ──────────────────────────────────

  useEffect(() => {
    const tag = findNodeHandle(scrollRef.current);
    if (tag != null) {
      nativeWindowController.attachScrollView(tag);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // P5.1 — start CADisplayLink when HUD is active, stop on unmount or HUD off.
  useEffect(() => {
    if (!showHUD) return;
    nativeMod.metrics.startFrameTimer();
    return () => { nativeMod.metrics.stopFrameTimer(); };
  }, [showHUD]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── F1.2: Imperative handle ───────────────────────────────────────────────────

  useImperativeHandle(handle, () => ({
    snapshot: () => new RiffSnapshot(data, keyExtractor),

    apply: (snap: RiffSnapshot<T>, animated = true) => {
      const { data: newData, reloadedKeys } = snap.apply();

      // Evict cached heights for removed items (diff against current data)
      const oldKeys = data.map((item, i) =>
        keyExtractor ? keyExtractor(item, i) : String(i));
      const newKeys = newData.map((item, i) =>
        keyExtractor ? keyExtractor(item, i) : String(i));
      const diff = nativeMod.diffEngine.diff(oldKeys, newKeys);
      for (const k of diff.removed) measuredHeightsRef.current.delete(k);

      // Evict reloaded items so they re-measure
      for (const k of reloadedKeys) measuredHeightsRef.current.delete(k);

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
      for (const k of keys) measuredHeightsRef.current.delete(k);
      setMeasuredVersion(v => v + 1);
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

    // ── Eager initial range: eliminate the blank-frame flash ────────────────
    // On the very first layout, renderRange is still null and the useEffect
    // hasn't run yet. We can compute a good-enough initial range right here
    // using the stride estimate — no layout cache needed. This lets React
    // mount the first screenful of cells in the SAME commit as the viewport
    // measurement, before any frame is painted.
    if (prevRenderRef.current === null && w > 0 && h > 0) {
      // P1.1: C++ window controller for initial range (always, independent of layout engine).
      const wc = nativeWindowController;
      let initRender: Range, initVisible: Range;
      if (wc.computeRanges) {
        const ws = wc.computeRanges(0, h, itemCount, stride, renderMultiplier, sectionInsetTop, 0);
        initRender = ws.render; initVisible = ws.visible;
      } else {
        const ws = computeRanges(0, h, itemCount, stride, renderMultiplier, sectionInsetTop, 0);
        initRender = ws.render; initVisible = ws.visible;
      }
      const budgeted = wc.applyBudget
        ? wc.applyBudget(initRender.first, initRender.last, initVisible.first, initVisible.last, effectiveMountedWindowSize, h, budgetStride)
        : applyBudget(initRender, initVisible, effectiveMountedWindowSize, h, budgetStride);
      prevRenderRef.current = budgeted;
      setRenderRange(budgeted);

      // Also seed content height from estimates so scroll view has a size.
      const estContent = sectionInsetTop + itemCount * stride - itemSpacing + sectionInsetBottom;
      setContentHeight(estContent);

      // Seed itemPositions for variable-height mode so cells get estimated positions.
      if (isVariableHeight) {
        const positions = new Array<number>(itemCount);
        let y = sectionInsetTop;
        for (let i = 0; i < itemCount; i++) {
          positions[i] = y;
          y += stride;
        }
        itemPositionsRef.current = positions;
      }
    }
  }, [itemCount, stride, budgetStride, renderMultiplier, sectionInsetTop, sectionInsetBottom, itemSpacing, effectiveMountedWindowSize, isVariableHeight]);

  // ── M4.1 — Cell size measurement ─────────────────────────────────────────────

  const onCellLayout = useCallback((key: string, index: number, actualHeight: number) => {
    const prev  = measuredHeightsRef.current.get(key) ?? estimatedItemHeight!;
    const delta = actualHeight - prev;
    if (Math.abs(delta) < 1) return; // sub-pixel — skip

    // ── Measure-only cells (parked at top:-9999) ─────────────────────────────
    // They cannot cause viewport jumps so they don't need scroll correction and
    // don't need to wait a full RAF frame. Store the height immediately and
    // schedule a microtask flush so heights are available as early as possible
    // — often before the next scroll event fires.
    const rr = prevRenderRef.current;
    const isMeasureOnly = rr !== null && (index < rr.first || index > rr.last);

    if (isMeasureOnly) {
      // Remove any stale RAF-batch entry — this cell left the render range so
      // the pending correction it accumulated is no longer valid.
      pendingMeasurementsRef.current.delete(key);
      measuredHeightsRef.current.set(key, actualHeight);
      if (!microFlushScheduledRef.current) {
        microFlushScheduledRef.current = true;
        Promise.resolve().then(() => {
          microFlushScheduledRef.current = false;
          setMeasuredVersion(v => v + 1);
        });
      }
      return;
    }

    // ── Render-range cells ────────────────────────────────────────────────────
    // Accumulate into the pending batch for this animation frame.
    // All callbacks within one frame are processed together: one scroll
    // correction, one setMeasuredVersion bump, one layout pass.
    pendingMeasurementsRef.current.set(key, { index, height: actualHeight });

    if (!flushScheduledRef.current) {
      flushScheduledRef.current = true;
      requestAnimationFrame(() => {
        flushScheduledRef.current = false;
        const pending = pendingMeasurementsRef.current;
        if (pending.size === 0) return;
        nativeMod.signpost.begin(2);
        pendingMeasurementsRef.current = new Map();

        let scrollCorrection = 0;
        const currentScrollY = prevScrollYRef.current;

        for (const [k, { index: idx, height }] of pending) {
          const p = measuredHeightsRef.current.get(k) ?? estimatedItemHeight!;
          const d = height - p;
          if (Math.abs(d) < 1) continue;
          measuredHeightsRef.current.set(k, height);

          // Correct scroll offset for cells that shifted above the viewport.
          const cellTop = itemPositionsRef.current[idx]
            ?? (sectionInsetTop + idx * stride);
          if (cellTop < currentScrollY) {
            scrollCorrection += d;
          }
        }

        if (Math.abs(scrollCorrection) >= 1) {
          const correctedY = Math.max(0, currentScrollY + scrollCorrection);
          scrollRef.current?.scrollTo({ y: correctedY, animated: false });
          prevScrollYRef.current = correctedY;
          scrollCorrectionCountRef.current += 1; // P5.1
        }

        setMeasuredVersion(v => v + 1);
        nativeMod.signpost.end(2);
      });
    }
  }, [estimatedItemHeight, sectionInsetTop, stride]);

  // ── Scroll props ─────────────────────────────────────────────────────────────

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

      // ── Layout Protocol scroll path ──────────────────────────────────────────
      if (useLayoutProtocol && layoutProp) {
        // Check if layout needs recomputation (container resize during scroll)
        // Note: full resize invalidation is handled by the layout effect, not here.

        const speed = Math.abs(velocityRef.current);
        const leadBoost = Math.min(4, speed) * renderMultiplier;
        const leadMult = renderMultiplier + leadBoost;
        const trailMult = Math.max(0.25, renderMultiplier - leadBoost * 0.5);
        const goingDown = velocityRef.current >= 0;
        const abovePad = (goingDown ? trailMult : leadMult) * vpH;
        const belowPad = (goingDown ? leadMult : trailMult) * vpH;

        const attrs = layoutProp.attributesForElements({
          x: 0, y: scrollY - abovePad, width: viewportWidth, height: vpH + abovePad + belowPad,
        });

        let rFirst = Infinity, rLast = -Infinity;
        for (const a of attrs) {
          if (a.index < rFirst) rFirst = a.index;
          if (a.index > rLast) rLast = a.index;
        }
        const newR = { first: rFirst === Infinity ? 0 : rFirst, last: rLast === -Infinity ? -1 : rLast };

        const visAttrs = layoutProp.attributesForElements({
          x: 0, y: scrollY, width: viewportWidth, height: vpH,
        });
        let vFirst = Infinity, vLast = -Infinity;
        for (const a of visAttrs) {
          if (a.index < vFirst) vFirst = a.index;
          if (a.index > vLast) vLast = a.index;
        }
        const newV = { first: vFirst === Infinity ? 0 : vFirst, last: vLast === -Infinity ? -1 : vLast };

        const budgetedR = applyBudget(newR, newV, effectiveMountedWindowSize, vpH, budgetStride);
        const renderChanged = rangeChanged(prevRenderRef.current, budgetedR);
        if (renderChanged) {
          prevRenderRef.current = budgetedR;
          setRenderRange(budgetedR);
        }

        nativeMod.signpost.end(0);
        scrollViewProps?.onScroll?.(e);
        return; // skip legacy path
      }

      // P1.1 — Range computation via C++ JSI (cpp engine) or JS fallback (ts engine).
      // C++ path: sub-microsecond native arithmetic, no Hermes interpreter overhead.
      const positions = itemPositionsRef.current;
      const wc = nativeWindowController;
      let newR: Range, newV: Range;

      if (useCppWindow) {
        // C++ window controller — all arithmetic runs in native code
        if (isVariableHeight && positions.length > 0) {
          const ws = wc.computeVariableRanges(scrollY, vpH, positions, itemCount, renderMultiplier, velocityRef.current);
          newR = ws.render; newV = ws.visible;
        } else {
          const ws = wc.computeRanges(scrollY, vpH, itemCount, stride, renderMultiplier, sectionInsetTop, velocityRef.current);
          newR = ws.render; newV = ws.visible;
        }
      } else {
        // JS fallback (ts layout engine)
        if (isVariableHeight && positions.length > 0) {
          const ws = computeVariableRanges(scrollY, vpH, positions, itemCount, renderMultiplier, velocityRef.current);
          newR = ws.render; newV = ws.visible;
        } else {
          const ws = computeRanges(scrollY, vpH, itemCount, stride, renderMultiplier, sectionInsetTop, velocityRef.current);
          newR = ws.render; newV = ws.visible;
        }
      }

      const budgetedR = useCppWindow
        ? wc.applyBudget(newR.first, newR.last, newV.first, newV.last, effectiveMountedWindowSize, vpH, budgetStride)
        : applyBudget(newR, newV, effectiveMountedWindowSize, vpH, budgetStride);
      const renderChanged = rangeChanged(prevRenderRef.current, budgetedR);

      if (renderChanged) {
        prevRenderRef.current = budgetedR;
        setRenderRange(budgetedR);
      }

      // Update measure range in the scroll handler (same frame as render range)
      // so new cells are pre-mounted for measurement without waiting for the
      // next layout-effect cycle.
      if (isVariableHeight && measureAhead > 0) {
        const ahead = Math.ceil(measureAhead * vpH / stride);
        const newMR = useCppWindow
          ? wc.computeMeasureRange(budgetedR.first, budgetedR.last, ahead, itemCount)
          : { first: Math.max(0, budgetedR.first - ahead), last: Math.min(itemCount - 1, budgetedR.last + ahead) };
        if (newMR.first !== prevMeasureRef.current.first || newMR.last !== prevMeasureRef.current.last) {
          prevMeasureRef.current = newMR;
          setMeasureRange(newMR);
        }
      }

      // P5.3 / onBlankArea — compute blank px at top and bottom of viewport.
      // offsetStart: gap between viewport top and first render-range cell's top.
      // offsetEnd:   gap between last render-range cell's bottom and viewport bottom.
      // Both are 0 when the render window fully covers the visible area.
      if (budgetedR.last >= budgetedR.first) {
        const firstTop = positions[budgetedR.first] ?? (sectionInsetTop + budgetedR.first * stride);
        const lastTop  = positions[budgetedR.last]  ?? (sectionInsetTop + budgetedR.last  * stride);
        const lastKey  = keyExtractor ? keyExtractor(data[budgetedR.last]!, budgetedR.last) : String(budgetedR.last);
        const lastH    = measuredHeightsRef.current.get(lastKey) ?? effectiveItemHeight;
        const offsetStart = Math.max(0, firstTop - scrollY);
        const offsetEnd   = Math.max(0, scrollY + vpH - (lastTop + lastH));
        lastBlankAreaRef.current = { offsetStart, offsetEnd };
        onBlankArea?.({ offsetStart, offsetEnd });
      }

      // F1.3 — Prefetch/evict callbacks.
      // Extend the render range by prefetchAhead viewports to form the prefetch
      // window. Fire onPrefetch for newly entering keys, onEvict for leaving keys.
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

  // ── Sticky header config for ScrollCoordinatedView ──────────────────────────
  // Build a map: flatIndex → { naturalY, boundaryY, headerHeight, behavior }
  // Each sticky cell is wrapped in RNScrollCoordinatedView in renderCell.
  // The native component handles the transform on the UI thread.
  // MUST be defined before renderCell / scrollContent IIFE that consumes it.

  const stickyConfigMap = useMemo(() => {
    if (!hasStickyHeaders) return null;
    const positions = itemPositionsRef.current;
    const map = new Map<number, { naturalY: number; boundaryY: number; headerHeight: number }>();

    for (let i = 0; i < stickyHeaderFlatIndices.length; i++) {
      const fi = stickyHeaderFlatIndices[i]!;
      const naturalY = positions[fi] ?? sectionInsetTop + fi * stride;
      const key = keyExtractor ? keyExtractor(data[fi], fi) : String(fi);
      const headerHeight = measuredHeightsRef.current.get(key) ?? effectiveItemHeight;

      // boundaryY = next sticky header's naturalY (or Infinity if last).
      const nextFi = stickyHeaderFlatIndices[i + 1];
      const boundaryY = nextFi !== undefined
        ? (positions[nextFi] ?? sectionInsetTop + nextFi * stride)
        : 999999; // Large number — native side uses CGFloat, Infinity not available as prop.

      map.set(fi, { naturalY, boundaryY, headerHeight });
    }
    return map;
  }, [hasStickyHeaders, stickyHeaderFlatIndices, data, keyExtractor,
      effectiveItemHeight, sectionInsetTop, stride,
      // eslint-disable-next-line react-hooks/exhaustive-deps
      measuredVersion]);

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

    // P5.1 — cold mount: render-range cell whose height has never been measured.
    // (Only meaningful in variable-height mode — fixed-height cells are always "warm".)
    if (!measureOnly && isVariableHeight && !measuredHeightsRef.current.has(key)) {
      coldMountCountRef.current += 1;
    }

    // Render-range cells are always Activity=visible — they form the visual buffer.
    // Only measure-range cells use Activity=hidden to suppress user effects while
    // Fabric computes their Yoga layout (height measurement).
    const mode: 'visible' | 'hidden' = measureOnly ? 'hidden' : 'visible';

    // P3.1 — Offscreen Pre-rendering:
    //   When Activity is available (RN 0.83+), measure-only cells mount at their
    //   real estimated position with Activity=hidden. The cell is invisible to the
    //   user but Fabric lays it out at the correct location. When the viewport
    //   reaches the cell, only the Activity mode flips (hidden→visible) — a single
    //   atomic Fabric commit with no position change, no re-render.
    //
    //   Degraded path (Activity=null, RN < 0.83): park at top:-9999 as before.
    //   Without Activity the cell would be fully visible and overlap content.
    const useRealPosition = !!Activity; // true on RN 0.83+

    // When using layout protocol, get position from the layout engine.
    let estimatedTop: number;
    let cellLeft = sectionInsetLeft;
    let cellWidth = itemWidth;
    let cellHeight: number | undefined = !isVariableHeight && !measureOnly ? effectiveItemHeight : undefined;

    if (useLayoutProtocol && layoutProp) {
      const attr = layoutProp.attributesForItem(index, 0);
      if (attr) {
        estimatedTop = attr.frame.y;
        cellLeft = attr.frame.x;
        cellWidth = attr.frame.width;
        if (attr.frame.height > 0) cellHeight = attr.frame.height;
      } else {
        estimatedTop = sectionInsetTop + index * stride;
      }
    } else {
      estimatedTop = isVariableHeight
        ? (itemPositionsRef.current[index] ?? sectionInsetTop + index * stride)
        : sectionInsetTop + index * stride;
    }

    const top  = (measureOnly && !useRealPosition) ? -9999 : estimatedTop;
    const left = (measureOnly && !useRealPosition) ? -9999 : cellLeft;

    const containerStyle = [
      {
        position: 'absolute' as const,
        left,
        right: useLayoutProtocol ? undefined : sectionInsetRight,
        top,
        // Use explicit width once viewport is known; before that, left+right
        // insets make the cell stretch to fill (works for initialNumToRender).
        ...(viewportWidth > 0 ? { width: cellWidth, right: undefined } : {}),
      },
      // Fixed mode / layout protocol: constrain height.
      // Variable / measure-only: height is self-determined.
      cellHeight != null && !measureOnly && { height: cellHeight },
    ];

    const content = (
      <CellWrapper mode={mode}>
        <MemoizedCellContent item={item} index={index} renderItem={stableRenderItem} />
      </CellWrapper>
    );

    // Wrap in RNScrollCoordinatedView if this cell is sticky.
    // The native component applies a transform on the UI thread — single view
    // instance, no overlay, no JS per-frame updates.
    const stickyConfig = stickyConfigMap?.get(index);

    const innerContent = (isVariableHeight || measureOnly)
      ? <RNMeasuredCell
          onMeasured={(e: any) => onCellLayout(key, index, (e.nativeEvent as { height: number }).height)}
        >
          {content}
        </RNMeasuredCell>
      : content;

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
          headerHeight={stickyConfig.headerHeight}
          enabled={true}
        >
          {innerContent}
        </RNScrollCoordinatedView>
      );
    }

    return (
      <View key={key} style={containerStyle}>
        {innerContent}
      </View>
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

  const stickyIndexSet = useMemo(
    () => stickyConfigMap ? new Set(stickyConfigMap.keys()) : null,
    [stickyConfigMap],
  );

  let mountedStickySet: Set<number> | null = null;
  let stickyHeaderCells: React.ReactElement[] | null = null;

  if (stickyConfigMap && stickyIndexSet && stickyHeaderFlatIndices.length > 0) {
    // Find the active sticky: last one whose position ≤ scroll top.
    const positions = itemPositionsRef.current;
    const scrollY = prevScrollYRef.current;
    let activeSlot = 0; // index into stickyHeaderFlatIndices array
    for (let i = stickyHeaderFlatIndices.length - 1; i >= 0; i--) {
      const fi = stickyHeaderFlatIndices[i]!;
      const posY = positions[fi] ?? sectionInsetTop + fi * stride;
      if (posY <= scrollY) {
        activeSlot = i;
        break;
      }
    }

    const first = Math.max(0, activeSlot - STICKY_BUFFER_BEFORE);
    const last  = Math.min(stickyHeaderFlatIndices.length - 1, activeSlot + STICKY_BUFFER_AFTER);

    mountedStickySet = new Set<number>();
    stickyHeaderCells = [];
    for (let s = first; s <= last; s++) {
      const fi = stickyHeaderFlatIndices[s]!;
      if (!data[fi]) continue;
      mountedStickySet.add(fi);
      stickyHeaderCells.push(renderCell(data[fi]!, fi, false));
    }
  }

  const scrollContent = (() => {
    if (!viewportWidth && rr !== null) return <View style={{ height: contentHeight }} />;

    let cells: React.ReactElement[];

    if (rr === null) {
      // Before viewport is measured: render initialNumToRender items at
      // stride-estimated positions so the very first paint has content.
      // Items use width:undefined (fills parent) since viewportWidth is
      // unknown. Once onContainerLayout fires the real range takes over.
      const n = Math.min(initialNumToRender, itemCount);
      cells = [];
      for (let i = 0; i < n; i++) {
        // Skip sticky headers — they're rendered permanently above.
        if (mountedStickySet?.has(i)) continue;
        cells.push(renderCell(data[i]!, i, false));
      }
      // Estimate content height so scroll view has a size.
      const estH = sectionInsetTop + itemCount * stride - itemSpacing + sectionInsetBottom;
      return <View style={{ height: estH }}>{stickyHeaderCells}{cells}</View>;
    } else if (!isVariableHeight || measureRange.last < measureRange.first) {
      // Fixed height or measure range not yet set: render range only.
      cells = [];
      for (let i = rr.first; i <= rr.last; i++) {
        if (mountedStickySet?.has(i)) continue;
        cells.push(renderCell(data[i]!, i, false));
      }
    } else {
      // Variable height with active measure range.
      // measureRange is always a superset of renderRange (set in the same batch).
      // The union guard handles any edge case where they diverge momentarily.
      const effFirst = Math.min(rr.first, measureRange.first);
      const effLast  = Math.max(rr.last,  measureRange.last);
      cells = [];
      for (let i = effFirst; i <= effLast; i++) {
        if (mountedStickySet?.has(i)) continue;
        // measureOnly = outside the (urgent) render range — park off-screen.
        const measureOnly = i < rr.first || i > rr.last;
        cells.push(renderCell(data[i]!, i, measureOnly));
      }
    }

    return <View style={{ height: contentHeight }}>{stickyHeaderCells}{cells}</View>;
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
    const positions = itemPositionsRef.current;
    return propSections.map((_, i) => {
      const startY = positions[startIndices[i]!] ?? 0;
      const endY   = i + 1 < propSections.length
        ? (positions[startIndices[i + 1]!] ?? startY)
        : Math.max(contentHeight, startY);
      return Math.max(0, endY - startY);
    });
  }, [propSections, flattenResult, contentHeight,
      // eslint-disable-next-line react-hooks/exhaustive-deps
      measuredVersion]);

  // Inject decoration backgrounds into scroll content via renderScrollView.
  const renderScrollView = useMemo(() => {
    if (!renderSectionBackground || !propSections || !flattenResult) return propRenderScrollView;
    const startIndices = flattenResult.sectionStartFlatIndices;
    return (props: any) => {
      const { children: cvContent, ...scrollProps } = props;
      const positions = itemPositionsRef.current;
      const decorations = propSections.map((s, i) => {
        const bg = renderSectionBackground(i);
        if (!bg) return null;
        return (
          <View
            key={s.key + '_bg'}
            pointerEvents="none"
            style={{
              position: 'absolute',
              top:    positions[startIndices[i]!] ?? 0,
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


  if (renderScrollView) {
    return (
      <View style={[{ flex: 1 }, style]} onLayout={onContainerLayout}>
        {renderScrollView({ ...contractProps, children: scrollContent })}

        {hud}
      </View>
    );
  }

  if (ScrollViewComponent) {
    return (
      <View style={[{ flex: 1 }, style]} onLayout={onContainerLayout}>
        <ScrollViewComponent style={{ flex: 1 }} {...contractProps}>
          {scrollContent}
        </ScrollViewComponent>

        {hud}
      </View>
    );
  }

  return (
    <View style={[{ flex: 1 }, style]} onLayout={onContainerLayout}>
      <ScrollView ref={scrollRef} style={{ flex: 1 }} {...contractProps}>
        {scrollContent}
      </ScrollView>
      {hud}
    </View>
  );
}
