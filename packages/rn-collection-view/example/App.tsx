/**
 * RNCollectionView — Example App
 *
 * A persistent menu of all milestone acceptance tests and demo screens.
 * Demos are at the top; milestone tests are grouped by phase below.
 *
 * To add a new screen:
 *   1. Import it above the SCREENS array
 *   2. Push a new entry into SCREENS
 * Nothing is ever removed — every test remains runnable on any device.
 */
import React, { useState } from 'react';
import {
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

// ── Demos ─────────────────────────────────────────────────────────────────────
import CollectionViewDemo from './screens/CollectionViewDemo';
import Comparison         from './screens/Comparison';

// ── Phase 1 — Layout Engine ───────────────────────────────────────────────────
import M1_1_LayoutCache           from './tests/M1_1_LayoutCache';
import M1_2_ListLayoutFixed       from './tests/M1_2_ListLayoutFixed';
import M1_3_ListLayoutEstimated   from './tests/M1_3_ListLayoutEstimated';
import M1_4_SpatialIndex          from './tests/M1_4_SpatialIndex';
import M1_5_ListLayoutMultiSection from './tests/M1_5_ListLayoutMultiSection';

// ── Phase 2 — Scroll + Window ────────────────────────────────────────────────
import M2_2_ScrollBridge      from './tests/M2_2_ScrollBridge';
import M2_4_WindowController  from './tests/M2_4_WindowController';

// ── Phase 4 — Sizing Strategies ──────────────────────────────────────────────
import M4_1_EstimatedSizing   from './tests/M4_1_EstimatedSizing';
import M4_3_SelfSizingCells   from './tests/M4_3_SelfSizingCells';

// ── Phase 3 — Virtualization ──────────────────────────────────────────────────
import M3_3_ColdEviction      from './tests/M3_3_ColdEviction';
import M3_4_VelocityWindow    from './tests/M3_4_VelocityWindow';
import M3_5_CellBudget        from './tests/M3_5_CellBudget';

// ── Performance — C++ Window Controller ──────────────────────────────────────
import P1_1_CppWindowController from './tests/P1_1_CppWindowController';

// ── Performance — Metrics + HUD ───────────────────────────────────────────────
import P5_1_Metrics from './tests/P5_1_Metrics';

// ── Phase F1 — Data Layer ─────────────────────────────────────────────────────
import F1_1_DiffEngine        from './tests/F1_1_DiffEngine';
import F1_2_SnapshotAPI       from './tests/F1_2_SnapshotAPI';
import F1_3_PrefetchCallbacks from './tests/F1_3_PrefetchCallbacks';

// ── Phase F2 — Supplementary Views & Sticky Headers ──────────────────────────
import F2_1_SupplementaryViews from './tests/F2_1_SupplementaryViews';
import F2_2_StickyHeaders      from './tests/F2_2_StickyHeaders';
import F2_3_StickyPush         from './tests/F2_3_StickyPush';
import F2_4_DecorationViews    from './tests/F2_4_DecorationViews';

// ─── Screen registry ──────────────────────────────────────────────────────────

type ScreenEntry = {
  key:       string;
  label:     string;
  detail:    string;
  group:     string;
  isDemo?:   boolean;
  component: React.ComponentType;
};

const SCREENS: ScreenEntry[] = [
  // ── Demos (interactive, always at top) ───────────────────────────────────
  {
    key:       'demo_cv',
    label:     'CollectionView Demo',
    detail:    '200 items · fixed height · C++ layout cache · non-virtualized',
    group:     'Demos',
    isDemo:    true,
    component:  CollectionViewDemo,
  },
  {
    key:       'demo_comparison',
    label:     'FlashList Comparison',
    detail:    '500 items · CollectionView vs FlashList vs FlatList · like state · mount counter',
    group:     'Demos',
    isDemo:    true,
    component:  Comparison,
  },

  // ── Phase 1: Layout Engine ────────────────────────────────────────────────
  {
    key:       'M1_1',
    label:     'M1.1 — LayoutCache',
    detail:    'CRUD · version · getAll · getTotalContentSize · getSectionOffsets',
    group:     'Phase 1 — Layout Engine (C++)',
    component:  M1_1_LayoutCache,
  },
  {
    key:       'M1_2',
    label:     'M1.2 — ListLayout: fixed height',
    detail:    '1 000 items · item positions · width · sizingState',
    group:     'Phase 1 — Layout Engine (C++)',
    component:  M1_2_ListLayoutFixed,
  },
  {
    key:       'M1_3',
    label:     'M1.3 — ListLayout: estimated + invalidation',
    detail:    'Variable heights · cumulative Y · invalidateFrom pivot',
    group:     'Phase 1 — Layout Engine (C++)',
    component:  M1_3_ListLayoutEstimated,
  },
  {
    key:       'M1_4',
    label:     'M1.4 — SpatialIndex',
    detail:    'getAttributesInRect · no false +/− · 100-iter perf',
    group:     'Phase 1 — Layout Engine (C++)',
    component:  M1_4_SpatialIndex,
  },
  {
    key:       'M1_5',
    label:     'M1.5 — ListLayout: multi-section',
    detail:    '10 sections × 1 000 items · headers · footers · invalidation',
    group:     'Phase 1 — Layout Engine (C++)',
    component:  M1_5_ListLayoutMultiSection,
  },

  // ── Phase 2: Scroll Bridge ────────────────────────────────────────────────
  {
    key:       'M2_2',
    label:     'M2.2 — Scroll Bridge',
    detail:    'windowController · updateScrollPosition · getScrollPosition · live demo',
    group:     'Phase 2 — Scroll + Window (C++)',
    component:  M2_2_ScrollBridge,
  },
  {
    key:       'M2_4',
    label:     'M2.4 — Window Controller',
    detail:    'getWindowState · visible/render tiers · geometry correctness · perf',
    group:     'Phase 2 — Scroll + Window (C++)',
    component:  M2_4_WindowController,
  },

  // ── Phase 4: Sizing Strategies ───────────────────────────────────────────
  {
    key:       'M4_1',
    label:     'M4.1 — Estimated Sizing',
    detail:    '200 items · estimatedHeight=80px · actual 55/90/130px · scroll correction',
    group:     'Phase 4 — Sizing Strategies',
    component:  M4_1_EstimatedSizing,
  },
  {
    key:       'M4_3',
    label:     'M4.3 — Self-Sizing Cells',
    detail:    '200 items · tap to expand/collapse · dynamic resize · scroll correction',
    group:     'Phase 4 — Sizing Strategies',
    component:  M4_3_SelfSizingCells,
  },

  // ── Phase 3: Virtualization ───────────────────────────────────────────────
  {
    key:       'M3_3',
    label:     'M3.3 — Cold Eviction',
    detail:    'Cells unmount outside render window · remount at correct position · gen counter',
    group:     'Phase 3 — Virtualization',
    component:  M3_3_ColdEviction,
  },
  {
    key:       'M3_4',
    label:     'M3.4 — Velocity-Adaptive Window',
    detail:    '1 000 items · window expands toward direction of travel · fling test',
    group:     'Phase 3 — Virtualization',
    component:  M3_4_VelocityWindow,
  },
  {
    key:       'M3_5',
    label:     'M3.5 — Cell Budget',
    detail:    '500 items · mounted content capped in viewport multiples · gen counter',
    group:     'Phase 3 — Virtualization',
    component:  M3_5_CellBudget,
  },

  // ── Performance: C++ Window Controller ───────────────────────────────────
  {
    key:       'P1_1',
    label:     'P1.1 — C++ Window Controller',
    detail:    'Correctness tests · JS vs C++ parity · perf comparison · 500-item live demo',
    group:     'Performance — C++ Core',
    component:  P1_1_CppWindowController,
  },
  {
    key:       'P5_1',
    label:     'P5.1/5.2 — Metrics + HUD',
    detail:    'CADisplayLink FPS · frame time · cold mounts · corrections · blank area',
    group:     'Performance — C++ Core',
    component:  P5_1_Metrics,
  },

  // ── Phase F1: Data Layer ──────────────────────────────────────────────────
  {
    key:       'F1_1',
    label:     'F1.1 — Diff Engine',
    detail:    'C++ LIS diff · insert/delete/move · 10k perf < 2ms',
    group:     'Phase F1 — Data Layer',
    component:  F1_1_DiffEngine,
  },
  {
    key:       'F1_2',
    label:     'F1.2 — Snapshot API',
    detail:    'appendItems · deleteItems · moveItem · reloadItems · startTransition',
    group:     'Phase F1 — Data Layer',
    component:  F1_2_SnapshotAPI,
  },
  {
    key:       'F1_3',
    label:     'F1.3 — Prefetch callbacks',
    detail:    'onPrefetch · onEvict · 12× viewport ahead · cancel in-flight loads',
    group:     'Phase F1 — Data Layer',
    component:  F1_3_PrefetchCallbacks,
  },

  // ── Phase F2: Supplementary Views & Sticky Headers ───────────────────────
  {
    key:       'F2_1',
    label:     'F2.1 — Supplementary views',
    detail:    '5 sections · headers + footers at correct Y · windowing',
    group:     'Phase F2 — Supplementary Views',
    component:  F2_1_SupplementaryViews,
  },
  {
    key:       'F2_2',
    label:     'F2.2 — Sticky headers',
    detail:    'Section header sticks at top · returns to natural position on scroll back',
    group:     'Phase F2 — Supplementary Views',
    component:  F2_2_StickyHeaders,
  },
  {
    key:       'F2_3',
    label:     'F2.3 — Sticky push',
    detail:    'Incoming header pushes current sticky up · UICollectionView parity',
    group:     'Phase F2 — Supplementary Views',
    component:  F2_3_StickyPush,
  },
  {
    key:       'F2_4',
    label:     'F2.4 — Decoration views',
    detail:    'Per-section tinted backgrounds · behind cells · no touch interception',
    group:     'Phase F2 — Supplementary Views',
    component:  F2_4_DecorationViews,
  },
];

// ─── Menu ─────────────────────────────────────────────────────────────────────

function Menu({ onSelect }: { onSelect: (key: string) => void }) {
  const groups = [...new Set(SCREENS.map(s => s.group))];

  return (
    <SafeAreaView style={S.safe}>
      <ScrollView contentContainerStyle={S.menuContainer}>
        <Text style={S.appTitle}>RNCollectionView</Text>
        <Text style={S.appSubtitle}>
          {Platform.OS.toUpperCase()} · tap a screen to open it
        </Text>

        {groups.map(group => (
          <View key={group}>
            <Text style={S.groupHeader}>{group}</Text>
            {SCREENS.filter(s => s.group === group).map(s => (
              <Pressable
                key={s.key}
                style={({ pressed }) => [
                  S.row,
                  s.isDemo && S.rowDemo,
                  pressed && S.rowPressed,
                ]}
                onPress={() => onSelect(s.key)}
              >
                <View style={S.rowInner}>
                  <Text style={[S.rowLabel, s.isDemo && S.rowLabelDemo]}>
                    {s.label}
                  </Text>
                  <Text style={S.rowDetail}>{s.detail}</Text>
                </View>
                <Text style={S.rowChevron}>›</Text>
              </Pressable>
            ))}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [active, setActive] = useState<string | null>(null);

  if (active) {
    const entry = SCREENS.find(s => s.key === active);
    if (entry) {
      const Screen = entry.component;
      return (
        <SafeAreaView style={S.safe}>
          <Pressable style={S.backBar} onPress={() => setActive(null)}>
            <Text style={S.backChevron}>‹</Text>
            <Text style={S.backLabel}>Menu</Text>
          </Pressable>
          <Screen />
        </SafeAreaView>
      );
    }
  }

  return <Menu onSelect={setActive} />;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  safe:         { flex: 1, backgroundColor: '#0a0a0a' },

  menuContainer:{ padding: 24, paddingBottom: 40 },
  appTitle:     { fontSize: 22, fontWeight: '700', color: '#fff',
                  marginBottom: 4, marginTop: 8 },
  appSubtitle:  { fontSize: 12, color: '#555', marginBottom: 32 },

  groupHeader:  { fontSize: 11, fontWeight: '600', color: '#555',
                  letterSpacing: 0.8, textTransform: 'uppercase',
                  marginBottom: 8, marginTop: 8 },

  row:          { backgroundColor: '#161616', borderRadius: 10, marginBottom: 8,
                  flexDirection: 'row', alignItems: 'center', padding: 14 },
  rowDemo:      { backgroundColor: '#0d2137', borderWidth: 1,
                  borderColor: '#1a3a5c' },
  rowPressed:   { opacity: 0.6 },
  rowInner:     { flex: 1 },
  rowLabel:     { fontSize: 14, fontWeight: '600', color: '#fff', marginBottom: 2 },
  rowLabelDemo: { color: '#60a5fa' },
  rowDetail:    { fontSize: 11, color: '#555' },
  rowChevron:   { fontSize: 20, color: '#444', marginLeft: 8 },

  backBar:      { flexDirection: 'row', alignItems: 'center',
                  paddingHorizontal: 16, paddingVertical: 10,
                  borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  backChevron:  { fontSize: 22, color: '#4ade80', marginRight: 4 },
  backLabel:    { fontSize: 15, color: '#4ade80' },
});
