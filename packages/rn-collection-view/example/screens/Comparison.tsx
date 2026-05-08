/**
 * FlashList Comparison — Feed
 *
 * Side-by-side FPS comparison on a realistic social feed.
 * Toggle between Riff and FlashList with the engine switch.
 */
import React, { useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import FeedComparisonTab from './comparison/FeedComparisonTab';

type Engine = 'cv' | 'flash';

export default function Comparison() {
  const [engine, setEngine] = useState<Engine>('cv');

  return (
    <SafeAreaView style={S.root}>
      <View style={S.engineBar}>
        <Pressable
          style={[S.engineBtn, engine === 'cv' && S.engineBtnActive]}
          onPress={() => setEngine('cv')}
        >
          <Text style={[S.engineText, engine === 'cv' && S.engineTextActive]}>Riff</Text>
        </Pressable>
        <Pressable
          style={[S.engineBtn, engine === 'flash' && S.engineBtnFlash]}
          onPress={() => setEngine('flash')}
        >
          <Text style={[S.engineText, engine === 'flash' && S.engineTextFlash]}>FlashList</Text>
        </Pressable>
      </View>

      <View style={S.content}>
        <FeedComparisonTab mode={engine} />
      </View>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  root:            { flex: 1, backgroundColor: '#0a0a0a' },

  engineBar:       { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  engineBtn:       { flex: 1, paddingVertical: 6, borderRadius: 6,
                     backgroundColor: '#1a1a1a', alignItems: 'center' },
  engineBtnActive: { backgroundColor: '#1e3a1e' },
  engineBtnFlash:  { backgroundColor: '#3a1e1e' },
  engineText:      { fontSize: 12, fontWeight: '600', color: '#555' },
  engineTextActive:{ color: '#4ade80' },
  engineTextFlash: { color: '#f87171' },

  content:         { flex: 1 },
});
