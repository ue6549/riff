/**
 * Tab — Snapshot API Comparison
 *
 * CollectionView: identity-based snapshot API. Insert/delete/move operations are
 *   recorded on a snapshot object, then applied in one batch → C++ diff + LayoutAnimation.
 *   Scroll position preserved. Only changed items re-rendered.
 *
 * FlashList: no snapshot API. Replace the data array prop entirely.
 *   LayoutAnimation works, but no identity tracking — everything re-renders.
 *   No insert-at / move semantics. Scroll position may jump.
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  LayoutAnimation,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Riff, RiffHandle } from '../../components/CollectionView';

// ── Data ──────────────────────────────────────────────────────────────────────

const COLORS = ['#e63946','#2a9d8f','#e9c46a','#f4a261','#264653','#457b9d','#6a4c93','#1982c4'];
const ITEM_H = 64;

type Item = { id: number; label: string; color: string };

let _nextId = 100;
function makeItem(id?: number): Item {
  const i = id ?? _nextId++;
  return { id: i, label: `Item ${i}`, color: COLORS[i % COLORS.length]! };
}

const INITIAL: Item[] = Array.from({ length: 20 }, (_, i) => makeItem(i));

// ── Diff log entry ────────────────────────────────────────────────────────────

type DiffEntry = { op: 'insert' | 'delete' | 'move'; count: number; ts: number };

// ── Item cell ─────────────────────────────────────────────────────────────────

const ItemCell = React.memo(({ item }: { item: Item }) => (
  <View style={[S.cell, { backgroundColor: item.color }]}>
    <Text style={S.cellText}>{item.label}</Text>
  </View>
));

// ── CV side ───────────────────────────────────────────────────────────────────

function CVSnapshot({ log }: { log: (e: DiffEntry) => void }) {
  const ref = useRef<RiffHandle<Item>>(null);
  const [data, setData] = useState<Item[]>(INITIAL);
  const ke = useCallback((item: Item) => String(item.id), []);

  const insert = useCallback(() => {
    const newItems = [makeItem(), makeItem(), makeItem()];
    const snap = ref.current!.snapshot();
    snap.insertItems(newItems, null); // prepend
    ref.current!.apply(snap);
    log({ op: 'insert', count: 3, ts: Date.now() });
  }, [log]);

  const deleteFn = useCallback(() => {
    if (data.length < 3) return;
    const keys = data.slice(0, 3).map(it => String(it.id));
    const snap = ref.current!.snapshot();
    snap.deleteItems(keys);
    ref.current!.apply(snap);
    log({ op: 'delete', count: 3, ts: Date.now() });
  }, [data, log]);

  const move = useCallback(() => {
    if (data.length < 4) return;
    const snap = ref.current!.snapshot();
    // Move item at index 0 to after index 3
    snap.moveItem(String(data[0]!.id), String(data[3]!.id));
    ref.current!.apply(snap);
    log({ op: 'move', count: 1, ts: Date.now() });
  }, [data, log]);

  return (
    <View style={S.col}>
      <View style={S.controls}>
        <Pressable style={S.btn} onPress={insert}><Text style={S.btnText}>+3 top</Text></Pressable>
        <Pressable style={S.btn} onPress={deleteFn}><Text style={S.btnText}>−3 top</Text></Pressable>
        <Pressable style={S.btn} onPress={move}><Text style={S.btnText}>move↓</Text></Pressable>
      </View>
      <Riff
        data={data}
        handle={ref}
        keyExtractor={ke}
        renderItem={({ item }) => <ItemCell item={item} />}
        itemHeight={ITEM_H}
        itemSpacing={2}
        onDataChange={setData}
      />
    </View>
  );
}

// ── FlashList side ────────────────────────────────────────────────────────────

function FlashSnapshot({ log }: { log: (e: DiffEntry) => void }) {
  const [data, setData] = useState<Item[]>(INITIAL);
  const ke = useCallback((item: Item) => String(item.id), []);

  const insert = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setData(prev => [makeItem(), makeItem(), makeItem(), ...prev]);
    log({ op: 'insert', count: 3, ts: Date.now() });
  }, [log]);

  const deleteFn = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setData(prev => prev.slice(3));
    log({ op: 'delete', count: 3, ts: Date.now() });
  }, [log]);

  const move = useCallback(() => {
    if (data.length < 4) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setData(prev => {
      const next = [...prev];
      const [item] = next.splice(0, 1);
      next.splice(3, 0, item!);
      return next;
    });
    log({ op: 'move', count: 1, ts: Date.now() });
  }, [data, log]);

  return (
    <View style={S.col}>
      <View style={S.controls}>
        <Pressable style={[S.btn, S.btnFlash]} onPress={insert}><Text style={S.btnText}>+3 top</Text></Pressable>
        <Pressable style={[S.btn, S.btnFlash]} onPress={deleteFn}><Text style={S.btnText}>−3 top</Text></Pressable>
        <Pressable style={[S.btn, S.btnFlash]} onPress={move}><Text style={S.btnText}>move↓</Text></Pressable>
      </View>
      <FlashList
        data={data}
        keyExtractor={ke}
        renderItem={({ item }) => <ItemCell item={item} />}
        estimatedItemSize={ITEM_H}
      />
    </View>
  );
}

// ── Tab ───────────────────────────────────────────────────────────────────────

export default function SnapshotTab() {
  const [log, setLog] = useState<DiffEntry[]>([]);

  const addLog = useCallback((e: DiffEntry) => {
    setLog(prev => [e, ...prev].slice(0, 12));
  }, []);

  const opLabel = (op: DiffEntry['op']) =>
    op === 'insert' ? '↓ insert' : op === 'delete' ? '✕ delete' : '⇅ move';
  const opColor = (op: DiffEntry['op']) =>
    op === 'insert' ? '#4ade80' : op === 'delete' ? '#f87171' : '#fcd34d';

  return (
    <View style={S.root}>
      {/* Callout */}
      <View style={S.callout}>
        <Text style={S.calloutGreen}>Riff: identity-based snapshot API — insert/delete/move with scroll preserved.</Text>
        <Text style={S.calloutAmber}>FlashList: no snapshot API — replace data array, no identity tracking.</Text>
        <Text style={S.calloutPending}>⏳ Cell animation on snapshot apply — pending (LayoutAnimation wired, per-cell spring in roadmap).</Text>
      </View>

      {/* Column headers */}
      <View style={S.headers}>
        <Text style={[S.colHeader, S.colHeaderCV]}>Riff</Text>
        <Text style={[S.colHeader, S.colHeaderFlash]}>FlashList</Text>
      </View>

      {/* Two lists side by side */}
      <View style={S.listsRow}>
        <CVSnapshot log={addLog} />
        <View style={S.divider} />
        <FlashSnapshot log={addLog} />
      </View>

      {/* Diff log */}
      <View style={S.logBox}>
        <Text style={S.logTitle}>Operation log</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={S.logScroll}>
          {log.map((e, i) => (
            <View key={i} style={[S.logPill, { borderColor: opColor(e.op) }]}>
              <Text style={[S.logPillText, { color: opColor(e.op) }]}>
                {opLabel(e.op)} ×{e.count}
              </Text>
            </View>
          ))}
          {log.length === 0 && (
            <Text style={S.logEmpty}>Tap buttons above to mutate the list</Text>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const S = StyleSheet.create({
  root: { flex: 1 },

  callout: { marginHorizontal: 8, marginTop: 6, gap: 3 },
  calloutGreen: { fontSize: 10, color: '#4ade80', backgroundColor: '#1a2a1a',
                  borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  calloutAmber: { fontSize: 10, color: '#fcd34d', backgroundColor: '#2a2510',
                  borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  calloutPending: { fontSize: 10, color: '#94a3b8', backgroundColor: '#1a1a2a',
                    borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },

  headers: { flexDirection: 'row', paddingHorizontal: 8, paddingTop: 6 },
  colHeader: { flex: 1, fontSize: 11, fontWeight: '700', textAlign: 'center' },
  colHeaderCV: { color: '#4ade80' },
  colHeaderFlash: { color: '#f87171' },

  listsRow: { flex: 1, flexDirection: 'row' },
  col: { flex: 1 },
  divider: { width: 1, backgroundColor: '#222' },

  controls: { flexDirection: 'row', gap: 4, padding: 4 },
  btn: { flex: 1, paddingVertical: 5, borderRadius: 6, backgroundColor: '#1e3a1e',
         alignItems: 'center' },
  btnFlash: { backgroundColor: '#3a1a1a' },
  btnText: { fontSize: 10, fontWeight: '700', color: '#ccc' },

  cell: { height: ITEM_H, marginHorizontal: 4, borderRadius: 8,
          justifyContent: 'center', paddingHorizontal: 12 },
  cellText: { fontSize: 13, fontWeight: '600', color: '#fff' },

  logBox: { borderTopWidth: 1, borderTopColor: '#1a1a1a', paddingVertical: 6 },
  logTitle: { fontSize: 9, color: '#444', paddingHorizontal: 10,
              marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.8 },
  logScroll: { paddingHorizontal: 8, gap: 6 },
  logPill: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3 },
  logPillText: { fontSize: 11, fontWeight: '600' },
  logEmpty: { fontSize: 11, color: '#333', fontStyle: 'italic' },
});
