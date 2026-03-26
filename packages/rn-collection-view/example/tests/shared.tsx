/**
 * Shared UI primitives for acceptance-test screens.
 */
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

export interface TestResult {
  label: string;
  value: string;
  pass: boolean;
}

interface Props {
  title: string;
  subtitle?: string;
  results: TestResult[];
}

export function TestScreen({ title, subtitle, results }: Props) {
  const passed = results.filter(r => r.pass).length;
  const total  = results.length;

  return (
    <ScrollView style={S.bg} contentContainerStyle={S.container}>
      <Text style={S.title}>{title}</Text>
      {subtitle ? <Text style={S.subtitle}>{subtitle}</Text> : null}
      <Text style={[S.summary, { color: passed === total ? '#4ade80' : '#f87171' }]}>
        {passed}/{total} passed
      </Text>
      {results.map((r, i) => (
        <View key={i} style={S.row}>
          <Text style={[S.icon, { color: r.pass ? '#4ade80' : '#f87171' }]}>
            {r.pass ? '✓' : '✗'}
          </Text>
          <View style={S.rowText}>
            <Text style={S.label}>{r.label}</Text>
            <Text style={S.value}>{r.value}</Text>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const S = StyleSheet.create({
  bg:        { flex: 1, backgroundColor: '#0a0a0a' },
  container: { padding: 24, paddingTop: 16, paddingBottom: 40 },
  title:     { fontSize: 18, fontWeight: '700', color: '#fff', marginBottom: 2 },
  subtitle:  { fontSize: 12, color: '#666', marginBottom: 16 },
  summary:   { fontSize: 15, fontWeight: '600', marginBottom: 24 },
  row:       { flexDirection: 'row', marginBottom: 16, alignItems: 'flex-start' },
  icon:      { fontSize: 16, marginRight: 10, marginTop: 1 },
  rowText:   { flex: 1 },
  label:     { fontSize: 13, color: '#aaa' },
  value:     { fontSize: 13, color: '#fff', fontFamily: 'Menlo', marginTop: 2 },
});
