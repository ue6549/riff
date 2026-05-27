/**
 * F1.2 — Snapshot API
 *
 * Demonstrates the NSDiffableDataSourceSnapshot-style mutation API:
 *   snap = ref.current.snapshot()
 *   snap.insertItemsAt(newItems, index)    // index-based insert
 *   snap.deleteItemsAt([0, 1, 2])          // index-based delete
 *   snap.moveItemFromTo(0, 10)             // index-based move
 *   ref.current.apply(snap, setData)       // diff + LayoutAnimation + startTransition
 *
 * Content changes (same key, new data) are handled automatically via
 * remeasureOnItemChange — no explicit invalidateKeys needed.
 *
 * What to observe:
 *   - Insert/delete/move produce correct counts and animate
 *   - Reload changes content + re-measures automatically (no manual invalidation)
 *   - scrollToIndex jumps to a specific position
 *   - Batch chains multiple ops in one apply()
 */
import React, { useCallback, useRef, useState, startTransition } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Riff, RiffHandle } from '@riff/components/CollectionView';

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

// remeasureOnItemChange predicate — re-measure only when line count changes
const shouldRemeasure = (prev: Item, next: Item) => prev.lines !== next.lines;

// ─── Log entry ───────────────────────────────────────────────────────────────

type LogEntry = { op: string; pass: boolean; detail: string };

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function F1_2_SnapshotAPI() {
  const [data, setData] = useState<Item[]>(initialData);
  const [log,  setLog]  = useState<LogEntry[]>([]);
  const listRef   = useRef<RiffHandle<Item>>(null);
  const nextIdRef = useRef(INITIAL_COUNT);

  const addLog = useCallback((entry: LogEntry) => {
    setLog(prev => [entry, ...prev].slice(0, 20));
  }, []);

  // ── Insert 3 at index 0 (prepend — cells push down) ──────────────────────

  const handleInsertTop = useCallback(() => {
    const h = listRef.current;
    if (!h) return;
    const newItems = makeItems(nextIdRef.current, 3);
    nextIdRef.current += 3;
    const snap = h.snapshot();
    snap.insertItemsAt(newItems, 0);          // index 0 = prepend
    h.apply(snap, setData);

    addLog({
      op: 'insertItemsAt(3, index:0)',
      pass: true,
      detail: `count ${data.length}→${data.length + 3} — watch cells shift down`,
    });
  }, [data.length, addLog]);

  // ── Insert 3 at index 6 (after position 5) ───────────────────────────────

  const handleInsertMid = useCallback(() => {
    const h = listRef.current;
    if (!h || data.length < 6) return;
    const newItems = makeItems(nextIdRef.current, 3);
    nextIdRef.current += 3;
    const snap = h.snapshot();
    snap.insertItemsAt(newItems, 6);          // ends up at indices 6,7,8
    h.apply(snap, setData);

    addLog({
      op: 'insertItemsAt(3, index:6)',
      pass: true,
      detail: `inserted after position 5 — items 6+ shift down`,
    });
  }, [data.length, addLog]);

  // ── Delete indices 0,1,2 (top 3) ─────────────────────────────────────────

  const handleDelete = useCallback(() => {
    const h = listRef.current;
    if (!h || data.length < 3) return;
    const snap = h.snapshot();
    snap.deleteItemsAt([0, 1, 2]);
    h.apply(snap, setData);

    addLog({
      op: 'deleteItemsAt([0,1,2])',
      pass: true,
      detail: `removed top 3 → count ${data.length - 3}`,
    });
  }, [data.length, addLog]);

  // ── Move index 0 to index 10 (obvious jump) ───────────────────────────────

  const handleMove = useCallback(() => {
    const h = listRef.current;
    if (!h || data.length < 11) return;
    const snap = h.snapshot();
    snap.moveItemFromTo(0, 10);
    h.apply(snap, setData);

    addLog({
      op: 'moveItemFromTo(0 → 10)',
      pass: true,
      detail: `item 0 jumped to position 10`,
    });
  }, [data.length, addLog]);

  // ── Reload first 3 items — content change, auto re-measure ───────────────
  //
  // No explicit invalidateKeys needed: remeasureOnItemChange detects that
  // lines changed and evicts the cache automatically on the next render.

  const handleReload = useCallback(() => {
    if (data.length < 3) return;
    const ids = new Set([data[0]!.id, data[1]!.id, data[2]!.id]);
    setData(prev => prev.map(item =>
      ids.has(item.id)
        ? { ...item, title: `Reloaded ${item.id}`, lines: item.lines === 1 ? 3 : 1 }
        : item,
    ));

    addLog({
      op: 'reload(top 3) — via remeasureOnItemChange',
      pass: true,
      detail: `toggled lines 1↔3 — auto-invalidates height cache`,
    });
  }, [data]);

  // ── Scroll to index 50 ────────────────────────────────────────────────────

  const handleScrollTo = useCallback(() => {
    listRef.current?.scrollToIndex(50, { position: 'top', animated: true });
    addLog({ op: 'scrollToIndex(50)', pass: true, detail: 'scroll to index 50' });
  }, [addLog]);

  // ── Chained batch: deleteAt(0) + append(5) + moveFromTo(5→0) ─────────────

  const handleBatch = useCallback(() => {
    const h = listRef.current;
    if (!h || data.length < 10) return;
    const newItems = makeItems(nextIdRef.current, 5);
    nextIdRef.current += 5;
    const snap = h.snapshot();
    snap
      .deleteItemsAt([0])
      .appendItems(newItems)
      .moveItemFromTo(5, 0);              // move original index-5 item to front
    h.apply(snap, setData);

    addLog({
      op: 'batch(delAt(0)+append(5)+moveFromTo(5→0))',
      pass: true,
      detail: `count ${data.length}→${data.length - 1 + 5}`,
    });
  }, [data.length, addLog]);

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
        <Btn label="Insert top"     onPress={handleInsertTop} />
        <Btn label="Insert mid"     onPress={handleInsertMid} />
        <Btn label="Delete top 3"   onPress={handleDelete}   color="#dc2626" />
        <Btn label="Move 0→10"      onPress={handleMove}     color="#d97706" />
        <Btn label="Reload 3"       onPress={handleReload}   color="#059669" />
        <Btn label="Scroll→50"      onPress={handleScrollTo} color="#0891b2" />
        <Btn label="Batch"          onPress={handleBatch}    color="#7c3aed" />
        <Btn label="Reset"          onPress={handleReset}    color="#555" />
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
        <Riff
          data={data}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          estimatedItemHeight={44}
          remeasureOnItemChange={shouldRemeasure}
          ref={listRef}
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
