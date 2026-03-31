/**
 * P4.1 — Memory Budget
 *
 * Acceptance criteria:
 *   · availableBytes() returns a plausible value (>0, <physical RAM)
 *   · pressureLevel() returns 0 at rest on a healthy device
 *   · simulate(2) fires the onPressure callback → memoryMultiplier halves →
 *       mounted cell count drops immediately
 *   · simulate(0) restores the budget
 *   · UIApplicationDidReceiveMemoryWarningNotification → onPressure(2) fires
 *       (testable via "Simulate Memory Warning" in Xcode Debug menu)
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Riff } from '../components/CollectionView';
import NativeCollectionViewModule from '../components/NativeCollectionViewModule';

// Access the JSI memory sub-object directly so we can read metrics + simulate.
const nativeMod = NativeCollectionViewModule as unknown as {
  memory: {
    availableBytes(): number;
    pressureLevel(): number;
    onPressure(cb: (level: number) => void): void;
    simulate(level: number): void;
  };
};

// ── Dataset ───────────────────────────────────────────────────────────────────

const ITEM_COUNT = 10_000;

type Item = { id: number };
const DATA: Item[] = Array.from({ length: ITEM_COUNT }, (_, i) => ({ id: i }));

// ── Component ─────────────────────────────────────────────────────────────────

export default function P4_1_MemoryBudget() {
  // Mounted window size passed to CollectionView — reduced on memory pressure
  // by the component itself (internal memoryMultiplier × this prop).
  const [baseMws, setBaseMws] = useState(5.0);

  // Live stats polled at ~2 Hz
  const [availMB,       setAvailMB]       = useState(0);
  const [pressureLevel, setPressureLevel] = useState(0);
  const [mountedCells,  setMountedCells]  = useState(0);
  const mountedRef = useRef(0);

  // Last pressure event received via onPressure callback
  const [lastEvent, setLastEvent] = useState<string>('—');

  // Poll memory stats
  useEffect(() => {
    const id = setInterval(() => {
      const bytes = nativeMod.memory.availableBytes();
      setAvailMB(Math.round(bytes / 1024 / 1024));
      setPressureLevel(nativeMod.memory.pressureLevel());
      setMountedCells(mountedRef.current);
    }, 500);
    return () => clearInterval(id);
  }, []);

  // Subscribe to pressure events (also fired by CollectionView internally,
  // but we wire a second listener here just to show the callback fires).
  useEffect(() => {
    nativeMod.memory.onPressure((level: number) => {
      const labels = ['Normal', 'Low', 'Critical'];
      setLastEvent(`${labels[level] ?? level} (${new Date().toLocaleTimeString()})`);
    });
  }, []);

  const LEVEL_COLOR = ['#4ade80', '#facc15', '#f87171'];
  const LEVEL_LABEL = ['Normal', 'Low', 'Critical'];

  return (
    <View style={S.root}>
      {/* ── Stats panel ─────────────────────────────────────────────────── */}
      <View style={S.statsPanel}>
        <Text style={S.panelTitle}>P4.1 — Memory Budget</Text>

        <View style={S.row}>
          <Text style={S.label}>Available memory</Text>
          <Text style={S.value}>{availMB} MB</Text>
        </View>

        <View style={S.row}>
          <Text style={S.label}>Pressure level</Text>
          <Text style={[S.value, { color: LEVEL_COLOR[pressureLevel] ?? '#fff' }]}>
            {pressureLevel} — {LEVEL_LABEL[pressureLevel] ?? '?'}
          </Text>
        </View>

        <View style={S.row}>
          <Text style={S.label}>Mounted cells</Text>
          <Text style={S.value}>{mountedCells}</Text>
        </View>

        <View style={S.row}>
          <Text style={S.label}>Base window size</Text>
          <Text style={S.value}>{baseMws}×</Text>
        </View>

        <View style={S.row}>
          <Text style={S.label}>Last pressure event</Text>
          <Text style={[S.value, S.small]}>{lastEvent}</Text>
        </View>
      </View>

      {/* ── Simulate buttons ──────────────────────────────────────────────── */}
      <View style={S.buttonRow}>
        <Pressable
          style={[S.btn, S.btnGreen]}
          onPress={() => nativeMod.memory.simulate(0)}
        >
          <Text style={S.btnText}>Simulate Normal</Text>
        </Pressable>
        <Pressable
          style={[S.btn, S.btnYellow]}
          onPress={() => nativeMod.memory.simulate(1)}
        >
          <Text style={S.btnText}>Simulate Low</Text>
        </Pressable>
        <Pressable
          style={[S.btn, S.btnRed]}
          onPress={() => nativeMod.memory.simulate(2)}
        >
          <Text style={S.btnText}>Simulate Critical</Text>
        </Pressable>
      </View>

      <View style={S.buttonRow}>
        <Pressable
          style={[S.btn, S.btnBlue]}
          onPress={() => setBaseMws(v => Math.max(1, v - 1))}
        >
          <Text style={S.btnText}>MWS −1</Text>
        </Pressable>
        <Pressable
          style={[S.btn, S.btnBlue]}
          onPress={() => setBaseMws(v => v + 1)}
        >
          <Text style={S.btnText}>MWS +1</Text>
        </Pressable>
      </View>

      <Text style={S.hint}>
        Tap "Simulate Critical" → mounted cells should drop ~50%.{'\n'}
        Tap "Simulate Normal" → budget restores to full.{'\n'}
        Also testable via Xcode → Debug → Simulate Memory Warning.
      </Text>

      {/* ── 10k item list ─────────────────────────────────────────────────── */}
      <View style={S.listWrapper}>
        <Riff
          data={DATA}
          itemHeight={44}
          mountedWindowSize={baseMws}
          onRenderCountChange={(n) => { mountedRef.current = n; }}
          renderItem={({ item }) => (
            <View style={S.cell}>
              <Text style={S.cellText}>Item {(item as Item).id}</Text>
            </View>
          )}
        />
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  root:       { flex: 1, backgroundColor: '#0a0a0a' },
  statsPanel: { margin: 12, padding: 12, backgroundColor: '#161616',
                borderRadius: 10, gap: 6 },
  panelTitle: { fontSize: 13, fontWeight: '700', color: '#fff',
                marginBottom: 4, letterSpacing: 0.5 },
  row:        { flexDirection: 'row', justifyContent: 'space-between',
                alignItems: 'center' },
  label:      { fontSize: 12, color: '#888' },
  value:      { fontSize: 12, fontWeight: '600', color: '#fff' },
  small:      { fontSize: 11 },

  buttonRow:  { flexDirection: 'row', gap: 8, marginHorizontal: 12,
                marginBottom: 8 },
  btn:        { flex: 1, paddingVertical: 8, borderRadius: 8,
                alignItems: 'center' },
  btnGreen:   { backgroundColor: '#166534' },
  btnYellow:  { backgroundColor: '#854d0e' },
  btnRed:     { backgroundColor: '#7f1d1d' },
  btnBlue:    { backgroundColor: '#1e3a5f' },
  btnText:    { fontSize: 12, fontWeight: '600', color: '#fff' },

  hint:       { fontSize: 11, color: '#555', marginHorizontal: 12,
                marginBottom: 8, lineHeight: 16 },

  listWrapper:{ flex: 1 },
  cell:       { height: 44, justifyContent: 'center', paddingHorizontal: 16,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: '#222' },
  cellText:   { fontSize: 13, color: '#ccc' },
});
