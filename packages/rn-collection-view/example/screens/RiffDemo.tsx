/**
 * Riff Demo — standalone showcase of all layout types.
 *
 * Each tab demos a specific layout engine with both vertical and horizontal
 * variants, decorations, mutations, and sticky headers where applicable.
 *
 * Tabs:
 *   List (V+H)    ← done
 *   Grid (V+H)    ← done
 *   Masonry (V+H) ← done
 *   Flow (V+H)    ← done
 */
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ListDemo, HorizontalListDemo, GridDemo, HorizontalGridDemo, MasonryDemo, HMasonryDemo, FlowDemo, HFlowDemo } from './comparison/LayoutsTab';

type DemoTab = 'list-v' | 'list-h' | 'grid-v' | 'grid-h' | 'masonry-v' | 'masonry-h' | 'flow-v' | 'flow-h';

const TABS: { key: DemoTab; label: string; detail: string }[] = [
  { key: 'list-v',    label: 'List ↕',    detail: 'Vertical · sections · decorations · mutations · sticky' },
  { key: 'list-h',    label: 'List ↔',    detail: 'Horizontal · sections · fixed-width cards' },
  { key: 'grid-v',    label: 'Grid ↕',    detail: 'Vertical grid · multi-section · sticky headers · section backgrounds · insert/delete · MVC' },
  { key: 'grid-h',    label: 'Grid ↔',    detail: 'Horizontal grid · columns=2 · section backgrounds · insert/delete · MVC' },
  { key: 'masonry-v', label: 'Masonry ↕', detail: 'Vertical masonry · 2 columns · shortest-lane · multi-section · sticky · section backgrounds · insert/delete · MVC' },
  { key: 'masonry-h', label: 'Masonry ↔', detail: 'Horizontal masonry · 3 lanes · adaptive container height · insert/delete · MVC' },
  { key: 'flow-v',    label: 'Flow ↕',    detail: 'Vertical flow · tag cloud · multi-section · two-pass · sticky · section backgrounds · insert/delete · MVC' },
  { key: 'flow-h',    label: 'Flow ↔',    detail: 'Horizontal flow · items pack top→bottom · fixed container height · multi-section · insert/delete' },
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
      </ScrollView>

      {/* Detail line */}
      <View style={S.detailBar}>
        <Text style={S.detailText}>{TABS.find(t => t.key === tab)?.detail}</Text>
      </View>

      {/* Content */}
      <View style={S.content}>
        {tab === 'list-v'    && <ListDemo />}
        {tab === 'list-h'    && <HorizontalListDemo />}
        {tab === 'grid-v'    && <GridDemo />}
        {tab === 'grid-h'    && <HorizontalGridDemo />}
        {tab === 'masonry-v' && <MasonryDemo />}
        {tab === 'masonry-h' && <HMasonryDemo />}
        {tab === 'flow-v'    && <FlowDemo />}
        {tab === 'flow-h'    && <HFlowDemo />}
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
