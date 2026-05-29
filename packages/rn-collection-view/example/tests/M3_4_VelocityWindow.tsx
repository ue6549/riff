/**
 * M3.4 — Velocity-Adaptive Window
 *
 * Demonstrates that the render window expands asymmetrically as scroll
 * velocity increases, pre-loading more cells in the direction of travel
 * to prevent white spaces on fast scroll.
 *
 * What to observe:
 *   · "Window size" badge: increases during fast scroll, shrinks when stopped.
 *   · "Velocity" badge: shows current scroll speed in px/ms.
 *   · Scroll slowly: symmetric window (~renderMult each side).
 *   · Fling fast downward: large window below, small window above.
 *   · Fling fast upward: large window above, small window below.
 *   · Stop: window returns to symmetric baseline.
 *
 * White-area test:
 *   Fling as fast as possible. Any white area that appears is a gap between
 *   the lead edge of the render window and the viewport. With velocity
 *   adaptation, this gap should be smaller than with a fixed window.
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  SafeAreaView,
  ScrollView as RNScrollView,
  ScrollViewProps,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Riff } from '@riff/components/CollectionView';

// ─── Dataset ──────────────────────────────────────────────────────────────────

const ITEM_COUNT = 1000;
const ITEM_H     = 64;

type Item = { id: number; color: string };
const COLORS = ['#1a1a2e', '#16213e', '#0f3460', '#162447', '#1b262c'];
const DATA: Item[] = Array.from({ length: ITEM_COUNT }, (_, i) => ({
  id:    i,
  color: COLORS[i % COLORS.length]!,
}));

// ─── Cell ─────────────────────────────────────────────────────────────────────

function VelocityCell({ item }: { item: Item }) {
  return (
    <View style={[S.cell, { backgroundColor: item.color }]}>
      <Text style={S.cellText}>#{item.id}</Text>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function M3_4_VelocityWindow() {
  const [renderCount, setRenderCount] = useState(0);
  const [velocity,    setVelocity]    = useState(0);

  // Mirror velocity from the CollectionView's internal tracking.
  // We inject a thin scrollViewProps.onScroll to read velocity externally.
  const prevYRef    = useRef(0);
  const prevTimeRef = useRef(0);

  const onScroll = useCallback((e: any) => {
    const y   = e.nativeEvent.contentOffset.y;
    const now = Date.now();
    const dt  = now - prevTimeRef.current;
    if (dt > 0 && dt <= 100) {
      setVelocity((y - prevYRef.current) / dt);
    } else if (dt > 100) {
      setVelocity(0);
    }
    prevYRef.current   = y;
    prevTimeRef.current = now;
  }, []);

  const onRenderCountChange = useCallback((count: number) => {
    setRenderCount(count);
  }, []);

  const absVel    = Math.abs(velocity);
  const direction = velocity > 0.05 ? '↓' : velocity < -0.05 ? '↑' : '—';

  return (
    <SafeAreaView style={S.root}>
      {/* Header */}
      <View style={S.header}>
        <Text style={S.title}>M3.4 — Velocity-Adaptive Window</Text>
        <Text style={S.subtitle}>
          {ITEM_COUNT} items · Fling fast to see window expand in direction of travel
        </Text>

        <View style={S.stats}>
          <StatBadge
            label="Rendered"
            value={`${renderCount} / ${ITEM_COUNT}`}
          />
          <StatBadge
            label={`Velocity ${direction}`}
            value={`${absVel.toFixed(2)} px/ms`}
            accent={absVel > 0.5}
          />
        </View>

        {/* Visual velocity bar */}
        <View style={S.barTrack}>
          <View style={[
            S.barFill,
            { width: `${Math.min(100, absVel / 5 * 100)}%` as any },
            absVel > 2 && S.barFillFast,
          ]} />
        </View>
        <Text style={S.barLabel}>
          0 px/ms{'  '}
          {'─'.repeat(20)}
          {'  '}5+ px/ms
        </Text>
      </View>

      {/* List */}
      <Riff
        data={DATA}
        keyExtractor={item => String(item.id)}
        renderItem={({ item }) => <VelocityCell item={item} />}
        estimatedItemHeight={ITEM_H}
        itemSpacing={1}
        renderMultiplier={1.0}
        onRenderCountChange={onRenderCountChange}
        scrollViewProps={{ onScroll, scrollEventThrottle: 16 }}
      />
    </SafeAreaView>
  );
}

function StatBadge({
  label, value, accent,
}: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={[S.badge, accent && S.badgeAccent]}>
      <Text style={S.badgeLabel}>{label}</Text>
      <Text style={[S.badgeValue, accent && S.badgeValueAccent]}>{value}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  root:             { flex: 1, backgroundColor: '#0a0a0a' },

  header:           { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10,
                      borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  title:            { fontSize: 15, fontWeight: '700', color: '#fff', marginBottom: 2 },
  subtitle:         { fontSize: 11, color: '#555', marginBottom: 10 },

  stats:            { flexDirection: 'row', gap: 8, marginBottom: 10 },
  badge:            { backgroundColor: '#161616', borderRadius: 8,
                      paddingHorizontal: 10, paddingVertical: 6, flex: 1 },
  badgeAccent:      { backgroundColor: '#1a1a00' },
  badgeLabel:       { fontSize: 10, color: '#555', marginBottom: 2 },
  badgeValue:       { fontSize: 13, fontWeight: '700', color: '#fff', fontFamily: 'Menlo' },
  badgeValueAccent: { color: '#fbbf24' },

  barTrack:         { height: 6, backgroundColor: '#1a1a1a', borderRadius: 3,
                      marginBottom: 4, overflow: 'hidden' },
  barFill:          { height: '100%', backgroundColor: '#4ade80', borderRadius: 3 },
  barFillFast:      { backgroundColor: '#f87171' },
  barLabel:         { fontSize: 9, color: '#333', fontFamily: 'Menlo', marginBottom: 2 },

  cell:             { flex: 1, justifyContent: 'center', paddingHorizontal: 16,
                      borderRadius: 4 },
  cellText:         { fontSize: 13, color: '#ffffff88', fontFamily: 'Menlo' },
});
