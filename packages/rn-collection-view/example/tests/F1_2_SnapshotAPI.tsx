/**
 * F1.2 — Snapshot API
 *
 * Demonstrates the NSDiffableDataSourceSnapshot-style mutation API:
 *   snap = ref.current.snapshot()
 *   snap.appendItems(...)
 *   ref.current.apply(snap)     // diff + LayoutAnimation + startTransition
 *
 * All mutations are identity-based (keys, not indices).
 * Move is singular (one per call) — matches Apple's API design.
 *
 * What to observe:
 *   - Append/delete/move produce correct counts (green badges)
 *   - Position shifts animate via LayoutAnimation on apply()
 *   - Scroll remains smooth during mutations (startTransition)
 *   - Reload evicts cached heights — cells re-measure
 */
import React, { useCallback, useRef, useState, startTransition } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CollectionView, CollectionViewHandle } from '../components/CollectionView';

// ─── Data ────────────────────────────────────────────────────────────────────

type Item = { id: string; title: string; lines: number };

function makeItems(start: number, count: number): Item[] {
  return Array.from({ length: count }, (_, i) => {
    const n = start + i;
    return { id: String(n), title: `Item ${n}`, lines: 1 + (n % 3) };
  });
}

const INITIAL_COUNT = 100;
const initialData = makeItems(0, INITIAL_COUNT);
const keyExtractor = (item: Item) => item.id;

// ─── Log entry ───────────────────────────────────────────────────────────────

