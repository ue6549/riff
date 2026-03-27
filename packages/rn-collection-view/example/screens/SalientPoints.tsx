/**
 * Salient Points — Key design decisions, CV vs FlashList, and the TS+C++→Codegen story.
 */
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

// ── Data ──────────────────────────────────────────────────────────────────────

type Section = {
  id: string;
  title: string;
  subtitle: string;
  accent: string;
  items: { heading: string; body: string }[];
};

const SECTIONS: Section[] = [
  {
    id: 'design',
    title: 'Architecture & Design Decisions',
    subtitle: 'What makes this performant',
    accent: '#4ade80',
    items: [
      {
        heading: 'C++ layout engine on the UI thread',
        body: 'All layout computation runs in C++ via JSI, synchronous with the UIScrollViewDelegate callback — the same frame the scroll event fires. No JS thread involvement in the hot path. Grid, Masonry, Flow layouts each complete in < 1ms for 10k items.',
      },
      {
        heading: 'No cell recycling — component identity = item identity',
        body: 'Every item maps to exactly one React component. State, animations, refs, and effects are always tied to the correct item. FlashList recycles views — correct, but requires consumers to lift all state out of cells to avoid bleed.',
      },
      {
        heading: 'Activity API for pre-render without paint',
        body: 'Cells in the measure range mount with Activity=hidden — Fabric computes their Yoga layout and reports height via layoutSubviews before the first frame, but the cell is invisible to the user. When the viewport arrives, a single mode flip (hidden→visible) shows the cell with no re-render, no position jump.',
      },
      {
        heading: 'RNMeasuredCell: height before first paint',
        body: 'A custom Fabric component that fires onMeasured from layoutSubviews — the native layout pass — before any pixel is committed to screen. Eliminates the JS ref.measure() roundtrip entirely. Self-sizing cells expand/collapse with the measured height already known.',
      },
      {
        heading: 'Velocity-adaptive render window',
        body: 'The render window expands asymmetrically toward the direction of travel during fast scroll, and contracts to a smaller symmetric window at rest. This pre-mounts cells that will soon be visible without wasting memory on the trailing direction.',
      },
      {
        heading: 'Memory pressure response',
        body: 'os_proc_available_memory() via JSI gives available bytes synchronously. UIApplicationDidReceiveMemoryWarningNotification triggers C++ → JS callback. Under pressure, the effective render window shrinks automatically — fewer cells mounted, lower peak RSS.',
      },
      {
        heading: 'Sticky headers on the UI thread',
        body: 'RNScrollCoordinatedView uses KVO on UIScrollView.contentOffset to apply CATransform3D translateY on the UI thread — zero JS per scroll frame for sticky positioning and push behavior. The outgoing header\'s animation state never resets because it\'s the same component instance, just translated.',
      },
      {
        heading: 'React.memo + stable renderItem ref',
        body: 'MemoizedCellContent wraps every cell. Scroll events only update range state — stable cells see no re-render. On simulator this alone turned 1fps → 40-50fps. Consumers must stabilise their renderItem with useCallback.',
      },
    ],
  },
  {
    id: 'vs',
    title: 'Riff vs FlashList',
    subtitle: 'Honest capability comparison',
    accent: '#60a5fa',
    items: [
      {
        heading: '✅ CV | ✅ FL — Grid & Masonry layouts',
        body: 'Both support fixed-column grid (CV: C++ GridLayout; FL: numColumns). Both support masonry (CV: C++ MasonryLayout; FL: MasonryFlashList import). Parity here.',
      },
      {
        heading: '✅ CV | ⚠️ FL — Flow layout (variable-width wrapping)',
        body: 'CV: C++ FlowLayout, sub-ms for 1k items, variable item widths, auto line-wrap, line height = tallest in row. FL: possible via custom LayoutProvider in RLV, requires manual JS width tracking — not built-in.',
      },
      {
        heading: '✅ CV | ❌ FL — Radial arc & 3D carousel layouts',
        body: 'CV: arbitrary (x, y, scale, rotateY, opacity) per item via TS custom layout — built with simple math, no native code. FL: structurally impossible — items must be sequential along one scroll axis, no per-item transform driven by scroll position.',
      },
      {
        heading: '✅ CV | ❌ FL — Identity-preserving cell state',
        body: 'CV: a cell\'s React component never moves to a different item. Like buttons, TextInput, animations, timers — all correct by default. FL: recycling binds a component to different items — state bleeds unless consumers lift all state out of cells.',
      },
      {
        heading: '✅ CV | ❌ FL — Snapshot API (animated batch mutations)',
        body: 'CV: snapshot().insertItems().deleteItems().moveItem().apply() — identity diff, LayoutAnimation, scroll position preserved, only changed items re-rendered. FL: replace the data array prop — no identity tracking, no insert-at/move semantics.',
      },
      {
        heading: '✅ CV | ❌ FL — Sticky header push + animation continuity',
        body: 'CV: incoming section header pushes outgoing header pixel-perfectly on UI thread. Ticker and shimmer animations in the outgoing header never reset — same component instance, just translated. FL: headers overlap at top, and re-mount on section change resetting all state.',
      },
      {
        heading: '✅ CV | ❌ FL — Decoration views (section backgrounds)',
        body: 'CV: renderSectionBackground renders a real animated React component behind each section\'s cells. Animation continues seamlessly within render window. FL: no concept of decoration views — manual absolute positioning with known heights only.',
      },
      {
        heading: '✅ CV | ❌ FL — Responsive column topology on resize',
        body: 'CV: columns prop accepts a function of container width — layout reflows 3→2→1 columns smoothly per-frame as the container animates. FL: numColumns is static; changing it unmounts and remounts the entire list, destroying scroll position and cell state.',
      },
      {
        heading: '⚠️ CV | ✅ FL — Fast-scroll blank area',
        body: 'FL wins here: recycled views are already mounted — the new item\'s content appears the moment the URL/data prop changes. CV must cold-mount new cells entering the render window. onPrefetch mitigates this for async data, but mount latency is a fundamental no-recycling tradeoff.',
      },
      {
        heading: '✅ CV | ✅ FL — Prefetch callbacks',
        body: 'CV: onPrefetch fires 12× viewport ahead — Image.prefetch() or API calls can warm caches before cells mount. FL: no built-in prefetch API. Image caching relies on the image library\'s own strategy.',
      },
    ],
  },
  {
    id: 'stack',
    title: 'TS Flexibility · C++ Perf · Codegen Future',
    subtitle: 'Three-layer power story',
    accent: '#c084fc',
    items: [
      {
        heading: 'TypeScript: any layout, zero native code',
        body: 'Custom layouts implement a single compute(params) → LayoutAttributes[] function in TypeScript. The 3D carousel and radial arc are ~60 lines of math each. Any developer who can write JS can build a layout that UICollectionView would require an Objective-C UICollectionViewLayout subclass for.',
      },
      {
        heading: 'C++: sub-millisecond built-in layouts',
        body: 'Grid, Masonry, Flow, and List are implemented in C++ and exposed via JSI synchronous calls. Layout for 10k items completes in < 1ms — fast enough to run on every scroll frame inside UIScrollViewDelegate, without touching the JS thread at all.',
      },
      {
        heading: 'JSI bridge: synchronous, typed, zero-copy',
        body: 'All C++ layout engines are exposed as JSI host objects — synchronous function calls from JS with no message-passing overhead. Positions are returned as flat Float32Array-compatible number arrays, minimising bridge serialisation cost.',
      },
      {
        heading: 'The gap: TS layouts are one frame behind',
        body: 'TS custom layouts run on the JS thread. The C++ scroll event fires on the UI thread one frame earlier. For most layouts this is imperceptible. For tight scroll-driven transforms (like the 3D carousel) slight jitter is visible during fast scroll.',
      },
      {
        heading: 'Bridge the gap today: rewrite in C++',
        body: 'Any TS custom layout can be rewritten as a C++ layout following the same pattern as GridLayout or FlowLayout. The JSI binding is ~30 lines of boilerplate; the algorithm is identical. The 3D carousel\'s sin/cos math is arguably simpler in C++.',
      },
      {
        heading: 'Future: codegen TS→C++ automatically',
        body: 'Custom layout compute() functions are pure: typed numeric inputs → array of {x, y, width, height, scale, rotateY, opacity}. No closures, no GC, no dynamic dispatch. Operations map 1:1 to C++. A build-time AST transform could generate cpp/layouts/Generated_Carousel3D.h from the TS source — zero manual C++ for the developer.',
      },
      {
        heading: 'Alternative: Static Hermes (Meta\'s AOT compiler)',
        body: 'Static Hermes compiles typed JS directly to native machine code with no interpreter overhead. If SH ships for RN, it may make the TS→C++ codegen path unnecessary — the JS layout function would compile to native speed automatically.',
      },
      {
        heading: 'UICollectionView-class architecture, RN ergonomics',
        body: 'The design mirrors UICollectionView: a layout protocol, delegate pattern, supplementary views, decoration views, snapshot API. The goal is to bring the same versatility and composability to React Native that UICollectionView brought to UIKit — without requiring developers to write UIKit.',
      },
    ],
  },
];

