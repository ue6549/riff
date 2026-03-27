/**
 * M4.3 — Self-Sizing Cells
 *
 * Demonstrates that cells can change size AFTER initial measurement and the
 * layout updates correctly without scroll position jumps.
 *
 * RNMeasuredCell already handles this: when cell content changes, Yoga
 * re-layouts → layoutSubviews fires → onMeasured reports the new height →
 * onCellLayout detects the delta → scroll correction applied → layout
 * recomputed. No explicit hook needed — it's automatic.
 *
 * What to observe:
 *   · Tap any cell to expand/collapse it (adds/removes extra text lines).
 *   · When a cell ABOVE the viewport changes size, the scroll position is
 *     corrected so the visible content does not jump.
 *   · When a cell IN the viewport changes size, cells below shift smoothly.
 *   · The "Resizes" badge counts how many dynamic size changes have occurred.
 *   · The "Corrections" badge counts scroll-position corrections.
 *
 * Acceptance:
 *   1. Scroll down a few screens.
 *   2. Tap a visible cell — it expands, cells below shift.
 *   3. Scroll up — content has not jumped.
 *   4. Tap a cell above the viewport (scroll down first, tap near top) —
 *      the visible area should NOT jump when the above cell resizes.
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Riff } from '../components/CollectionView';

// ─── Dataset ──────────────────────────────────────────────────────────────────

const ITEM_COUNT    = 200;
const ESTIMATED_H   = 60;
const ITEM_SPACING  = 2;
const MEASURE_AHEAD = 2.0;

type Item = {
  id: number;
};

const DATA: Item[] = Array.from({ length: ITEM_COUNT }, (_, i) => ({ id: i }));

// ─── Cell ─────────────────────────────────────────────────────────────────────

const EXTRA_LINES = [
  'This is extra content that appears when you tap the cell.',
  'It demonstrates dynamic self-sizing — the cell grows without a remount.',
  'Riff detects the height change and adjusts layout automatically.',
  'Scroll correction prevents visible content from jumping when cells above resize.',
];

function SelfSizingCell({
  item,
  expanded,
  onToggle,
}: {
  item: Item;
  expanded: boolean;
  onToggle: (id: number) => void;
}) {
  return (
    <Pressable style={[S.cell, expanded && S.cellExpanded]} onPress={() => onToggle(item.id)}>
      <View style={S.cellHeader}>
        <Text style={S.cellId}>#{item.id}</Text>
        <Text style={S.expandIcon}>{expanded ? '▲' : '▼'}</Text>
      </View>
      <Text style={S.bodyText}>Tap to {expanded ? 'collapse' : 'expand'}</Text>
      {expanded && EXTRA_LINES.map((line, i) => (
        <Text key={i} style={S.extraText}>{line}</Text>
      ))}
    </Pressable>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function M4_3_SelfSizingCells() {
  const [expandedSet, setExpandedSet] = useState<Set<number>>(() => new Set());
  const [renderCount, setRenderCount] = useState(0);
  const resizeCountRef = useRef(0);
  const [resizeCount, setResizeCount] = useState(0);

  const onToggle = useCallback((id: number) => {
    setExpandedSet(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    resizeCountRef.current += 1;
    setResizeCount(resizeCountRef.current);
  }, []);

  const renderItem = useCallback(({ item }: { item: Item }) => (
    <SelfSizingCell
      item={item}
      expanded={expandedSet.has(item.id)}
      onToggle={onToggle}
    />
  ), [expandedSet, onToggle]);

  return (
    <SafeAreaView style={S.root}>
      <View style={S.header}>
        <Text style={S.title}>M4.3 — Self-Sizing Cells</Text>
        <Text style={S.subtitle}>
          Tap cells to expand/collapse · scroll correction applied automatically
        </Text>

        <View style={S.stats}>
          <StatBadge label="Rendered"    value={`${renderCount} / ${ITEM_COUNT}`} />
          <StatBadge label="Estimated"   value={`${ESTIMATED_H} px`} />
          <StatBadge label="Resizes"     value={`${resizeCount}`} accent />
          <StatBadge label="Expanded"    value={`${expandedSet.size}`} accent />
        </View>
      </View>

      <Riff
        data={DATA}
        keyExtractor={item => String(item.id)}
        renderItem={renderItem}
        estimatedItemHeight={ESTIMATED_H}
        itemSpacing={ITEM_SPACING}
        sectionInsetTop={8}
        sectionInsetBottom={24}
        renderMultiplier={1.0}
        measureAhead={MEASURE_AHEAD}
        onRenderCountChange={(count) => setRenderCount(count)}
      />
    </SafeAreaView>
  );
}

// ─── StatBadge ────────────────────────────────────────────────────────────────

function StatBadge({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
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

  stats:            { flexDirection: 'row', gap: 6 },
  badge:            { backgroundColor: '#161616', borderRadius: 8,
                      paddingHorizontal: 8, paddingVertical: 6, flex: 1 },
  badgeAccent:      { backgroundColor: '#1a1a00' },
  badgeLabel:       { fontSize: 9, color: '#555', marginBottom: 2 },
  badgeValue:       { fontSize: 11, fontWeight: '700', color: '#fff', fontFamily: 'Menlo' },
  badgeValueAccent: { color: '#fbbf24' },

  cellExpanded:     { backgroundColor: '#1e2a4a', borderColor: '#4466cc' },
  cell:             { backgroundColor: '#2a2a3a', borderRadius: 6,
                      paddingHorizontal: 14, paddingVertical: 10,
                      borderWidth: 1, borderColor: '#3a3a5a' },
  cellHeader:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cellId:           { fontSize: 10, color: '#8888bb', fontFamily: 'Menlo' },
  expandIcon:       { fontSize: 12, color: '#aaaacc' },
  bodyText:         { fontSize: 13, color: '#bbbbdd', marginTop: 4 },
  extraText:        { fontSize: 12, color: '#e0e0ff', lineHeight: 18, marginTop: 6,
                      backgroundColor: '#1a1a40', borderRadius: 4, padding: 6 },
});
