/**
 * Riff Demo — standalone showcase of all layout types.
 *
 * Each tab demos a specific layout engine with both vertical and horizontal
 * variants, decorations, mutations, and sticky headers where applicable.
 *
 * Tabs are added progressively as layouts are implemented:
 *   List (V+H)    ← both done
 *   Grid (V+H)    ← TODO
 *   Flow (align)  ← TODO
 *   Masonry (V+H) ← TODO
 */
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ListDemo, HorizontalListDemo } from './comparison/LayoutsTab';

type DemoTab = 'list-v' | 'list-h';

const TABS: { key: DemoTab; label: string; detail: string }[] = [
  { key: 'list-v', label: 'List ↕', detail: 'Vertical · sections · decorations · mutations · sticky' },
  { key: 'list-h', label: 'List ↔', detail: 'Horizontal · sections · fixed-width cards' },
];

export default function RiffDemo() {
  const [tab, setTab] = useState<DemoTab>('list-v');

  return (
    <View style={S.root}>
      {/* Tab bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={S.tabBarScroll}
        contentContainerStyle={S.tabBar}
      >
        {TABS.map(t => (
          <Pressable
            key={t.key}
            style={[S.tab, tab === t.key && S.tabActive]}
            onPress={() => setTab(t.key)}
          >
            <Text style={[S.tabLabel, tab === t.key && S.tabLabelActive]}>{t.label}</Text>
          </Pressable>
        ))}
        {/* Placeholder tabs — shown greyed out for roadmap visibility */}
        {(['Grid ↕', 'Grid ↔', 'Flow ↕', 'Flow ↔', 'Masonry ↕'] as const).map(label => (
          <View key={label} style={[S.tab, S.tabDisabled]}>
            <Text style={S.tabLabelDisabled}>{label}</Text>
          </View>
        ))}
      </ScrollView>

      {/* Detail line */}
      <View style={S.detailBar}>
        <Text style={S.detailText}>{TABS.find(t => t.key === tab)?.detail}</Text>
      </View>

      {/* Content */}
      <View style={S.content}>
        {tab === 'list-v' && <ListDemo />}
        {tab === 'list-h' && <HorizontalListDemo />}
      </View>
    </View>
  );
}

const S = StyleSheet.create({
  root:           { flex: 1, backgroundColor: '#0a0a0a' },

  tabBarScroll:   { flexGrow: 0, backgroundColor: '#111' },
  tabBar:         { flexDirection: 'row', paddingHorizontal: 10, paddingVertical: 8, gap: 6 },
  tab:            { paddingVertical: 7, paddingHorizontal: 16, borderRadius: 8,
                    backgroundColor: '#1a1a1a' },
  tabActive:      { backgroundColor: '#14532d' },
  tabDisabled:    { backgroundColor: '#111', opacity: 0.4 },
  tabLabel:       { fontSize: 12, fontWeight: '600', color: '#666' },
  tabLabelActive: { color: '#4ade80' },
  tabLabelDisabled: { fontSize: 12, fontWeight: '600', color: '#444' },

  detailBar:      { paddingHorizontal: 12, paddingVertical: 5, backgroundColor: '#0d0d0d',
                    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222' },
  detailText:     { fontSize: 11, color: '#444' },

  content:        { flex: 1 },
});
