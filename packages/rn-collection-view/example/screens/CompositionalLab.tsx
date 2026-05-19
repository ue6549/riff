/**
 * CompositionalLab — comprehensive functional test bench for Riff compositional layout.
 *
 * 7 sections covering every leaf layout type:
 *   S0  list V      sticky header + footer + section bg
 *   S1  list H      sticky header
 *   S2  grid V 2-col  sticky header + footer + section bg
 *   S3  grid H 2-row  sticky header
 *   S4  masonry V 2-col  sticky header + footer + section bg
 *   S5  flow V      sticky header + footer
 *   S6  list V      no chrome (control group)
 *
 * Per-section mutation toolbar:
 *   Item: insert top/mid/bottom, delete first/mid/last, resize first, update first
 *   Section: add/remove/swap
 *   Layout: toggle columns, toggle section bg
 *   Scroll: scrollToTop, scrollToSection
 *
 * Validation targets:
 *   - Cold mounts = 0 in steady state after mutations
 *   - MVC correction delta < 1px during insert/delete/resize
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Riff as CollectionView } from '../components/CollectionView';
import { compositional } from '@riff/layouts/compositional';
import { list } from '@riff/layouts/list';
import { grid } from '@riff/layouts/grid';
import { flow } from '@riff/layouts/flow';
import { masonry } from '@riff/layouts/masonry';
import type { SectionConfig } from '@riff/types/protocol';

// ── Item type ────────────────────────────────────────────────────────────────

type LabItem = {
  id: string;
  label: string;
  color: string;
  detail: string;
  width?: number;    // flow items
  expanded?: boolean; // resize test
};

// ── Colors ───────────────────────────────────────────────────────────────────

const COLORS = [
  '#e63946', '#2a9d8f', '#e9c46a', '#f4a261',
  '#264653', '#457b9d', '#6a4c93', '#1982c4',
];

const SECTION_COLORS = ['#e63946', '#2a9d8f', '#457b9d', '#f4a261', '#6a4c93', '#1982c4', '#264653'];

// ── Data factories ───────────────────────────────────────────────────────────

let _counter = 0;
function makeItem(prefix: string, index: number): LabItem {
  const i = _counter++;
  const w = 80 + (i % 5) * 20; // flow widths: 80-160
  return {
    id: `${prefix}-${i}`,
    label: `${prefix} ${index}`,
    color: COLORS[i % COLORS.length]!,
    detail: index % 3 === 0 ? 'Short.' : index % 3 === 1
      ? 'Medium description with a couple of lines worth of text.'
      : 'Longer detail string that wraps to multiple lines for masonry height variance testing across items.',
    width: w,
  };
}

function makeItems(prefix: string, count: number): LabItem[] {
  return Array.from({ length: count }, (_, i) => makeItem(prefix, i));
}

// ── Initial data ─────────────────────────────────────────────────────────────

const INITIAL_DATA: LabItem[][] = [
  makeItems('s0', 8),   // S0: list V
  makeItems('s1', 12),  // S1: list H
  makeItems('s2', 10),  // S2: grid V
  makeItems('s3', 8),   // S3: grid H
  makeItems('s4', 12),  // S4: masonry V
  makeItems('s5', 20),  // S5: flow V
  makeItems('s6', 6),   // S6: list V (control)
];

// ── Section metadata ─────────────────────────────────────────────────────────

type SectionMeta = {
  key: string;
  label: string;
  type: string;
  color: string;
  hasBg: boolean;
  hasFooter: boolean;
  hasSticky: boolean;
};

const SECTION_META: SectionMeta[] = [
  { key: 'list-v',    label: 'S0 List V',    type: 'list V',    color: '#e63946', hasBg: true,  hasFooter: true,  hasSticky: true },
  { key: 'list-h',    label: 'S1 List H',    type: 'list H',    color: '#2a9d8f', hasBg: false, hasFooter: false, hasSticky: true },
  { key: 'grid-v',    label: 'S2 Grid V',    type: 'grid V',    color: '#457b9d', hasBg: true,  hasFooter: true,  hasSticky: true },
  { key: 'grid-h',    label: 'S3 Grid H',    type: 'grid H',    color: '#f4a261', hasBg: false, hasFooter: false, hasSticky: true },
  { key: 'masonry-v', label: 'S4 Masonry V', type: 'masonry V', color: '#6a4c93', hasBg: true,  hasFooter: true,  hasSticky: true },
  { key: 'flow-v',    label: 'S5 Flow V',    type: 'flow V',    color: '#1982c4', hasBg: false, hasFooter: true,  hasSticky: true },
  { key: 'ctrl',      label: 'S6 List V (no chrome — control)', type: 'list V', color: '#264653', hasBg: false, hasFooter: false, hasSticky: false },
];

// ── Constants ────────────────────────────────────────────────────────────────

const HEADER_H = 44;
const FOOTER_H = 28;

// ── Control widgets ──────────────────────────────────────────────────────────

function Btn({ label, onPress, disabled, active, small }: {
  label: string; onPress?: () => void; disabled?: boolean; active?: boolean; small?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingHorizontal: small ? 6 : 8, paddingVertical: small ? 3 : 5,
        borderRadius: 5,
        backgroundColor: disabled ? '#e8e8e8' : active ? '#d1fae5' : '#f0f0f0',
        opacity: disabled ? 0.5 : 1,
        borderWidth: active ? 1 : 0,
        borderColor: active ? '#34d399' : 'transparent',
      }}
    >
      <Text style={{
        color: disabled ? '#999' : active ? '#059669' : '#333',
        fontSize: small ? 10 : 11, fontWeight: '600',
      }}>{label}</Text>
    </Pressable>
  );
}

function Divider() {
  return <View style={{ width: 1, height: 16, backgroundColor: '#d0d0d0', marginHorizontal: 2 }} />;
}

// ── Section chrome ───────────────────────────────────────────────────────────

function LabSectionHeader({ title, count, subtitle }: { title: string; count: number; subtitle: string }) {
  return (
    <View style={styles.sectionHeader}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionCount}>{count}</Text>
      </View>
      <Text style={styles.sectionSubtitle}>{subtitle}</Text>
    </View>
  );
}

function LabSectionFooter({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.sectionFooter, { borderTopColor: color + '44', backgroundColor: color + '0a' }]}>
      <Text style={[styles.sectionFooterText, { color: color + 'cc' }]}>{label}</Text>
    </View>
  );
}

// ── Cells ────────────────────────────────────────────────────────────────────

function LabCell({ item }: { item: LabItem }) {
  return (
    <View style={[styles.cell, { borderLeftColor: item.color + '66' }]}>
      <Text style={styles.cellLabel}>{item.label}</Text>
      <Text style={styles.cellDetail} numberOfLines={item.expanded ? undefined : 2}>{item.detail}</Text>
      {item.expanded && (
        <View style={[styles.cellExpanded, { backgroundColor: item.color + '10' }]}>
          <Text style={{ color: item.color, fontSize: 11, fontWeight: '600' }}>Expanded content for resize testing</Text>
        </View>
      )}
    </View>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function CompositionalLab() {
  const cvRef = useRef<any>(null);
  const [sectionDatas, setSectionDatas] = useState<LabItem[][]>(
    INITIAL_DATA.map(d => [...d]),
  );
  const [sectionMetas, setSectionMetas] = useState<SectionMeta[]>([...SECTION_META]);
  // layoutOrder[physicalIdx] = logical section index → drives which layout config renders at each position.
  const [layoutOrder, setLayoutOrder] = useState([0, 1, 2, 3, 4, 5, 6]);
  const [targetSection, setTargetSection] = useState(0);
  const [mvcEnabled, setMvcEnabled] = useState(true);
  const [hudEnabled, setHudEnabled] = useState(false);
  const [gridCols, setGridCols] = useState(2);
  const [sectionBgEnabled, setSectionBgEnabled] = useState(true);

  // Track section count for add/remove
  const [sectionCount, setSectionCount] = useState(SECTION_META.length);

  // ── Mutations ──────────────────────────────────────────────────────────────

  const mutateSection = useCallback((si: number, fn: (prev: LabItem[]) => LabItem[]) => {
    setSectionDatas(prev => {
      if (si >= prev.length) return prev;
      const copy = [...prev];
      copy[si] = fn(copy[si]!);
      return copy;
    });
  }, []);

  const insertAt = useCallback((si: number, pos: 'top' | 'mid' | 'bottom') => {
    const prefix = `s${si}`;
    mutateSection(si, prev => {
      const item = makeItem(prefix, prev.length);
      if (pos === 'top') return [item, ...prev];
      if (pos === 'bottom') return [...prev, item];
      const mid = Math.floor(prev.length / 2);
      return [...prev.slice(0, mid), item, ...prev.slice(mid)];
    });
  }, [mutateSection]);

  const deleteAt = useCallback((si: number, pos: 'first' | 'mid' | 'last') => {
    mutateSection(si, prev => {
      if (prev.length <= 1) return prev;
      if (pos === 'first') return prev.slice(1);
      if (pos === 'last') return prev.slice(0, -1);
      const mid = Math.floor(prev.length / 2);
      return [...prev.slice(0, mid), ...prev.slice(mid + 1)];
    });
  }, [mutateSection]);

  const resizeFirst = useCallback((si: number) => {
    mutateSection(si, prev => {
      if (prev.length === 0) return prev;
      const copy = [...prev];
      copy[0] = { ...copy[0]!, expanded: !copy[0]!.expanded };
      return copy;
    });
  }, [mutateSection]);

  const updateFirst = useCallback((si: number) => {
    mutateSection(si, prev => {
      if (prev.length === 0) return prev;
      const copy = [...prev];
      const old = copy[0]!;
      copy[0] = { ...old, label: old.label + ' *', color: COLORS[(COLORS.indexOf(old.color) + 1) % COLORS.length]! };
      return copy;
    });
  }, [mutateSection]);

  // Section mutations
  const addSection = useCallback(() => {
    const idx = sectionCount;
    setSectionDatas(prev => [...prev, makeItems(`s${idx}`, 6)]);
    setLayoutOrder(prev => [...prev, prev.length]); // new physical position → new logical index (defaultExtra)
    setSectionCount(c => c + 1);
  }, [sectionCount]);

  const removeSection = useCallback(() => {
    setSectionDatas(prev => prev.length > 2 ? prev.slice(0, -1) : prev);
    setLayoutOrder(prev => prev.length > 2 ? prev.slice(0, -1) : prev);
    setSectionCount(c => Math.max(2, c - 1));
  }, []);

  const swapSections = useCallback(() => {
    const swap2 = <T,>(arr: T[]): T[] => {
      if (arr.length < 2) return arr;
      const copy = [...arr];
      [copy[0], copy[1]] = [copy[1]!, copy[0]!];
      return copy;
    };
    setSectionDatas(prev => swap2(prev));
    setSectionMetas(prev => swap2(prev));
    setLayoutOrder(prev => swap2(prev));
  }, []);

  // ── Layout ─────────────────────────────────────────────────────────────────

  const flowSizeRef = useRef(sectionDatas[5] ?? []);
  flowSizeRef.current = sectionDatas[5] ?? [];

  // Logical layout configs indexed 0-6. layoutOrder[physicalIdx] picks which one to use.
  const layout = useMemo(() => {
    type LayoutEntry = { layout: any; horizontal?: boolean };
    const logical: LayoutEntry[] = [
      // 0: list V — sticky header + footer + section bg
      { layout: list({ estimatedItemHeight: 80, headerHeight: HEADER_H, footerHeight: FOOTER_H, itemSpacing: 8, stickyMode: 'push', sectionBackground: sectionBgEnabled, sectionSpacing: 10 }) },
      // 1: list H — sticky header
      { layout: list({ estimatedItemHeight: 140, headerHeight: HEADER_H, itemSpacing: 8, sectionSpacing: 10, estimatedCrossAxisHeight: 120 }), horizontal: true },
      // 2: grid V 2-col — sticky header + footer + section bg
      { layout: grid({ columns: gridCols, rowHeight: 100, columnSpacing: 8, rowSpacing: 8, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push', sectionBackground: sectionBgEnabled, sectionSpacing: 10 }) },
      // 3: grid H 2-row — sticky header
      { layout: grid({ columns: 2, rowHeight: 80, columnSpacing: 8, rowSpacing: 8, headerHeight: HEADER_H, sectionSpacing: 10, estimatedCrossAxisHeight: 180 }), horizontal: true },
      // 4: masonry V 2-col — sticky header + footer + section bg
      { layout: masonry({ columns: gridCols, columnSpacing: 8, rowSpacing: 8, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push', sectionBackground: sectionBgEnabled, sectionSpacing: 10 }) },
      // 5: flow V — sticky header + footer
      { layout: flow({ sizeForItem: (i: number) => ({ width: flowSizeRef.current[i]?.width ?? 100, height: 34 }), itemSpacing: 6, lineSpacing: 6, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push', sectionSpacing: 10 }) },
      // 6: list V — no chrome (control group)
      { layout: list({ estimatedItemHeight: 80, itemSpacing: 8, sectionSpacing: 10 }) },
    ];
    const defaultExtra: LayoutEntry = { layout: list({ estimatedItemHeight: 80, itemSpacing: 8, sectionSpacing: 10 }) };
    return compositional(
      layoutOrder.map((logicalIdx, physicalIdx) => {
        const cfg = logical[logicalIdx] ?? defaultExtra;
        return cfg.horizontal
          ? { range: physicalIdx, layout: cfg.layout, horizontal: true as const }
          : { range: physicalIdx, layout: cfg.layout };
      })
    );
  }, [gridCols, sectionBgEnabled, layoutOrder]);

  // ── Sections ───────────────────────────────────────────────────────────────

  const sections = useMemo<SectionConfig<LabItem>[]>(() => {
    const result: SectionConfig<LabItem>[] = [];
    const count = Math.min(sectionDatas.length, sectionMetas.length);
    for (let i = 0; i < count; i++) {
      const meta = sectionMetas[i]!;
      const data = sectionDatas[i]!;
      const sec: SectionConfig<LabItem> = {
        key: meta.key,
        data,
        insets: { top: 8, bottom: 8, left: 10, right: 10 },
      };
      if (meta.hasSticky) {
        sec.header = {
          render: () => <LabSectionHeader title={meta.label} count={data.length} subtitle={meta.type} />,
          height: HEADER_H,
          sticky: true,
        };
      }
      if (meta.hasFooter) {
        sec.footer = {
          render: () => <LabSectionFooter label={`${data.length} items`} color={meta.color} />,
          height: FOOTER_H,
          sticky: false,
        };
      }
      result.push(sec);
    }
    // Extra sections beyond initial 7
    for (let i = count; i < sectionDatas.length; i++) {
      result.push({
        key: `extra-${i}`,
        data: sectionDatas[i]!,
        header: {
          render: () => <LabSectionHeader title={`Extra S${i}`} count={sectionDatas[i]!.length} subtitle="list V (dynamic)" />,
          height: HEADER_H,
          sticky: true,
        },
        insets: { top: 8, bottom: 8, left: 10, right: 10 },
      });
    }
    return result;
  }, [sectionDatas, sectionMetas]);

  // ── Callbacks ──────────────────────────────────────────────────────────────

  const keyExtractor = useCallback((item: LabItem) => item.id, []);
  const getItemType = useCallback((_item: LabItem, index: number) => {
    // Pool items by section type to test cross-section recycling.
    // Items from same section type share a pool (S0+S6 share 'list-v-item').
    // This is intentionally simple — production code would use item._type.
    void index;
    return 'lab-item';
  }, []);

  const renderItem = useCallback(({ item }: { item: LabItem }) => (
    <LabCell item={item} />
  ), []);

  // ── Scroll helpers ─────────────────────────────────────────────────────────

  const scrollToSection = useCallback((si: number) => {
    cvRef.current?.scrollToSection(si, { position: 'top' });
  }, []);

  const ts = targetSection;

  return (
    <View style={styles.root}>
      {/* ── Section target selector ──────────────────────────────────────── */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.targetBar} contentContainerStyle={styles.targetBarContent}>
        <Text style={styles.targetLabel}>Target:</Text>
        {SECTION_META.map((m, i) => (
          <Btn key={m.key} label={m.label} onPress={() => setTargetSection(i)}
               active={ts === i} small disabled={i >= sectionDatas.length} />
        ))}
        {sectionDatas.length > SECTION_META.length &&
          Array.from({ length: sectionDatas.length - SECTION_META.length }, (_, j) => {
            const idx = SECTION_META.length + j;
            return <Btn key={`extra-${idx}`} label={`Extra ${idx}`} onPress={() => setTargetSection(idx)} active={ts === idx} small />;
          })
        }
      </ScrollView>

      {/* ── Item mutation toolbar ─────────────────────────────────────── */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.toolBar} contentContainerStyle={styles.toolBarContent}>
        <Text style={styles.toolLabel}>Item:</Text>
        <Btn label="+Top"    onPress={() => insertAt(ts, 'top')} small />
        <Btn label="+Mid"    onPress={() => insertAt(ts, 'mid')} small />
        <Btn label="+Bot"    onPress={() => insertAt(ts, 'bottom')} small />
        <Divider />
        <Btn label="-1st"    onPress={() => deleteAt(ts, 'first')} small />
        <Btn label="-Mid"    onPress={() => deleteAt(ts, 'mid')} small />
        <Btn label="-Last"   onPress={() => deleteAt(ts, 'last')} small />
        <Divider />
        <Btn label="Resize"  onPress={() => resizeFirst(ts)} small />
        <Btn label="Update"  onPress={() => updateFirst(ts)} small />
        <Divider />
        <Text style={styles.toolLabel}>Sect:</Text>
        <Btn label="+Add"    onPress={addSection} small />
        <Btn label="-Rem"    onPress={removeSection} small disabled={sectionDatas.length <= 2} />
        <Btn label="Swap 0/1" onPress={swapSections} small />
      </ScrollView>

      {/* ── Layout + Scroll toolbar ───────────────────────────────────── */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.toolBar} contentContainerStyle={styles.toolBarContent}>
        <Text style={styles.toolLabel}>Layout:</Text>
        <Btn label={`Cols: ${gridCols}`} onPress={() => setGridCols(c => c === 2 ? 3 : 2)} small active={gridCols === 3} />
        <Btn label="Sect BG" onPress={() => setSectionBgEnabled(v => !v)} small active={sectionBgEnabled} />
        <Divider />
        <Text style={styles.toolLabel}>Scroll:</Text>
        <Btn label="Top"  onPress={() => cvRef.current?.scrollToTop()} small />
        {SECTION_META.slice(0, Math.min(sectionDatas.length, SECTION_META.length)).map((m, i) => (
          <Btn key={m.key} label={`S${i}`} onPress={() => scrollToSection(i)} small />
        ))}
        <Divider />
        <Btn label={mvcEnabled ? 'MVC ON' : 'MVC'} onPress={() => setMvcEnabled(v => !v)} small active={mvcEnabled} />
        <Btn label={hudEnabled ? 'HUD ON' : 'HUD'} onPress={() => setHudEnabled(v => !v)} small active={hudEnabled} />
      </ScrollView>

      {/* ── Collection View ───────────────────────────────────────────── */}
      <CollectionView
        handle={cvRef}
        sections={sections}
        layout={layout}
        keyExtractor={keyExtractor}
        getItemType={getItemType}
        renderItem={renderItem}
        extraData={sectionDatas}
        maintainVisibleContentPosition={mvcEnabled}
        showHUD={hudEnabled}
        hRenderMultiplier={1.0}
        scrollViewProps={{ contentInsetAdjustmentBehavior: 'automatic' }}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fafafa' },

  targetBar: { flexGrow: 0, backgroundColor: '#fff', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ddd' },
  targetBarContent: { flexDirection: 'row', gap: 5, paddingHorizontal: 8, paddingVertical: 6, alignItems: 'center' },
  targetLabel: { fontSize: 11, fontWeight: '700', color: '#555', marginRight: 2 },

  toolBar: { flexGrow: 0, backgroundColor: '#fff', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e0e0e0' },
  toolBarContent: { flexDirection: 'row', gap: 4, paddingHorizontal: 8, paddingVertical: 5, alignItems: 'center' },
  toolLabel: { fontSize: 10, fontWeight: '700', color: '#888', marginRight: 2 },

  sectionHeader: {
    height: HEADER_H, backgroundColor: '#ffffffee',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ddd',
    justifyContent: 'center', paddingHorizontal: 12,
  },
  sectionTitle: { color: '#222', fontSize: 13, fontWeight: '700' },
  sectionCount: { color: '#888', fontSize: 11, fontWeight: '600' },
  sectionSubtitle: { color: '#888', fontSize: 10, marginTop: 1 },

  sectionFooter: {
    height: FOOTER_H, borderTopWidth: 1,
    justifyContent: 'center', paddingHorizontal: 12,
  },
  sectionFooterText: { fontSize: 10, fontWeight: '600' },

  cell: {
    backgroundColor: '#fff', borderRadius: 8, padding: 10,
    borderLeftWidth: 3, borderColor: '#ddd',
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
  },
  cellLabel: { color: '#222', fontSize: 12, fontWeight: '600', marginBottom: 3 },
  cellDetail: { color: '#666', fontSize: 11, lineHeight: 15 },
  cellExpanded: {
    marginTop: 8, paddingTop: 8, paddingHorizontal: 8, paddingBottom: 6,
    borderRadius: 6,
  },
});
