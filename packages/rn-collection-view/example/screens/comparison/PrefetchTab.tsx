/**
 * Tab — Prefetch Comparison
 *
 * Two sub-tabs:
 *   Simulated — fake 300–800ms delay per item (API call / image decode simulation)
 *   Real Images — actual 600×600 images from picsum.photos
 *
 * CollectionView: onPrefetch fires 12× viewport ahead.
 *   Simulated: startLoading() called early → data ready before cell mounts.
 *   Images: Image.prefetch(url) warms native cache → instant display on mount.
 * FlashList: no prefetch API.
 *   Simulated: loading starts on mount/rebind, full delay each time.
 *   Images: download starts on mount/rebind, old bitmap useless for new URL.
 *
 * Honest tradeoff: blank cells during fast scroll in CV are from mount latency
 * (no recycling), not from loading. Prefetch helps with async data, not mount cost.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Riff } from '../../components/CollectionView';

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED
// ═══════════════════════════════════════════════════════════════════════════════

const COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#f4a261', '#264653', '#457b9d', '#6a4c93', '#1982c4'];

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATED DELAY
// ═══════════════════════════════════════════════════════════════════════════════

const SIM_COUNT = 500;
const SIM_H = 72;

type SimItem = { id: number; color: string; delay: number };

const SIM_DATA: SimItem[] = Array.from({ length: SIM_COUNT }, (_, i) => ({
  id: i,
  color: COLORS[i % COLORS.length]!,
  delay: 300 + Math.floor(Math.random() * 500),
}));

const loadedCache = new Set<number>();
const loadingSet = new Set<number>();

function startLoading(ids: number[]) {
  for (const id of ids) {
    if (loadedCache.has(id) || loadingSet.has(id)) continue;
    loadingSet.add(id);
    const item = SIM_DATA.find(d => d.id === id);
    setTimeout(() => {
      loadedCache.add(id);
      loadingSet.delete(id);
    }, item?.delay ?? 500);
  }
}

function resetLoadingCache() {
  loadedCache.clear();
  loadingSet.clear();
}

function SimCell({ item }: { item: SimItem }) {
  const [loaded, setLoaded] = useState(loadedCache.has(item.id));
  const intervalRef = useRef<ReturnType<typeof setInterval>>();
  const prevIdRef = useRef(item.id);

  useEffect(() => {
    if (prevIdRef.current !== item.id) {
      prevIdRef.current = item.id;
      setLoaded(loadedCache.has(item.id));
    }
    startLoading([item.id]);
    const poll = setInterval(() => {
      if (loadedCache.has(item.id)) {
        setLoaded(true);
        clearInterval(poll);
      }
    }, 50);
    intervalRef.current = poll;
    return () => clearInterval(intervalRef.current);
  }, [item.id]);

  return (
    <View style={S.simCell}>
      <View style={[S.simThumb, loaded ? { backgroundColor: item.color } : S.simThumbPlaceholder]}>
        {!loaded && <View style={S.shimmer} />}
        {loaded && <Text style={S.simThumbText}>{item.id}</Text>}
      </View>
      <View style={S.cellBody}>
        <Text style={S.cellTitle}>Item {item.id}</Text>
        <Text style={S.cellSub}>{loaded ? `Loaded (${item.delay}ms)` : 'Loading...'}</Text>
      </View>
    </View>
  );
}

function CVSimulated() {
  const onPrefetch = useCallback((keys: string[]) => {
    startLoading(keys.map(k => parseInt(k, 10)).filter(n => !isNaN(n)));
  }, []);
  return (
    <Riff
      data={SIM_DATA}
      keyExtractor={item => String(item.id)}
      renderItem={({ item }) => <SimCell item={item} />}
      itemHeight={SIM_H}
      onPrefetch={onPrefetch}
      prefetchAhead={12}
    />
  );
}

function FlashSimulated() {
  return (
    <FlashList
      data={SIM_DATA}
      keyExtractor={item => String(item.id)}
      renderItem={({ item }) => <SimCell item={item} />}
      estimatedItemSize={SIM_H}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// REAL IMAGES
// ═══════════════════════════════════════════════════════════════════════════════

const IMG_COUNT = 500;
const IMG_SIZE = 600;
const IMG_H = 88;

type ImgItem = { id: number; uri: string };

const IMG_DATA: ImgItem[] = Array.from({ length: IMG_COUNT }, (_, i) => ({
  id: i,
  uri: `https://picsum.photos/seed/cv${i}/${IMG_SIZE}/${IMG_SIZE}`,
}));

function ImgCell({ item }: { item: ImgItem }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const prevIdRef = useRef(item.id);

  if (prevIdRef.current !== item.id) {
    prevIdRef.current = item.id;
    if (status !== 'loading') setStatus('loading');
  }

  return (
    <View style={S.imgCell}>
      <View style={S.imgWrap}>
        {status !== 'loaded' && (
          <View style={S.imgPlaceholder}>
            {status === 'loading' && <View style={S.shimmer} />}
            {status === 'error' && <Text style={S.errorText}>!</Text>}
          </View>
        )}
        <Image
          source={{ uri: item.uri }}
          style={[S.imgThumb, status !== 'loaded' && S.imgHidden]}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
        />
      </View>
      <View style={S.cellBody}>
        <Text style={S.cellTitle}>Photo {item.id}</Text>
        <Text style={S.cellSub}>
          {status === 'loaded' ? 'Loaded' : status === 'error' ? 'Failed' : 'Downloading...'}
        </Text>
        <Text style={S.cellUri}>{IMG_SIZE}x{IMG_SIZE}px</Text>
      </View>
    </View>
  );
}

function CVImages() {
  const onPrefetch = useCallback((keys: string[]) => {
    for (const key of keys) {
      const id = parseInt(key, 10);
      if (!isNaN(id) && id < IMG_DATA.length) {
        Image.prefetch(IMG_DATA[id]!.uri);
      }
    }
  }, []);
  return (
    <Riff
      data={IMG_DATA}
      keyExtractor={item => String(item.id)}
      renderItem={({ item }) => <ImgCell item={item} />}
      itemHeight={IMG_H}
      onPrefetch={onPrefetch}
      prefetchAhead={12}
    />
  );
}

function FlashImages() {
  return (
    <FlashList
      data={IMG_DATA}
      keyExtractor={item => String(item.id)}
      renderItem={({ item }) => <ImgCell item={item} />}
      estimatedItemSize={IMG_H}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB
// ═══════════════════════════════════════════════════════════════════════════════

type SubTab = 'simulated' | 'images';

export default function PrefetchTab({ mode }: { mode: 'cv' | 'flash' }) {
  const [subTab, setSubTab] = useState<SubTab>('simulated');
  const prevModeRef = useRef(mode);

  // Reset synchronously BEFORE render so cells see an empty cache
  if (prevModeRef.current !== mode) {
    prevModeRef.current = mode;
    resetLoadingCache();
  }

  return (
    <View style={S.root}>
      {/* Sub-tab picker */}
      <View style={S.subTabRow}>
        <Pressable
          style={[S.subTab, subTab === 'simulated' && S.subTabActive]}
          onPress={() => setSubTab('simulated')}
        >
          <Text style={[S.subTabText, subTab === 'simulated' && S.subTabTextActive]}>
            Simulated Delay
          </Text>
        </Pressable>
        <Pressable
          style={[S.subTab, subTab === 'images' && S.subTabActive]}
          onPress={() => setSubTab('images')}
        >
          <Text style={[S.subTabText, subTab === 'images' && S.subTabTextActive]}>
            Real Images
          </Text>
        </Pressable>
      </View>

      {/* Callout */}
      <View style={S.callout}>
        <Text style={S.calloutText}>
          {subTab === 'simulated'
            ? 'Simulated 300–800ms delay per item. Mimics API call or image decode time.'
            : `Real ${IMG_SIZE}x${IMG_SIZE} images from picsum.photos. Best on device with throttled network.`}
        </Text>
      </View>

      {/* Hint */}
      <Text style={S.hint}>
        {mode === 'cv'
          ? subTab === 'simulated'
            ? 'onPrefetch fires 12x ahead → data pre-loaded before cell mounts.'
            : 'Image.prefetch() warms native cache 12x viewport ahead → instant display on mount.'
          : subTab === 'simulated'
            ? 'No prefetch API → loading starts on mount/rebind. Full delay each time.'
            : 'No prefetch API → image download starts on mount/rebind. Recycled view, new URL.'}
      </Text>

      {/* List */}
      <View style={S.content}>
        {subTab === 'simulated' && mode === 'cv'    && <CVSimulated />}
        {subTab === 'simulated' && mode === 'flash'  && <FlashSimulated />}
        {subTab === 'images'    && mode === 'cv'    && <CVImages />}
        {subTab === 'images'    && mode === 'flash'  && <FlashImages />}
      </View>
    </View>
  );
}