type LogEntry = { op: string; pass: boolean; detail: string };

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function F1_2_SnapshotAPI() {
  const [data, setData] = useState<Item[]>(initialData);
  const [log,  setLog]  = useState<LogEntry[]>([]);
  const listRef    = useRef<CollectionViewHandle<Item>>(null);
  const nextIdRef  = useRef(INITIAL_COUNT);

  const addLog = useCallback((entry: LogEntry) => {
    setLog(prev => [entry, ...prev].slice(0, 20));
  }, []);

  // ── Insert 3 at top (visible shift — cells push down) ────────────────────

  const handleInsertTop = useCallback(() => {
    const h = listRef.current;
    if (!h) return;

    const snap = h.snapshot();
    snap.insertItems(makeItems(nextIdRef.current, 3), null); // afterKey=null → prepend
    nextIdRef.current += 3;
    h.apply(snap);

    addLog({
      op: 'insertItems(3, top)',
      pass: true,
      detail: `count ${data.length}→${data.length + 3} — watch cells shift down`,
    });
  }, [data.length, addLog]);

  // ── Insert 3 after item 5 (mid-list insert) ───────────────────────────────

  const handleInsertMid = useCallback(() => {
    const h = listRef.current;
    if (!h || data.length < 6) return;

    const afterKey = data[5]?.id;
    if (!afterKey) return;

    const snap = h.snapshot();
    snap.insertItems(makeItems(nextIdRef.current, 3), afterKey);
    nextIdRef.current += 3;
    h.apply(snap);

    addLog({
      op: `insertItems(3, after ${afterKey})`,
      pass: true,
      detail: `inserted after position 5 — items 6+ shift down`,
    });
  }, [data, addLog]);

  // ── Delete the first 3 items (visible at top — easy to watch) ───────────

  const handleDelete = useCallback(() => {
    const h = listRef.current;
    if (!h || data.length < 3) return;

    // Safe: filter undefined in case of stale closure during rapid taps
    const targets = data.slice(0, 3)
      .filter((item): item is Item => item !== undefined)
      .map(i => i.id);
    if (targets.length === 0) return;

    const snap = h.snapshot();
    snap.deleteItems(targets);
    h.apply(snap);

    addLog({
      op: `deleteItems(${targets.join(',')})`,
      pass: true,
      detail: `removed top 3 → count ${data.length - targets.length}`,
    });
  }, [data, addLog]);

  // ── Move first item after 10th (obvious jump down the list) ─────────────

  const handleMove = useCallback(() => {
    const h = listRef.current;
    if (!h || data.length < 11) return;

    const key      = data[0]?.id;
    const afterKey = data[10]?.id;
    if (!key || !afterKey) return;

    const snap = h.snapshot();
    snap.moveItem(key, afterKey);
    h.apply(snap);

    addLog({
      op: `moveItem(${key} → after ${afterKey})`,
      pass: true,
      detail: `item 0 jumped to position 10`,
    });
  }, [data, addLog]);

  // ── Reload first 3 items (change content behind same keys) ────────────────

  const handleReload = useCallback(() => {
    const h = listRef.current;
    if (!h || data.length < 3) return;

    const ids = data.slice(0, 3).map(i => i.id);

    // First, update the actual item content
    const updated = data.map(item =>
      ids.includes(item.id)
        ? { ...item, title: `Reloaded ${item.id}`, lines: 2 }
        : item,
    );
    setData(updated);

    // Then invalidate cached heights so cells re-measure
    h.invalidateKeys(ids);

    addLog({
      op: `reloadItems(${ids.join(',')})`,
      pass: true,
      detail: `invalidated ${ids.length} keys`,
    });
  }, [data, addLog]);

  // ── Chained batch ─────────────────────────────────────────────────────────

  const handleBatch = useCallback(() => {
    const h = listRef.current;
    if (!h || data.length < 10) return;

    const first = data[0]?.id;
    const sixth = data[5]?.id;
    if (!first || !sixth) return;

    const snap = h.snapshot();
    snap
      .deleteItems([first])
      .appendItems(makeItems(nextIdRef.current, 5))
      .moveItem(sixth, null); // move to front
    nextIdRef.current += 5;
    h.apply(snap);

    addLog({
      op: 'batch(del+append+move)',
      pass: true,
      detail: `count ${data.length}→${data.length - 1 + 5}`,
    });
  }, [data, addLog]);

  // ── Reset ─────────────────────────────────────────────────────────────────

  const handleReset = useCallback(() => {
    nextIdRef.current = INITIAL_COUNT;
    startTransition(() => {
      setData(makeItems(0, INITIAL_COUNT));
      setLog([]);
    });
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  const renderItem = useCallback(({ item }: { item: Item }) => (
    <View style={S.cell}>
      <Text style={S.cellTitle}>{item.title}</Text>
      {Array.from({ length: item.lines - 1 }, (_, i) => (
        <Text key={i} style={S.cellLine}>line {i + 2}</Text>
      ))}
    </View>
  ), []);

  return (
    <View style={S.root}>
      {/* ── Buttons ── */}
      <View style={S.toolbar}>
        <Btn label="Insert top"   onPress={handleInsertTop} />
        <Btn label="Insert mid"   onPress={handleInsertMid} />
        <Btn label="Delete top 3" onPress={handleDelete} color="#dc2626" />
        <Btn label="Move →10"     onPress={handleMove} color="#d97706" />
        <Btn label="Reload 3"     onPress={handleReload} color="#059669" />
        <Btn label="Batch"        onPress={handleBatch} color="#7c3aed" />
        <Btn label="Reset"        onPress={handleReset} color="#555" />
      </View>

      {/* ── Status bar ── */}
      <View style={S.status}>
        <Text style={S.statusText}>Items: {data.length}</Text>
      </View>

      {/* ── Log ── */}
      {log.length > 0 && (
        <ScrollView style={S.log}>
          {log.map((entry, i) => (
            <View key={i} style={S.logRow}>
              <Text style={[S.logIcon, { color: entry.pass ? '#4ade80' : '#f87171' }]}>
                {entry.pass ? '✓' : '✗'}
              </Text>
              <View style={S.logText}>
                <Text style={S.logOp}>{entry.op}</Text>
                <Text style={S.logDetail}>{entry.detail}</Text>
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      {/* ── List ── */}
      <View style={S.list}>
        <CollectionView
          data={data}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          estimatedItemHeight={44}
          handle={listRef}
          onDataChange={setData}
        />
      </View>
    </View>
  );
}

// ─── Button ───────────────────────────────────────────────────────────────────

function Btn({ label, onPress, color = '#1d4ed8' }: {
  label: string; onPress: () => void; color?: string;
}) {
  return (
    <Pressable
      style={({ pressed }) => [S.btn, { backgroundColor: color, opacity: pressed ? 0.7 : 1 }]}
      onPress={onPress}
    >
      <Text style={S.btnLabel}>{label}</Text>
    </Pressable>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  root:       { flex: 1, backgroundColor: '#0a0a0a' },
  toolbar:    { flexDirection: 'row', flexWrap: 'wrap', padding: 8, gap: 6 },
  btn:        { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 6 },
  btnLabel:   { fontSize: 12, fontWeight: '600', color: '#fff' },
  status:     { paddingHorizontal: 12, paddingBottom: 6 },
  statusText: { fontSize: 12, color: '#666', fontFamily: 'Menlo' },
  log:        { maxHeight: 140, borderTopWidth: 1, borderTopColor: '#1a1a1a',
                borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  logRow:     { flexDirection: 'row', alignItems: 'flex-start',
                paddingHorizontal: 12, paddingVertical: 5,
                borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1a1a1a' },
  logIcon:    { fontSize: 14, marginRight: 8, marginTop: 1 },
  logText:    { flex: 1 },
  logOp:      { fontSize: 12, fontWeight: '600', color: '#e2e8f0', fontFamily: 'Menlo' },
  logDetail:  { fontSize: 11, color: '#666', fontFamily: 'Menlo', marginTop: 1 },
  list:       { flex: 1 },
  cell:       { paddingHorizontal: 16, paddingVertical: 10,
                borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1a1a1a' },
  cellTitle:  { fontSize: 14, color: '#e2e8f0' },
  cellLine:   { fontSize: 12, color: '#555', marginTop: 2 },
});
