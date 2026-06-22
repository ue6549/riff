/**
 * Activity Probe (0.80.2 compat)
 *
 * Validates the single risky assumption behind running Riff on RN 0.80.2 /
 * React 19.1: React does not EXPORT the Activity component there, but the Fabric
 * reconciler still implements the offscreen fiber. We address it via
 * `Symbol.for('react.activity')` (same shim as CollectionView.tsx).
 *
 * Two things must hold for Riff's measure-ahead + pooling to survive the
 * down-port:
 *
 *   1. MEASURE WHILE HIDDEN — a cell mounted inside `<Activity mode="hidden">`
 *      must still be laid out by Yoga, so its height reaches onLayout.
 *      (This is what makes off-screen pre-measurement work.)
 *
 *   2. SUSPEND WHILE HIDDEN — passive effects (timers, video, image loads)
 *      inside a hidden Activity must NOT run, so off-screen cells are cheap.
 *
 * PASS criteria:
 *   - "Measured while HIDDEN" is non-zero AND equals "Measured while VISIBLE".
 *   - The tick counter freezes while hidden and advances while visible.
 *
 * If (1) fails, measure-ahead must be disabled on 0.80.2 (set measureAhead=0)
 * and we lose white-space protection. If (2) fails, off-screen cells stay live
 * and the perf benefit is reduced.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutChangeEvent, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

// Same shim as src/components/CollectionView.tsx — resolves to the real
// offscreen element type even when React doesn't export Activity.
// @ts-ignore — Activity not in @types/react for all versions
const ActivityShim = ((React as any).Activity ?? Symbol.for('react.activity')) as React.ComponentType<{
    mode: 'visible' | 'hidden';
    children: React.ReactNode;
}>;

const USING_NATIVE_EXPORT = !!(React as any).Activity;

function ProbeCell({ onHeight, onTick }: { onHeight: (h: number) => void; onTick: () => void }) {
    // Passive effect — should be disconnected by Activity while hidden.
    useEffect(() => {
        const id = setInterval(onTick, 250);
        return () => clearInterval(id);
    }, [onTick]);

    return (
        <View style={styles.probeCell} onLayout={(e: LayoutChangeEvent) => onHeight(e.nativeEvent.layout.height)}>
            <Text style={styles.probeText}>Probe cell — line 1</Text>
            <Text style={styles.probeText}>line 2</Text>
            <Text style={styles.probeText}>line 3 (intrinsic height)</Text>
        </View>
    );
}

export default function V0_ActivityProbe() {
    // Start hidden so we capture the hidden-measurement first.
    const [mode, setMode] = useState<'visible' | 'hidden'>('hidden');
    const [hiddenHeight, setHiddenHeight] = useState<number | null>(null);
    const [visibleHeight, setVisibleHeight] = useState<number | null>(null);
    const [ticks, setTicks] = useState(0);

    const modeRef = useRef(mode);
    modeRef.current = mode;

    const onHeight = useCallback((h: number) => {
        if (h <= 0) {
            return;
        }
        if (modeRef.current === 'hidden') {
            setHiddenHeight((prev) => (prev == null ? h : prev));
        } else {
            setVisibleHeight((prev) => (prev == null ? h : prev));
        }
    }, []);

    const onTick = useCallback(() => setTicks((t) => t + 1), []);

    const measuredHidden = hiddenHeight != null && hiddenHeight > 0;
    const measuredVisible = visibleHeight != null && visibleHeight > 0;
    const heightsMatch = measuredHidden && measuredVisible && Math.abs((hiddenHeight as number) - (visibleHeight as number)) < 1;

    const measurePass = measuredHidden && (!measuredVisible || heightsMatch);

    return (
        <ScrollView contentContainerStyle={styles.container}>
            <Text style={styles.title}>Activity Probe — 0.80.2 compat</Text>
            <Text style={styles.subtitle}>
                Activity source: <Text style={styles.mono}>{USING_NATIVE_EXPORT ? 'React.Activity (native export)' : "Symbol.for('react.activity') (shim)"}</Text>
            </Text>

            <View style={styles.panel}>
                <Row label="Current mode" value={mode.toUpperCase()} />
                <Row label="Measured while HIDDEN" value={hiddenHeight != null ? `${hiddenHeight.toFixed(1)} px` : '— (not yet)'} good={measuredHidden} bad={hiddenHeight === null} />
                <Row label="Measured while VISIBLE" value={visibleHeight != null ? `${visibleHeight.toFixed(1)} px` : '— (toggle visible)'} />
                <Row label="Heights match" value={measuredVisible ? (heightsMatch ? 'YES' : 'NO') : 'n/a'} good={heightsMatch} bad={measuredVisible && !heightsMatch} />
                <Row label="Tick counter" value={String(ticks)} />
            </View>

            <View style={styles.verdict}>
                <Text style={styles.verdictLabel}>(1) MEASURE WHILE HIDDEN</Text>
                <Text style={[styles.verdictValue, measurePass ? styles.pass : styles.pending]}>{measuredHidden ? (measurePass ? 'PASS — hidden cells lay out' : 'CHECK — heights differ') : 'PENDING — wait a moment'}</Text>
                <Text style={styles.hint}>If this stays "— (not yet)", hidden Activity does NOT lay out on 0.80.2 → set measureAhead=0 in the adapter.</Text>
            </View>

            <View style={styles.verdict}>
                <Text style={styles.verdictLabel}>(2) SUSPEND WHILE HIDDEN</Text>
                <Text style={styles.hint}>Watch the tick counter: it should FREEZE while HIDDEN and advance while VISIBLE. If it advances while hidden, effects are not suspended.</Text>
            </View>

            <Pressable style={styles.button} onPress={() => setMode((m) => (m === 'hidden' ? 'visible' : 'hidden'))}>
                <Text style={styles.buttonText}>Toggle → {mode === 'hidden' ? 'VISIBLE' : 'HIDDEN'}</Text>
            </Pressable>

            <Pressable
                style={[styles.button, styles.buttonSecondary]}
                onPress={() => {
                    setHiddenHeight(null);
                    setVisibleHeight(null);
                    setTicks(0);
                    setMode('hidden');
                }}
            >
                <Text style={styles.buttonText}>Reset</Text>
            </Pressable>

            <Text style={styles.sectionLabel}>Live probe (wrapped in Activity, mode = {mode})</Text>
            <View style={styles.stage}>
                <ActivityShim mode={mode}>
                    <ProbeCell onHeight={onHeight} onTick={onTick} />
                </ActivityShim>
            </View>
        </ScrollView>
    );
}

function Row({ label, value, good, bad }: { label: string; value: string; good?: boolean; bad?: boolean }) {
    return (
        <View style={styles.row}>
            <Text style={styles.rowLabel}>{label}</Text>
            <Text style={[styles.rowValue, good && styles.pass, bad && styles.fail]}>{value}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { padding: 16, paddingBottom: 64, backgroundColor: '#0a0a0a' },
    title: { fontSize: 18, fontWeight: '800', color: '#fff', marginBottom: 4 },
    subtitle: { fontSize: 12, color: '#888', marginBottom: 16 },
    mono: { color: '#60a5fa' },
    panel: { backgroundColor: '#161616', borderRadius: 10, padding: 12, marginBottom: 16 },
    row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
    rowLabel: { fontSize: 13, color: '#aaa' },
    rowValue: { fontSize: 13, color: '#fff', fontWeight: '600' },
    verdict: { backgroundColor: '#111', borderRadius: 10, padding: 12, marginBottom: 12, borderLeftWidth: 3, borderLeftColor: '#1e293b' },
    verdictLabel: { fontSize: 11, fontWeight: '700', color: '#777', letterSpacing: 0.6, marginBottom: 4 },
    verdictValue: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
    hint: { fontSize: 11, color: '#555', lineHeight: 15 },
    pass: { color: '#4ade80' },
    fail: { color: '#f87171' },
    pending: { color: '#fbbf24' },
    button: { backgroundColor: '#1d4ed8', borderRadius: 10, padding: 14, alignItems: 'center', marginBottom: 8 },
    buttonSecondary: { backgroundColor: '#1f2937' },
    buttonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
    sectionLabel: { fontSize: 11, color: '#555', marginTop: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6 },
    stage: { backgroundColor: '#0d1f30', borderRadius: 10, borderWidth: 1, borderColor: '#1a3a5c', padding: 8, minHeight: 40 },
    probeCell: { backgroundColor: '#1e3a5f', borderRadius: 8, padding: 12 },
    probeText: { color: '#cbd5e1', fontSize: 13, marginBottom: 2 },
});
