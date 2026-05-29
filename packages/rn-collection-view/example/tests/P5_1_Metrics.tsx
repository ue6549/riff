/**
 * P5.1 + P5.2 — Metric Collection + Debug HUD
 *
 * Acceptance criteria:
 *   · FPS overlay accurate to ±2 fps (CADisplayLink hardware timer)
 *   · Frame time displayed in ms, averaged over last 30 frames
 *   · Mounted cell count matches visible window size
 *   · Cold mount count increments on fast fling (cells enter render range unmeasured)
 *   · Scroll correction count increments when variable-height cells cause offset jumps
 *   · Blank area % > 0 during fast fling, ≈ 0 at rest
 *   · HUD overhead: FPS stable when toggling HUD on/off (no render-path impact)
 */
import React, { useState } from 'react';
import {
  Pressable,
  ScrollView as RNScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Riff } from '@riff/components/CollectionView';

// ── Dataset ───────────────────────────────────────────────────────────────────

const ITEM_COUNT = 500;

// Variable-height items so cold mounts + scroll corrections are observable.
const PARAGRAPHS = [
  'Short line.',
  'A medium-length sentence that wraps onto two lines in a typical mobile viewport.',
  'A longer paragraph with considerably more content. This will render taller than the others and exercise the scroll-correction path when it enters the viewport for the first time.',
  'Another medium entry to add height variety to the list.',
  'Brief.',
];

type Item = { id: number; text: string };

const DATA: Item[] = Array.from({ length: ITEM_COUNT }, (_, i) => ({
  id:   i,
  text: PARAGRAPHS[i % PARAGRAPHS.length]!,
}));

// ── Cell ──────────────────────────────────────────────────────────────────────

function MetricsCell({ item }: { item: Item }) {
  return (
    <View style={S.cell}>
      <Text style={S.cellId}>#{item.id}</Text>
      <Text style={S.cellText}>{item.text}</Text>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function P5_1_Metrics() {
  const [showHUD,      setShowHUD]      = useState(true);
  const [useEstimated, setUseEstimated] = useState(true);

  return (
    <View style={S.root}>
      {/* Controls */}
      <View style={S.controls}>
        <Pressable
          style={[S.btn, showHUD && S.btnActive]}
          onPress={() => setShowHUD(v => !v)}
        >
          <Text style={[S.btnText, showHUD && S.btnTextActive]}>
            HUD {showHUD ? 'ON' : 'OFF'}
          </Text>
        </Pressable>
        <Pressable
          style={[S.btn, useEstimated && S.btnActive]}
          onPress={() => setUseEstimated(v => !v)}
        >
          <Text style={[S.btnText, useEstimated && S.btnTextActive]}>
            {useEstimated ? 'Variable height' : 'Fixed height'}
          </Text>
        </Pressable>
      </View>

      {/* Hint */}
      <View style={S.hint}>
        <Text style={S.hintText}>
          {useEstimated
            ? 'Variable height · scroll fast → watch Cold + Blank area rise'
            : 'Fixed height · corrections = 0 · blank area = 0'}
        </Text>
      </View>

      {/* List */}
      <Riff
        data={DATA}
        keyExtractor={item => String(item.id)}
        renderItem={({ item }) => <MetricsCell item={item} />}
        {...(useEstimated
          ? { estimatedItemHeight: 60 }
          : { estimatedItemHeight: 72 })}
        itemSpacing={1}
        renderMultiplier={1.5}
        showHUD={showHUD}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  root:         { flex: 1, backgroundColor: '#0a0a0a' },

  controls:     { flexDirection: 'row', gap: 8, padding: 12 },
  btn:          { flex: 1, paddingVertical: 8, borderRadius: 8,
                  backgroundColor: '#1a1a1a', alignItems: 'center' },
  btnActive:    { backgroundColor: '#1e3a1e' },
  btnText:      { fontSize: 12, fontWeight: '600', color: '#555' },
  btnTextActive:{ color: '#4ade80' },

  hint:         { paddingHorizontal: 16, paddingBottom: 8 },
  hintText:     { fontSize: 11, color: '#4a5568' },

  cell:         { paddingHorizontal: 16, paddingVertical: 10,
                  backgroundColor: '#111', borderBottomWidth: 1,
                  borderBottomColor: '#1a1a1a' },
  cellId:       { fontSize: 10, color: '#4a5568', fontFamily: 'Menlo',
                  marginBottom: 2 },
  cellText:     { fontSize: 14, color: '#e2e8f0', lineHeight: 20 },
});
