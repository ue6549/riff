/**
 * Tab 6 — Dynamic Resize Reflow
 *
 * Animated container resize simulating iPad split-view or foldable device.
 * Container width animates 100%→50%→100% over ~3 seconds.
 *
 * CollectionView (C++ GridLayout): responsive 3→2→1 columns at two breakpoints.
 *   The layout reflows per-frame as width changes — column count adapts dynamically.
 * FlashList (numColumns=3): fixed 3 columns — cannot change column count during resize.
 *   Changing numColumns unmounts & remounts the entire list, losing scroll position.
 *
 * This demonstrates a capability gap: CV can adapt layout topology during resize,
 * FlashList cannot (numColumns is static, changing it destroys the list).
 * HUD shows: frame time, layout recomputation count, dropped frames.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Riff } from '../../components/CollectionView';
import { grid } from '@riff/layouts';

// ── Data ──────────────────────────────────────────────────────────────────────

const ITEM_COUNT = 1000;
const COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#f4a261', '#264653', '#457b9d', '#6a4c93', '#1982c4'];

const ROW_HEIGHT = 100;

type GridItem = { id: number; color: string };

const DATA: GridItem[] = Array.from({ length: ITEM_COUNT }, (_, i) => ({
  id: i,
  color: COLORS[i % COLORS.length]!,
}));

// ── Perf tracker ──────────────────────────────────────────────────────────────

function usePerfTracker() {
  const [frameTime, setFrameTime] = useState(0);
  const [droppedFrames, setDroppedFrames] = useState(0);
  const [layoutCount, setLayoutCount] = useState(0);
  const rafRef = useRef<number>();
  const lastRef = useRef(performance.now());
  const isRunning = useRef(false);
  const droppedRef = useRef(0);
  const layoutCountRef = useRef(0);

  const start = useCallback(() => {
    isRunning.current = true;
    droppedRef.current = 0;
    layoutCountRef.current = 0;
    setDroppedFrames(0);
    setLayoutCount(0);
    lastRef.current = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = now - lastRef.current;
      lastRef.current = now;
      const rounded = Math.round(dt * 10) / 10;
      setFrameTime(rounded);
      // Count frames > 20ms as dropped (should be ~16.6ms)
      if (dt > 20) {
        droppedRef.current += 1;
        setDroppedFrames(droppedRef.current);
      }
      if (isRunning.current) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const stop = useCallback(() => {
    isRunning.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  const countLayout = useCallback(() => {
    layoutCountRef.current += 1;
    setLayoutCount(layoutCountRef.current);
  }, []);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  return { frameTime, droppedFrames, layoutCount, start, stop, countLayout };
}

// ── Responsive column breakpoints ────────────────────────────────────────────
// Full width → 3 cols, ~75% → 2 cols, ~55% → 1 col.
// Two breakpoints make the reflow visually dramatic: 3→2→1→2→3.

const SCREEN_W = Dimensions.get('window').width;
const BP_2COL = SCREEN_W * 0.75;
const BP_1COL = SCREEN_W * 0.55;
const responsiveColumns = (containerWidth: number) =>
  containerWidth < BP_1COL ? 1 : containerWidth < BP_2COL ? 2 : 3;

// ── CV side: Grid with C++ layout ────────────────────────────────────────────

const cvGridLayout = grid({
  columns: responsiveColumns,
  rowHeight: ROW_HEIGHT,
  columnSpacing: 6,
  rowSpacing: 6,
});

function CVResize({ widthAnim, onLayout: onLayoutCb }: {
  widthAnim: Animated.Value;
  onLayout?: () => void;
}) {
  const keyExt = useCallback((item: GridItem) => String(item.id), []);
  const renderCV = useCallback(({ item }: { item: GridItem }) => (
    <View style={[S.gridCell, { backgroundColor: item.color }]}>
      <Text style={S.cellId}>{item.id}</Text>
    </View>
  ), []);

  return (
    <Animated.View
      style={[S.listContainer, {
        width: widthAnim.interpolate({
          inputRange: [0, 1],
          outputRange: ['50%', '100%'],
        }),
      }]}
      onLayout={onLayoutCb}
    >
      <Riff
        data={DATA}
        layout={cvGridLayout}
        keyExtractor={keyExt}
        renderItem={renderCV}
        sectionInsetTop={4}
        sectionInsetBottom={4}
        sectionInsetLeft={4}
        sectionInsetRight={4}
      />
    </Animated.View>
  );
}

// ── FlashList side: 2-column grid ─────────────────────────────────────────────

function FlashResize({ widthAnim, onLayout: onLayoutCb }: {
  widthAnim: Animated.Value;
  onLayout?: () => void;
}) {
  return (
    <Animated.View
      style={[S.listContainer, {
        width: widthAnim.interpolate({
          inputRange: [0, 1],
          outputRange: ['50%', '100%'],
        }),
      }]}
      onLayout={onLayoutCb}
    >
      <FlashList
        data={DATA}
        numColumns={3}
        keyExtractor={item => String(item.id)}
        estimatedItemSize={ROW_HEIGHT}
        renderItem={({ item }) => (
          <View style={[S.flashCell, { backgroundColor: item.color, height: ROW_HEIGHT }]}>
            <Text style={S.cellId}>{item.id}</Text>
          </View>
        )}
      />
    </Animated.View>
  );
}

// ── Tab ───────────────────────────────────────────────────────────────────────

export default function ResizeTab({ mode }: { mode: 'cv' | 'flash' }) {
  const widthAnim = useRef(new Animated.Value(1)).current;
  const [animating, setAnimating] = useState(false);
  const { frameTime, droppedFrames, layoutCount, start, stop, countLayout } = usePerfTracker();

  const runResize = useCallback(() => {
    widthAnim.setValue(1);
    setAnimating(true);
    start();

    Animated.sequence([
      Animated.timing(widthAnim, {
        toValue: 0,
        duration: 1500,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: false,
      }),
      Animated.timing(widthAnim, {
        toValue: 1,
        duration: 1500,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: false,
      }),
    ]).start(() => {
      setAnimating(false);
      stop();
    });
  }, [widthAnim, start, stop]);

  const onContainerLayout = useCallback(() => {
    if (animating) countLayout();
  }, [animating, countLayout]);

  return (
    <View style={S.root}>
      <Text style={S.hint}>
        {mode === 'cv'
          ? 'C++ grid · responsive 3→2→1 columns · reflows per-frame at two breakpoints'
          : 'FlashList grid · fixed 3 columns · changing numColumns unmounts & remounts the entire list'}
      </Text>

      <View style={S.controls}>
        <Pressable
          style={[S.startBtn, animating && S.startBtnDisabled]}
          onPress={animating ? undefined : runResize}
        >
          <Text style={S.startBtnText}>
            {animating ? 'Resizing…' : 'Simulate Split-View Resize'}
          </Text>
        </Pressable>
        <Text style={S.controlHint}>
          {ITEM_COUNT} items · CV: 3→2→1 col seamlessly · FlashList: numColumns is static, changing it destroys scroll position & state
        </Text>
      </View>

      {/* Metrics overlay */}
      <View style={S.overlay} pointerEvents="none">
        <Text style={S.metricLine}>
          Frame: <Text style={frameTime > 20 ? S.metricValBad : S.metricVal}>
            {frameTime}ms
          </Text>
        </Text>
        <Text style={S.metricLine}>
          Dropped: <Text style={droppedFrames > 0 ? S.metricValBad : S.metricVal}>
            {droppedFrames}
          </Text>
        </Text>
        <Text style={S.metricLine}>
          Relayouts: <Text style={S.metricVal}>{layoutCount}</Text>
        </Text>
        <Text style={S.metricLine}>
          Engine: <Text style={mode === 'cv' ? S.metricVal : S.metricValFlash}>
            {mode === 'cv' ? 'C++ grid (3→2→1)' : 'FlashList grid (fixed 3)'}
          </Text>
        </Text>
      </View>

      <View style={S.listArea}>
        {mode === 'cv'
          ? <CVResize widthAnim={widthAnim} onLayout={onContainerLayout} />
          : <FlashResize widthAnim={widthAnim} onLayout={onContainerLayout} />}
      </View>
    </View>
  );
}

