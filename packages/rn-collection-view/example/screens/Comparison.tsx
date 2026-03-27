/**
 * P6.1 — FlashList Comparison Demo
 *
 * 7 tabs, each isolating one differentiator:
 *   1. Prefetch — sub-tabs: simulated delay + real images (picsum 600×600)
 *   2. Sticky — push behavior + ms ticker + shimmer continuity
 *   3. Decorations — animated section backgrounds
 *   4. Layouts — all built-in layouts + FlashList parity callouts
 *   5. Perf — 4 scenarios × FPS/blank/mount metrics
 *   6. Resize — dynamic container resize reflow (3→2→1 cols vs fixed)
 *   7. State — like button state bleed
 *
 * Tabs 1–3, 5–7 toggle between CV and FlashList.
 * Tab 4 is CV-only (FlashList can't do these layouts).
 */
import React, { useCallback, useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';

import PrefetchTab    from './comparison/PrefetchTab';
import StickyTab      from './comparison/StickyTab';
import DecorationsTab from './comparison/DecorationsTab';
import LayoutsTab     from './comparison/LayoutsTab';
import PerfTab        from './comparison/PerfTab';
import ResizeTab      from './comparison/ResizeTab';
import StateTab       from './comparison/StateTab';
import SnapshotTab    from './comparison/SnapshotTab';

// ── Tab definitions ───────────────────────────────────────────────────────────

type TabId = 'prefetch' | 'sticky' | 'deco' | 'layouts' | 'perf' | 'resize' | 'state' | 'snapshot';

const TABS: { id: TabId; label: string; cvOnly?: boolean }[] = [
  { id: 'prefetch', label: 'Prefetch' },
  { id: 'sticky',   label: 'Sticky' },
  { id: 'deco',     label: 'Decor' },
  { id: 'layouts',  label: 'Layouts', cvOnly: true },
  { id: 'perf',     label: 'Perf' },
  { id: 'resize',   label: 'Resize' },
  { id: 'state',    label: 'State' },
  { id: 'snapshot', label: 'Snapshot', cvOnly: true },
];

type Engine = 'cv' | 'flash';

// ── Screen ────────────────────────────────────────────────────────────────────

export default function Comparison() {
  const [activeTab, setActiveTab] = useState<TabId>('prefetch');
  const [engine, setEngine]       = useState<Engine>('cv');

  const tab = TABS.find(t => t.id === activeTab)!;
  const isCvOnly = tab.cvOnly;

  const handleTabPress = useCallback((id: TabId) => {
    setActiveTab(id);
    const t = TABS.find(t => t.id === id)!;
    if (t.cvOnly) setEngine('cv');
  }, []);

  return (
    <SafeAreaView style={S.root}>
      {/* Tab bar */}
      <View style={S.tabBar}>
        {TABS.map(t => (
          <Pressable
            key={t.id}
            style={[S.tab, activeTab === t.id && S.tabActive]}
            onPress={() => handleTabPress(t.id)}
          >
            <Text style={[S.tabText, activeTab === t.id && S.tabTextActive]}>
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Engine toggle */}
      {!isCvOnly && (
        <View style={S.engineBar}>
          <Pressable
            style={[S.engineBtn, engine === 'cv' && S.engineBtnActive]}
            onPress={() => setEngine('cv')}
          >
            <Text style={[S.engineText, engine === 'cv' && S.engineTextActive]}>
              Riff
            </Text>
          </Pressable>
          <Pressable
            style={[S.engineBtn, engine === 'flash' && S.engineBtnFlash]}
            onPress={() => setEngine('flash')}
          >
            <Text style={[S.engineText, engine === 'flash' && S.engineTextFlash]}>
              FlashList
            </Text>
          </Pressable>
        </View>
      )}
      {isCvOnly && (
        <View style={S.engineBar}>
          <Text style={S.cvOnlyLabel}>
            {activeTab === 'snapshot'
              ? 'Riff only — FlashList has no snapshot API'
              : 'Riff only — impossible in FlashList'}
          </Text>
        </View>
      )}

      {/* Tab content */}
      <View style={S.content}>
        {activeTab === 'prefetch' && <PrefetchTab    mode={engine} />}
        {activeTab === 'sticky'   && <StickyTab      mode={engine} />}
        {activeTab === 'deco'     && <DecorationsTab mode={engine} />}
        {activeTab === 'layouts'  && <LayoutsTab />}
        {activeTab === 'perf'     && <PerfTab        mode={engine} />}
        {activeTab === 'resize'   && <ResizeTab      mode={engine} />}
        {activeTab === 'state'    && <StateTab       mode={engine} />}
        {activeTab === 'snapshot' && <SnapshotTab />}
      </View>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  root:           { flex: 1, backgroundColor: '#0a0a0a' },

  tabBar:         { flexDirection: 'row', paddingHorizontal: 6, paddingTop: 6,
                    paddingBottom: 2, gap: 4 },
  tab:            { flex: 1, paddingVertical: 6, borderRadius: 6,
                    backgroundColor: '#1a1a1a', alignItems: 'center' },
  tabActive:      { backgroundColor: '#1e3a1e' },
  tabText:        { fontSize: 10, fontWeight: '600', color: '#555' },
  tabTextActive:  { color: '#4ade80' },

  engineBar:      { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 6, gap: 8 },
  engineBtn:      { flex: 1, paddingVertical: 5, borderRadius: 6,
                    backgroundColor: '#1a1a1a', alignItems: 'center' },
  engineBtnActive:{ backgroundColor: '#1e3a1e' },
  engineBtnFlash: { backgroundColor: '#3a1e1e' },
  engineText:     { fontSize: 11, fontWeight: '600', color: '#555' },
  engineTextActive:{ color: '#4ade80' },
  engineTextFlash:{ color: '#f87171' },
  cvOnlyLabel:    { fontSize: 11, color: '#4a5568', fontStyle: 'italic' },

  content:        { flex: 1 },
});
