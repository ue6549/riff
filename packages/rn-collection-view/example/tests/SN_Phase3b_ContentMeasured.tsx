/**
 * ShadowNode Phase 3b — Content-Measured Variable Heights.
 *
 * Unlike Phase 3 (explicit heights), this test uses NO height prop on children.
 * Each child's height is determined by its TEXT CONTENT wrapping — Yoga measures
 * it, and the ShadowNode reads the measured height to compute Y positions.
 *
 * This is the real proof of the ShadowNode approach: zero-frame correct
 * positioning of content-measured cells.
 */
import React, {useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import RNCollectionViewContainer from '@riff/specs/RNCollectionViewContainerNativeComponent';

const COLORS = [
  '#e63946',
  '#2a9d8f',
  '#e9c46a',
  '#f4a261',
  '#264653',
  '#457b9d',
];

// Variable-length text content — height comes from content, not from a style prop.
const ITEMS = [
  {id: 0, text: 'Short item'},
  {id: 1, text: 'This item has a bit more text that should wrap to two lines on most screen sizes to verify multi-line measurement'},
  {id: 2, text: 'Tiny'},
  {id: 3, text: 'A longer paragraph of text to really test the Yoga measurement engine. This should wrap to several lines and produce a significantly taller cell than the others. The ShadowNode must read this measured height correctly and position the next item below it with proper spacing.'},
  {id: 4, text: 'Medium length content here'},
  {id: 5, text: 'Another short one'},
  {id: 6, text: 'This is an item with enough text to likely wrap to about three lines on an iPhone screen, which gives us a nice intermediate height to verify positioning accuracy across variable-height items'},
  {id: 7, text: 'One liner'},
  {id: 8, text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.'},
  {id: 9, text: 'Small'},
  {id: 10, text: 'Two lines of text here which should be enough to test a basic multi-line cell in this collection view'},
  {id: 11, text: 'A very long item that contains multiple paragraphs worth of content. First we discuss the architecture of the ShadowNode, which reads Yoga-measured heights during its layout() override. Then we note that positions are stored in state and delivered to the native view in the same Fabric commit cycle. Finally, the native view applies these positions in layoutSubviews, producing frame-1 correct layout with zero async gaps.'},
  {id: 12, text: 'Quick'},
  {id: 13, text: 'Mid-size text block with a few sentences. This should produce a cell that is somewhere between the short and long items.'},
  {id: 14, text: 'End'},
  {id: 15, text: 'Another multi-line text to pad the list. Testing that scroll works with content-measured items and that items far down the list are positioned correctly by accumulating all previous heights.'},
  {id: 16, text: 'X'},
  {id: 17, text: 'This item tests that even after scrolling through many variable-height items, the accumulated Y offset remains correct. Any small error in reading Yoga heights would compound here.'},
  {id: 18, text: 'Almost done'},
  {id: 19, text: 'Final item with moderate length text to close out the list and verify the total content height is correct.'},
];

const ROW_SPACING = 8;
const INSET_LEFT = 8;
const INSET_RIGHT = 8;
const INSET_TOP = 8;

export default function SNPhase3bContentMeasured() {
  const [scrollY, setScrollY] = useState(0);
  const [scrollCount, setScrollCount] = useState(0);

  return (
    <View style={S.root}>
      <View style={S.header}>
        <Text style={S.title}>Phase 3b — Content-Measured Heights</Text>
        <Text style={S.subtitle}>
          No explicit height prop. Yoga measures from text content.
        </Text>
        <Text style={S.metric}>
          Items: {ITEMS.length} | ScrollY: {scrollY.toFixed(0)} | Events:{' '}
          {scrollCount}
        </Text>
      </View>

      <RNCollectionViewContainer
        style={S.container}
        rowSpacing={ROW_SPACING}
        sectionInsetTop={INSET_TOP}
        sectionInsetLeft={INSET_LEFT}
        sectionInsetRight={INSET_RIGHT}
        scrollEventThrottle={16}
        bounces={true}
        onScroll={(e: any) => {
          const y = e.nativeEvent.contentOffset.y;
          setScrollY(y);
          setScrollCount(c => c + 1);
        }}>
        {ITEMS.map((item, i) => (
          <View
            key={item.id}
            collapsable={false}
            style={[S.item, {backgroundColor: COLORS[i % COLORS.length]}]}>
            <Text style={S.itemTitle}>Item {item.id}</Text>
            <Text style={S.itemText}>{item.text}</Text>
          </View>
        ))}
      </RNCollectionViewContainer>
    </View>
  );
}

const S = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0a0a0a'},
  header: {
    padding: 12,
    backgroundColor: '#111',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  title: {fontSize: 14, fontWeight: '700', color: '#e2e8f0'},
  subtitle: {fontSize: 11, color: '#94a3b8', marginTop: 2},
  metric: {
    fontSize: 11,
    color: '#94a3b8',
    fontFamily: 'Menlo',
    marginTop: 4,
  },
  container: {flex: 1},
  item: {
    borderRadius: 8,
    padding: 12,
  },
  itemTitle: {fontSize: 13, fontWeight: '700', color: '#fff', marginBottom: 4},
  itemText: {fontSize: 14, color: 'rgba(255,255,255,0.85)', lineHeight: 20},
});
