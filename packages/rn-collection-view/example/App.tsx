/**
 * RNCollectionView — Example App
 *
 * Three sections:
 *   1. Features & Comparison — salient points overview + FlashList comparison demo
 *   2. Coming Soon — upcoming roadmap items (non-interactive)
 *   3. Tests — all milestone acceptance tests grouped by phase
 *
 * To add a new screen:
 *   1. Import it below
 *   2. Push a new entry into SCREENS
 * Nothing is ever removed — every test remains runnable on any device.
 */
import React, { useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// ── Features ──────────────────────────────────────────────────────────────────
import SalientPoints  from './screens/SalientPoints';
import Comparison     from './screens/Comparison';
import RiffDemo       from './screens/RiffDemo';
import StorefrontDemo from './screens/StorefrontDemo';
import HomepageDemo from './screens/HomepageDemo';
import SearchResultsDemo from './screens/SearchResultsDemo';

// ── 0.80.2 Compatibility ──────────────────────────────────────────────────────
import V0_ActivityProbe from './tests/V0_ActivityProbe';

// ── Phase 1 — Layout Engine ───────────────────────────────────────────────────
import M1_1_LayoutCache            from './tests/M1_1_LayoutCache';
import M1_2_ListLayoutFixed        from './tests/M1_2_ListLayoutFixed';
import M1_3_ListLayoutEstimated    from './tests/M1_3_ListLayoutEstimated';
import M1_4_SpatialIndex           from './tests/M1_4_SpatialIndex';
import M1_5_ListLayoutMultiSection from './tests/M1_5_ListLayoutMultiSection';

// ── Phase 2 — Scroll + Window ────────────────────────────────────────────────
import M2_2_ScrollBridge     from './tests/M2_2_ScrollBridge';
import M2_4_WindowController from './tests/M2_4_WindowController';

// ── Phase 4 — Sizing Strategies ──────────────────────────────────────────────
import M4_1_EstimatedSizing  from './tests/M4_1_EstimatedSizing';
import M4_3_SelfSizingCells  from './tests/M4_3_SelfSizingCells';

// ── Phase 3 — Virtualization ──────────────────────────────────────────────────
import M3_3_ColdEviction     from './tests/M3_3_ColdEviction';
import M3_4_VelocityWindow   from './tests/M3_4_VelocityWindow';
import M3_5_CellBudget       from './tests/M3_5_CellBudget';

// ── Performance ───────────────────────────────────────────────────────────────
import P1_1_CppWindowController from './tests/P1_1_CppWindowController';
import P4_1_MemoryBudget        from './tests/P4_1_MemoryBudget';
import P5_1_Metrics             from './tests/P5_1_Metrics';

// ── Phase F1 — Data Layer ─────────────────────────────────────────────────────
import F1_1_DiffEngine        from './tests/F1_1_DiffEngine';
import F1_2_SnapshotAPI       from './tests/F1_2_SnapshotAPI';
import F1_3_PrefetchCallbacks from './tests/F1_3_PrefetchCallbacks';

// ── R1.3: Layout Protocol ────────────────────────────────────────────────────
import R1_3_LayoutProtocol from './tests/R1_3_LayoutProtocol';

// ── Phase F2 — Supplementary Views & Sticky Headers ──────────────────────────
import F2_1_SupplementaryViews from './tests/F2_1_SupplementaryViews';
import F2_2_StickyHeaders      from './tests/F2_2_StickyHeaders';
import F2_3_StickyPush         from './tests/F2_3_StickyPush';
import F2_4_DecorationViews    from './tests/F2_4_DecorationViews';

// ── ShadowNode ──────────────────────────────────────────────────────────────
import SN_Phase1_Skeleton      from './tests/SN_Phase1_Skeleton';
import SN_Phase3_LayoutOverride from './tests/SN_Phase3_LayoutOverride';
import SN_Phase3b_ContentMeasured from './tests/SN_Phase3b_ContentMeasured';
import SN_Phase4_ScrollCorrection from './tests/SN_Phase4_ScrollCorrection';
import SN_Phase5_LayoutCacheBridge from './tests/SN_Phase5_LayoutCacheBridge';

// ─── Screen registry ──────────────────────────────────────────────────────────

type ScreenEntry = {
  key:       string;
  label:     string;
  detail:    string;
  group:     string;
  component: React.ComponentType<any>;
};

// ─── Coming Soon items (non-navigable) ────────────────────────────────────────

type ComingSoonItem = { label: string; detail: string };

const COMING_SOON: ComingSoonItem[] = [
  { label: 'P6.2 — Device Benchmarks',        detail: 'Instruments profiling · iPhone 15 Pro + 12 · release build · blank area / FPS / RSS' },
  { label: 'F1.2b — Cell Enter/Exit Animations', detail: 'Fade + collapse on delete · fade + expand on insert · interruptible spring physics' },
  // { label: 'F3.3 — CompositionalLayout',      detail: 'Mixed layouts per section — list + grid + masonry in a single scroll container' },
  // { label: 'F3.4 — Orthogonal Scrolling',     detail: 'App Store–style horizontal rows inside a vertical list · own window controller per row' },
  { label: 'F4.x — State Persistence',        detail: 'FlatBuffers layout cache · MMKV scroll position · restore before first frame' },
  { label: 'F5.1 — Android',                  detail: 'CMakeLists wired to existing cpp/ · TurboModule in Kotlin · zero C++ duplication' },
  { label: 'F5.2 — React Native Web',         detail: 'JS-only layout fallbacks · IntersectionObserver windowing · same TS component API' },
  { label: 'R1.4 — TS→C++ Layout Codegen',    detail: 'Build-time AST transform: pure TS compute() → generated C++ · zero manual C++ for custom layouts' },
  { label: 'R1.1 — UICollectionView Host',    detail: 'Decouple JS identity from UIView allocation · RC pool of ~20 shells · reparent Fabric views' },
  { label: 'DOC.1 — Solution Document',       detail: 'HLD + LLD + all optimisations + design decisions + benchmark results' },
];

const SCREENS: ScreenEntry[] = [
  // ── Features ─────────────────────────────────────────────────────────────
  {
    key: 'salient', label: 'Architecture & Key Decisions',
    detail: 'Design decisions · CV vs FlashList · TS+C++→Codegen story',
    group: 'Features & Comparison',
    component: SalientPoints,
  },
  {
    key: 'demo_comparison', label: 'FlashList Comparison',
    detail: '8 tabs · Prefetch / Sticky / Decor / Layouts / Perf / Resize / State / Snapshot',
    group: 'Features & Comparison',
    component: Comparison,
  },
  {
    key: 'riff_demo', label: 'Riff Demo',
    detail: 'List · Grid · Masonry · Flow · all orientations & features',
    group: 'Features & Comparison',
    component: RiffDemo,
  },
  {
    key: 'storefront', label: 'Storefront Demo',
    detail: 'App Store–style page · compositional H+V sections · single scroll',
    group: 'Features & Comparison',
    component: StorefrontDemo,
  },
  {
    key: 'homepage', label: 'Homepage Demo',
    detail: 'Flipkart/Amazon homepage · categories · banners · deals · reco masonry',
    group: 'Features & Comparison',
    component: HomepageDemo,
  },
  {
    key: 'search_results', label: 'Search Results Demo',
    detail: '150-card search page · 2-col grid · banner carousels · H product lists',
    group: 'Features & Comparison',
    component: SearchResultsDemo,
  },

  // ── 0.80.2 Compatibility ──────────────────────────────────────────────────
  { key: 'V0', label: 'Activity Probe — 0.80.2 compat',
    detail: 'Confirms hidden Activity still lays out (Yoga measures) + suspends effects on RN 0.80.2 / React 19.1',
    group: 'Tests — 0.80.2 Compatibility', component: V0_ActivityProbe },

  // ── Phase 1: Layout Engine ────────────────────────────────────────────────
  { key: 'M1_1', label: 'M1.1 — LayoutCache',
    detail: 'CRUD · version · getAll · getTotalContentSize · getSectionOffsets',
    group: 'Tests — Phase 1: Layout Engine (C++)', component: M1_1_LayoutCache },
  { key: 'M1_2', label: 'M1.2 — ListLayout: fixed height',
    detail: '1 000 items · item positions · width · sizingState',
    group: 'Tests — Phase 1: Layout Engine (C++)', component: M1_2_ListLayoutFixed },
  { key: 'M1_3', label: 'M1.3 — ListLayout: estimated + invalidation',
    detail: 'Variable heights · cumulative Y · invalidateFrom pivot',
    group: 'Tests — Phase 1: Layout Engine (C++)', component: M1_3_ListLayoutEstimated },
  { key: 'M1_4', label: 'M1.4 — SpatialIndex',
    detail: 'getAttributesInRect · no false +/− · 100-iter perf',
    group: 'Tests — Phase 1: Layout Engine (C++)', component: M1_4_SpatialIndex },
  { key: 'M1_5', label: 'M1.5 — ListLayout: multi-section',
    detail: '10 sections × 1 000 items · headers · footers · invalidation',
    group: 'Tests — Phase 1: Layout Engine (C++)', component: M1_5_ListLayoutMultiSection },

  // ── Phase 2: Scroll Bridge ────────────────────────────────────────────────
  { key: 'M2_2', label: 'M2.2 — Scroll Bridge',
    detail: 'windowController · updateScrollPosition · getScrollPosition · live demo',
    group: 'Tests — Phase 2: Scroll + Window', component: M2_2_ScrollBridge },
  { key: 'M2_4', label: 'M2.4 — Window Controller',
    detail: 'getWindowState · visible/render tiers · geometry correctness · perf',
    group: 'Tests — Phase 2: Scroll + Window', component: M2_4_WindowController },

  // ── Phase 4: Sizing Strategies ───────────────────────────────────────────
  { key: 'M4_1', label: 'M4.1 — Estimated Sizing',
    detail: '200 items · estimatedHeight=80px · actual 55/90/130px · scroll correction',
    group: 'Tests — Phase 4: Sizing', component: M4_1_EstimatedSizing },
  { key: 'M4_3', label: 'M4.3 — Self-Sizing Cells',
    detail: '200 items · tap to expand/collapse · dynamic resize · scroll correction',
    group: 'Tests — Phase 4: Sizing', component: M4_3_SelfSizingCells },

  // ── Phase 3: Virtualization ───────────────────────────────────────────────
  { key: 'M3_3', label: 'M3.3 — Cold Eviction',
    detail: 'Cells unmount outside render window · remount at correct position · gen counter',
    group: 'Tests — Phase 3: Virtualization', component: M3_3_ColdEviction },
  { key: 'M3_4', label: 'M3.4 — Velocity-Adaptive Window',
    detail: '1 000 items · window expands toward direction of travel · fling test',
    group: 'Tests — Phase 3: Virtualization', component: M3_4_VelocityWindow },
  { key: 'M3_5', label: 'M3.5 — Cell Budget',
    detail: '500 items · mounted content capped in viewport multiples · gen counter',
    group: 'Tests — Phase 3: Virtualization', component: M3_5_CellBudget },

  // ── Performance ───────────────────────────────────────────────────────────
  { key: 'P4_1', label: 'P4.1 — Memory Budget',
    detail: 'os_proc_available_memory · pressure levels · auto budget reduction · simulate',
    group: 'Tests — Performance', component: P4_1_MemoryBudget },
  { key: 'P1_1', label: 'P1.1 — C++ Window Controller',
    detail: 'Correctness · JS vs C++ parity · perf comparison · 500-item live demo',
    group: 'Tests — Performance', component: P1_1_CppWindowController },
  { key: 'P5_1', label: 'P5.1/5.2 — Metrics + HUD',
    detail: 'CADisplayLink FPS · frame time · cold mounts · corrections · blank area',
    group: 'Tests — Performance', component: P5_1_Metrics },

  // ── Phase F1: Data Layer ──────────────────────────────────────────────────
  { key: 'F1_1', label: 'F1.1 — Diff Engine',
    detail: 'C++ LIS diff · insert/delete/move · 10k perf < 2ms',
    group: 'Tests — Phase F1: Data Layer', component: F1_1_DiffEngine },
  { key: 'F1_2', label: 'F1.2 — Snapshot API',
    detail: 'appendItems · deleteItems · moveItem · reloadItems · startTransition',
    group: 'Tests — Phase F1: Data Layer', component: F1_2_SnapshotAPI },
  { key: 'F1_3', label: 'F1.3 — Prefetch callbacks',
    detail: 'onPrefetch · onEvict · 12× viewport ahead · cancel in-flight loads',
    group: 'Tests — Phase F1: Data Layer', component: F1_3_PrefetchCallbacks },

  // ── R1.3: Layout Protocol ─────────────────────────────────────────────────
  { key: 'R1_3', label: 'R1.3 — Layout Protocol',
    detail: 'Grid & Flow C++ engines · JSI bindings · correctness · perf',
    group: 'Tests — R1: Layout Protocol', component: R1_3_LayoutProtocol },

  // ── Phase F2: Supplementary Views & Sticky Headers ───────────────────────
  { key: 'F2_1', label: 'F2.1 — Supplementary views',
    detail: '5 sections · headers + footers at correct Y · windowing',
    group: 'Tests — Phase F2: Supplementary Views', component: F2_1_SupplementaryViews },
  { key: 'F2_2', label: 'F2.2 — Sticky headers',
    detail: 'Section header sticks at top · returns to natural position on scroll back',
    group: 'Tests — Phase F2: Supplementary Views', component: F2_2_StickyHeaders },
  { key: 'F2_3', label: 'F2.3 — Sticky push',
    detail: 'Incoming header pushes current sticky up · UICollectionView parity',
    group: 'Tests — Phase F2: Supplementary Views', component: F2_3_StickyPush },
  { key: 'F2_4', label: 'F2.4 — Decoration views',
    detail: 'Per-section tinted backgrounds · behind cells · no touch interception',
    group: 'Tests — Phase F2: Supplementary Views', component: F2_4_DecorationViews },

  // ── ShadowNode ──────────────────────────────────────────────────────────
  { key: 'SN_P1', label: 'SN Phase 1 — Skeleton',
    detail: 'Mount · children visible · scroll · onScroll events · state contentSize',
    group: 'Tests — ShadowNode', component: SN_Phase1_Skeleton },
  { key: 'SN_P3', label: 'SN Phase 3 — Layout Override',
    detail: 'Variable heights · ShadowNode positions · no gaps/overlaps · frame-1 correct',
    group: 'Tests — ShadowNode', component: SN_Phase3_LayoutOverride },
  { key: 'SN_P3b', label: 'SN Phase 3b — Content Measured',
    detail: 'No explicit height · Yoga measures from text · ShadowNode reads measured heights',
    group: 'Tests — ShadowNode', component: SN_Phase3b_ContentMeasured },
  { key: 'SN_P4', label: 'SN Phase 4 — Scroll Correction',
    detail: 'Insert/remove/resize at top · scroll offset corrected · visible content stable',
    group: 'Tests — ShadowNode', component: SN_Phase4_ScrollCorrection },
  { key: 'SN_P5a', label: 'SN Phase 5a — LayoutCache Bridge',
    detail: 'ShadowNode reads estimated heights from cache · writes Yoga-measured heights back',
    group: 'Tests — ShadowNode', component: SN_Phase5_LayoutCacheBridge },
];

// ─── Menu ─────────────────────────────────────────────────────────────────────

function Menu({ onSelect }: { onSelect: (key: string) => void }) {
  const featureScreens = SCREENS.filter(s => s.group === 'Features & Comparison');
  const testGroups = [...new Set(
    SCREENS.filter(s => s.group.startsWith('Tests')).map(s => s.group)
  )];

  return (
    <SafeAreaView style={S.safe}>
      <ScrollView contentContainerStyle={S.menuContainer}>
        <Text style={S.appTitle}>Riff</Text>
        <Text style={S.appSubtitle}>{Platform.OS.toUpperCase()} · tap a screen to open it</Text>

        {/* ── Section 1: Features & Comparison ─────────────────────────── */}
        <Text style={S.groupHeader}>Features &amp; Comparison</Text>
        {featureScreens.map(s => (
          <Pressable key={s.key}
            style={({ pressed }) => [S.row, S.rowFeature, pressed && S.rowPressed]}
            onPress={() => onSelect(s.key)}
          >
            <View style={S.rowInner}>
              <Text style={[S.rowLabel, S.rowLabelFeature]}>{s.label}</Text>
              <Text style={S.rowDetail}>{s.detail}</Text>
            </View>
            <Text style={S.rowChevron}>›</Text>
          </Pressable>
        ))}

        {/* ── Section 2: Coming Soon ────────────────────────────────────── */}
        <Text style={[S.groupHeader, { marginTop: 24 }]}>Coming Soon</Text>
        <View style={S.comingSoonGrid}>
          {COMING_SOON.map((item, i) => (
            <View key={i} style={S.comingSoonItem}>
              <Text style={S.comingSoonLabel}>{item.label}</Text>
              <Text style={S.comingSoonDetail}>{item.detail}</Text>
            </View>
          ))}
        </View>

        {/* ── Section 3: Tests ──────────────────────────────────────────── */}
        <Text style={[S.groupHeader, { marginTop: 24 }]}>Tests</Text>
        {testGroups.map(group => (
          <View key={group}>
            <Text style={S.testGroupHeader}>{group.replace('Tests — ', '')}</Text>
            {SCREENS.filter(s => s.group === group).map(s => (
              <Pressable key={s.key}
                style={({ pressed }) => [S.row, pressed && S.rowPressed]}
                onPress={() => onSelect(s.key)}
              >
                <View style={S.rowInner}>
                  <Text style={S.rowLabel}>{s.label}</Text>
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

  menuContainer:{ padding: 20, paddingBottom: 48 },
  appTitle:     { fontSize: 24, fontWeight: '800', color: '#fff', marginBottom: 2, marginTop: 8 },
  appSubtitle:  { fontSize: 12, color: '#555', marginBottom: 24 },

  groupHeader:  { fontSize: 11, fontWeight: '700', color: '#555',
                  letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 10 },
  testGroupHeader: { fontSize: 10, fontWeight: '600', color: '#333',
                     letterSpacing: 0.6, textTransform: 'uppercase',
                     marginTop: 14, marginBottom: 6, marginLeft: 2 },

  // Feature rows
  row:          { backgroundColor: '#161616', borderRadius: 10, marginBottom: 8,
                  flexDirection: 'row', alignItems: 'center', padding: 14 },
  rowFeature:   { backgroundColor: '#0d1f30', borderWidth: 1, borderColor: '#1a3a5c' },
  rowPressed:   { opacity: 0.6 },
  rowInner:     { flex: 1 },
  rowLabel:     { fontSize: 14, fontWeight: '600', color: '#fff', marginBottom: 2 },
  rowLabelFeature: { color: '#60a5fa', fontSize: 15 },
  rowDetail:    { fontSize: 11, color: '#555' },
  rowChevron:   { fontSize: 20, color: '#444', marginLeft: 8 },

  // Coming soon grid
  comingSoonGrid: { gap: 8 },
  comingSoonItem: { backgroundColor: '#111', borderRadius: 10, padding: 12,
                    borderLeftWidth: 2, borderLeftColor: '#1e293b' },
  comingSoonLabel: { fontSize: 13, fontWeight: '600', color: '#475569', marginBottom: 3 },
  comingSoonDetail: { fontSize: 11, color: '#2d3748', lineHeight: 16 },

  backBar:      { flexDirection: 'row', alignItems: 'center',
                  paddingHorizontal: 16, paddingVertical: 10,
                  borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  backChevron:  { fontSize: 22, color: '#4ade80', marginRight: 4 },
  backLabel:    { fontSize: 15, color: '#4ade80' },
});