const S = StyleSheet.create({
  root: { flex: 1 },
  content: { flex: 1 },

  // Sub-tab picker
  subTabRow: { flexDirection: 'row', paddingHorizontal: 8, paddingTop: 6, gap: 6 },
  subTab: { flex: 1, paddingVertical: 6, borderRadius: 6,
            backgroundColor: '#1a1a1a', alignItems: 'center' },
  subTabActive: { backgroundColor: '#1e3a1e' },
  subTabText: { fontSize: 11, fontWeight: '600', color: '#555' },
  subTabTextActive: { color: '#4ade80' },

  // Callout
  callout: { marginHorizontal: 8, marginTop: 6, backgroundColor: '#1a1a2a',
             borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  calloutText: { fontSize: 11, color: '#93c5fd' },

  // Hint
  hint: { fontSize: 11, color: '#4a5568', paddingHorizontal: 12, paddingVertical: 6 },

  // Simulated cells
  simCell: { height: 72, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
             borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222' },
  simThumb: { width: 48, height: 48, borderRadius: 8, alignItems: 'center',
              justifyContent: 'center', marginRight: 12 },
  simThumbPlaceholder: { backgroundColor: '#1a1a1a' },
  simThumbText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  // Image cells
  imgCell: { height: 88, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
             borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222' },
  imgWrap: { width: 64, height: 64, borderRadius: 8, overflow: 'hidden', marginRight: 12 },
  imgThumb: { width: 64, height: 64 },
  imgHidden: { position: 'absolute', opacity: 0 },
  imgPlaceholder: { width: 64, height: 64, backgroundColor: '#1a1a1a', borderRadius: 8,
                    alignItems: 'center', justifyContent: 'center' },

  // Shared
  shimmer: { width: 20, height: 3, backgroundColor: '#333', borderRadius: 2 },
  errorText: { color: '#f87171', fontSize: 16, fontWeight: '700' },
  cellBody: { flex: 1 },
  cellTitle: { fontSize: 13, fontWeight: '600', color: '#e2e8f0' },
  cellSub: { fontSize: 11, color: '#4a5568', marginTop: 1 },
  cellUri: { fontSize: 9, color: '#333', marginTop: 1, fontFamily: 'Menlo' },
});
