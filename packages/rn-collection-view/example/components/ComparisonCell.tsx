/**
 * ComparisonCell — complex cell used in the FlashList vs CollectionView comparison.
 *
 * Complexity intentional:
 *   - Colored "image" placeholder (identity-tied colour)
 *   - Username + body text (two lines)
 *   - Like button with LOCAL useState — NOT derived from props.
 *     This demonstrates FlashList's recycling artifact: when a cell is
 *     recycled and reused for a different item the like state from the
 *     previous item bleeds through until the new item re-renders.
 *   - Mount ID: a global counter incremented on every mount() call.
 *     Shows how many times cells have been created vs recycled.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

// ─── Global mount counter ─────────────────────────────────────────────────────

let _globalMountCount = 0;

export function resetMountCount() {
  _globalMountCount = 0;
}

export function getMountCount() {
  return _globalMountCount;
}

// ─── Data type ────────────────────────────────────────────────────────────────

export interface ComparisonItem {
  id:       number;
  username: string;
  body:     string;
  likes:    number;
  comments: number;
}

const BODIES = [
  'Building fast, identity-preserving collection views for React Native.',
  'FlashList recycles cells — great for memory, tricky for local state.',
  'Every cell mount increments the counter. Watch it grow with recycling.',
  'No recycling means no state bleed. Component identity === item identity.',
  'Smooth scrolling, accurate virtualization, zero recycling artifacts.',
  'The render window keeps nearby items live. Activity suspends the rest.',
  'C++ layout engine computes 10 000 items in under a millisecond.',
  'Spatial index makes getAttributesInRect a bucket lookup, not a scan.',
];

export function makeComparisonData(count: number): ComparisonItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id:       i,
    username: `user_${i}`,
    body:     BODIES[i % BODIES.length]!,
    likes:    (i * 37) % 200,
    comments: (i * 13) % 50,
  }));
}

// ─── Palette ──────────────────────────────────────────────────────────────────

const PALETTE = [
  '#e63946', '#2a9d8f', '#e9c46a', '#f4a261',
  '#264653', '#457b9d', '#6a4c93', '#1982c4',
];

// ─── Cell ─────────────────────────────────────────────────────────────────────

export function ComparisonCell({ item }: { item: ComparisonItem }) {
  // LOCAL like state — intentionally not synced from props.
  // FlashList will recycle this cell, carrying the old liked state
  // to a different item. CollectionView never recycles, so this is always fresh.
  const [liked, setLiked] = useState(false);

  // Mount ID: stamped once at mount time, never updated.
  const mountId = useRef<number>(0);
  useEffect(() => {
    _globalMountCount++;
    mountId.current = _globalMountCount;
    // No cleanup — we want the count to grow monotonically.
  }, []);

  const color = PALETTE[item.id % PALETTE.length]!;

  return (
    <View style={S.cell}>
      {/* Image placeholder */}
      <View style={[S.avatar, { backgroundColor: color }]}>
        <Text style={S.avatarText}>{item.username.slice(0, 2).toUpperCase()}</Text>
      </View>

      <View style={S.body}>
        {/* Header row */}
        <View style={S.headerRow}>
          <Text style={S.username}>{item.username}</Text>
          <Text style={S.mountId}>#{mountId.current}</Text>
        </View>

        {/* Body text */}
        <Text style={S.bodyText} numberOfLines={2}>{item.body}</Text>

        {/* Action row */}
        <View style={S.actions}>
          <Pressable
            style={[S.likeBtn, liked && S.likeBtnActive]}
            onPress={() => setLiked(v => !v)}
          >
            <Text style={[S.likeBtnText, liked && S.likeBtnTextActive]}>
              {liked ? '♥' : '♡'} {item.likes + (liked ? 1 : 0)}
            </Text>
          </Pressable>

          <Text style={S.comments}>💬 {item.comments}</Text>
        </View>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  cell:         { flexDirection: 'row', padding: 12, backgroundColor: '#111',
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: '#222' },

  avatar:       { width: 44, height: 44, borderRadius: 22,
                  alignItems: 'center', justifyContent: 'center',
                  marginRight: 12, flexShrink: 0 },
  avatarText:   { fontSize: 14, fontWeight: '700', color: '#fff' },

  body:         { flex: 1 },

  headerRow:    { flexDirection: 'row', justifyContent: 'space-between',
                  alignItems: 'center', marginBottom: 3 },
  username:     { fontSize: 13, fontWeight: '600', color: '#e2e8f0' },
  mountId:      { fontSize: 10, color: '#4a5568', fontFamily: 'Menlo' },

  bodyText:     { fontSize: 12, color: '#94a3b8', lineHeight: 17,
                  marginBottom: 6 },

  actions:      { flexDirection: 'row', alignItems: 'center', gap: 16 },

  likeBtn:      { flexDirection: 'row', alignItems: 'center',
                  paddingHorizontal: 8, paddingVertical: 3,
                  borderRadius: 4, borderWidth: 1, borderColor: '#2d3748' },
  likeBtnActive:{ borderColor: '#e63946', backgroundColor: '#2d0a0f' },
  likeBtnText:  { fontSize: 11, color: '#718096' },
  likeBtnTextActive: { color: '#e63946' },

  comments:     { fontSize: 11, color: '#4a5568' },
});