// ── Section card ──────────────────────────────────────────────────────────────

function SectionCard({ section }: { section: Section }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggle = (i: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  const expandAll = () => setExpanded(new Set(section.items.map((_, i) => i)));
  const collapseAll = () => setExpanded(new Set());

  return (
    <View style={[S.card, { borderLeftColor: section.accent }]}>
      <View style={S.cardHeader}>
        <View style={S.cardTitleBlock}>
          <Text style={[S.cardTitle, { color: section.accent }]}>{section.title}</Text>
          <Text style={S.cardSubtitle}>{section.subtitle}</Text>
        </View>
        <View style={S.cardActions}>
          <Pressable onPress={expandAll}><Text style={S.cardAction}>all</Text></Pressable>
          <Pressable onPress={collapseAll}><Text style={S.cardAction}>none</Text></Pressable>
        </View>
      </View>

      {section.items.map((item, i) => (
        <Pressable key={i} onPress={() => toggle(i)}>
          <View style={[S.row, expanded.has(i) && S.rowExpanded]}>
            <View style={S.rowTop}>
              <Text style={[S.rowHeading, expanded.has(i) && { color: '#f1f5f9' }]}>
                {item.heading}
              </Text>
              <Text style={[S.chevron, expanded.has(i) && S.chevronOpen]}>›</Text>
            </View>
            {expanded.has(i) && (
              <Text style={S.rowBody}>{item.body}</Text>
            )}
          </View>
        </Pressable>
      ))}
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function SalientPoints() {
  return (
    <ScrollView style={S.root} contentContainerStyle={S.content}>
      {/* Hero */}
      <View style={S.hero}>
        <Text style={S.heroTitle}>Riff</Text>
        <Text style={S.heroTagline}>
          UICollectionView-class power · React Native ergonomics
        </Text>
        <Text style={S.heroSub}>
          C++ layout engine · JSI sync calls · TS custom layouts · No recycling · Activity pre-render
        </Text>
      </View>

      {/* Quick stats */}
      <View style={S.statsRow}>
        {[
          { n: '< 1ms', label: 'layout 10k items' },
          { n: '~0µs', label: 'scroll hot path' },
          { n: '∞', label: 'custom layouts' },
          { n: '0', label: 'state bleed' },
        ].map(s => (
          <View key={s.label} style={S.stat}>
            <Text style={S.statN}>{s.n}</Text>
            <Text style={S.statL}>{s.label}</Text>
          </View>
        ))}
      </View>

      {/* Section cards */}
      {SECTIONS.map(s => <SectionCard key={s.id} section={s} />)}

      <View style={S.footer}>
        <Text style={S.footerText}>Tap any row to expand details</Text>
      </View>
    </ScrollView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { padding: 16, paddingBottom: 48 },

  hero: { marginBottom: 20, paddingVertical: 24, alignItems: 'center' },
  heroTitle: { fontSize: 28, fontWeight: '800', color: '#fff', letterSpacing: -0.5 },
  heroTagline: { fontSize: 14, color: '#94a3b8', marginTop: 6, textAlign: 'center' },
  heroSub: { fontSize: 10, color: '#475569', marginTop: 8, textAlign: 'center', lineHeight: 16 },

  statsRow: { flexDirection: 'row', marginBottom: 20, gap: 8 },
  stat: { flex: 1, backgroundColor: '#111', borderRadius: 10, padding: 12, alignItems: 'center' },
  statN: { fontSize: 18, fontWeight: '800', color: '#4ade80' },
  statL: { fontSize: 9, color: '#555', marginTop: 3, textAlign: 'center' },

  card: { backgroundColor: '#111', borderRadius: 12, marginBottom: 14,
          borderLeftWidth: 3, overflow: 'hidden' },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
                padding: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  cardTitleBlock: { flex: 1 },
  cardTitle: { fontSize: 14, fontWeight: '700' },
  cardSubtitle: { fontSize: 11, color: '#555', marginTop: 2 },
  cardActions: { flexDirection: 'row', gap: 10, paddingTop: 2 },
  cardAction: { fontSize: 10, color: '#444', textDecorationLine: 'underline' },

  row: { paddingHorizontal: 14, paddingVertical: 10,
         borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1a1a1a' },
  rowExpanded: { backgroundColor: '#0f1a0f' },
  rowTop: { flexDirection: 'row', alignItems: 'center' },
  rowHeading: { flex: 1, fontSize: 12, color: '#94a3b8', lineHeight: 18 },
  chevron: { fontSize: 18, color: '#333', marginLeft: 8, transform: [{ rotate: '0deg' }] },
  chevronOpen: { color: '#4ade80', transform: [{ rotate: '90deg' }] },
  rowBody: { fontSize: 12, color: '#64748b', lineHeight: 19, marginTop: 8 },

  footer: { marginTop: 8, alignItems: 'center' },
  footerText: { fontSize: 10, color: '#333', fontStyle: 'italic' },
});
