/**
 * M2.2 — Native Scroll Bridge
 *
 * Verifies that the C++ windowController JSI object:
 *   1. Exists on the native module
 *   2. updateScrollPosition(y, x) returns undefined
 *   3. getScrollPosition() round-trips correctly
 *   4. Second update overwrites the first
 *   5. Reset to (0, 0) works
 *
 * Interactive section: a live ScrollView feeds real scroll events
 * to the C++ bridge; getScrollPosition() is polled every 100ms so
 * you can confirm JS-thread delivery is working.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { native } from './native';
import { TestResult, TestScreen } from './shared';

// ─── Automated tests ──────────────────────────────────────────────────────────

function runTests(): TestResult[] {
  const results: TestResult[] = [];

  // T1: windowController exists
  try {
    const wc = native.windowController;
    results.push({
      label: 'windowController exists on native module',
      value: wc != null ? 'object present' : 'null / undefined',
      pass:  wc != null && typeof wc === 'object',
    });
  } catch (e: any) {
    results.push({ label: 'windowController exists', value: String(e), pass: false });
  }

  // T2: updateScrollPosition returns undefined
  try {
    const ret = (native.windowController.updateScrollPosition as any)(100, 50);
    results.push({
      label: 'updateScrollPosition(100, 50) → undefined',
      value: ret === undefined ? 'undefined' : `got: ${JSON.stringify(ret)}`,
      pass:  ret === undefined,
    });
  } catch (e: any) {
    results.push({ label: 'updateScrollPosition returns undefined', value: String(e), pass: false });
  }

  // T3: getScrollPosition round-trip
  try {
    native.windowController.updateScrollPosition(123.5, 45.25);
    const pos = native.windowController.getScrollPosition();
    const yOk = Math.abs(pos.y - 123.5) < 0.001;
    const xOk = Math.abs(pos.x - 45.25) < 0.001;
    results.push({
      label: 'getScrollPosition() round-trip (y=123.5, x=45.25)',
      value: `y=${pos.y} x=${pos.x}`,
      pass:  yOk && xOk,
    });
  } catch (e: any) {
    results.push({ label: 'getScrollPosition round-trip', value: String(e), pass: false });
  }

  // T4: second update overwrites first
  try {
    native.windowController.updateScrollPosition(999, 888);
    native.windowController.updateScrollPosition(200, 100);
    const pos = native.windowController.getScrollPosition();
    const yOk = Math.abs(pos.y - 200) < 0.001;
    const xOk = Math.abs(pos.x - 100) < 0.001;
    results.push({
      label: 'second update overwrites first (y=200, x=100)',
      value: `y=${pos.y} x=${pos.x}`,
      pass:  yOk && xOk,
    });
  } catch (e: any) {
    results.push({ label: 'second update overwrites first', value: String(e), pass: false });
  }

  // T5: reset to (0, 0)
  try {
    native.windowController.updateScrollPosition(0, 0);
    const pos = native.windowController.getScrollPosition();
    results.push({
      label: 'reset to (0, 0)',
      value: `y=${pos.y} x=${pos.x}`,
      pass:  pos.y === 0 && pos.x === 0,
    });
  } catch (e: any) {
    results.push({ label: 'reset to (0, 0)', value: String(e), pass: false });
  }

  return results;
}

// ─── Live scroll demo ──────────────────────────────────────────────────────────

const DEMO_ITEM_COUNT = 40;
const DEMO_ITEM_H     = 56;

function LiveScrollDemo() {
  const [scrollY, setScrollY] = useState(0);
  const [cppY,    setCppY]    = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      try {
        const pos = native.windowController.getScrollPosition();
        setCppY(pos.y);
      } catch {}
    }, 100);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return (
    <View style={D.wrapper}>
      <Text style={D.sectionTitle}>Live scroll bridge</Text>
      <Text style={D.sectionSub}>
        Scroll the list — JS and C++ values should track together
      </Text>

      <View style={D.gauge}>
        <View style={D.gaugeRow}>
          <Text style={D.gaugeLabel}>JS scrollY</Text>
          <Text style={D.gaugeValue}>{scrollY.toFixed(1)}</Text>
        </View>
        <View style={D.gaugeRow}>
          <Text style={D.gaugeLabel}>C++ scrollY (polled 100ms)</Text>
          <Text style={[D.gaugeValue, D.gaugeAccent]}>{cppY.toFixed(1)}</Text>
        </View>
      </View>

      <ScrollView
        style={D.scroll}
        scrollEventThrottle={16}
        onScroll={e => {
          const y = e.nativeEvent.contentOffset.y;
          const x = e.nativeEvent.contentOffset.x;
          setScrollY(y);
          native.windowController.updateScrollPosition(y, x);
        }}
      >
        {Array.from({ length: DEMO_ITEM_COUNT }, (_, i) => (
          <View key={i} style={D.item}>
            <Text style={D.itemText}>Row {i}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function M2_2_ScrollBridge() {
  const results = runTests();
  return (
    <View style={{ flex: 1 }}>
      <TestScreen
        title="M2.2 — Scroll Bridge"
        subtitle="windowController JSI object · updateScrollPosition · getScrollPosition"
        results={results}
      />
      <LiveScrollDemo />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const D = StyleSheet.create({
  wrapper:      { backgroundColor: '#0a0a0a', padding: 16, paddingBottom: 24 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#fff', marginBottom: 2 },
  sectionSub:   { fontSize: 11, color: '#555', marginBottom: 12 },

  gauge:        { backgroundColor: '#111', borderRadius: 8, padding: 12, marginBottom: 12 },
  gaugeRow:     { flexDirection: 'row', justifyContent: 'space-between',
                  alignItems: 'center', marginBottom: 4 },
  gaugeLabel:   { fontSize: 12, color: '#888', fontFamily: 'Menlo' },
  gaugeValue:   { fontSize: 13, color: '#fff', fontFamily: 'Menlo' },
  gaugeAccent:  { color: '#4ade80' },

  scroll:       { height: 240, backgroundColor: '#0d0d0d', borderRadius: 8 },
  item:         { height: DEMO_ITEM_H, justifyContent: 'center',
                  paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  itemText:     { fontSize: 13, color: '#ccc', fontFamily: 'Menlo' },
});