const S = StyleSheet.create({
  root: { flex: 1 },
  hint: { fontSize: 11, color: '#4a5568', paddingHorizontal: 12, paddingVertical: 6 },

  controls: { paddingHorizontal: 12, paddingBottom: 8 },
  startBtn: { backgroundColor: '#1e3a1e', paddingVertical: 10, borderRadius: 8,
              alignItems: 'center' },
  startBtnDisabled: { backgroundColor: '#333', opacity: 0.6 },
  startBtnText: { fontSize: 13, fontWeight: '700', color: '#4ade80' },
  controlHint: { fontSize: 10, color: '#555', textAlign: 'center', marginTop: 4 },

  overlay: { position: 'absolute', top: 110, right: 8, backgroundColor: '#000c',
             borderRadius: 8, padding: 8, minWidth: 140, zIndex: 100 },
  metricLine: { fontSize: 11, color: '#94a3b8', fontFamily: 'Menlo', lineHeight: 18 },
  metricVal: { color: '#4ade80' },
  metricValBad: { color: '#f87171' },
  metricValFlash: { color: '#f59e0b' },

  listArea: { flex: 1 },
  listContainer: { flex: 1, alignSelf: 'flex-start' },

  gridCell: { flex: 1, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  cellId: { fontSize: 16, fontWeight: '700', color: '#fff' },

  flashCell: { flex: 1, margin: 3, borderRadius: 6,
               alignItems: 'center', justifyContent: 'center' },
});
