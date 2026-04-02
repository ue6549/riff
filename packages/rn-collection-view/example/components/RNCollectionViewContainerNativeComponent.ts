/**
 * Re-export of the RNCollectionViewContainer codegen spec.
 *
 * The canonical spec lives in src/specs/ (required by codegenConfig.jsSrcsDir
 * for pod install / codegen). But at runtime, if a test screen imports
 * the spec from that path, Metro resolves `react-native` to the library's own
 * node_modules/react-native — a separate instance from the example app's.
 * The component registers in the wrong ReactNativeViewConfigRegistry and the
 * render fails with "View config getter callback must be a function".
 *
 * This re-export file lives in example/components/ alongside CollectionView.tsx.
 * When Babel's codegen plugin transforms the codegenNativeComponent call, the
 * require('react-native/...') is resolved from THIS directory — which walks up
 * to example/node_modules/react-native (the single correct instance).
 *
 * Same pattern as RNMeasuredCellNativeComponent.ts.
 */
import type { ViewProps, HostComponent } from 'react-native';
import type {
  WithDefault,
  Float,
  Int32,
  DirectEventHandler,
} from 'react-native/Libraries/Types/CodegenTypes';
import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';

type OnScrollEvent = Readonly<{
  contentOffset: Readonly<{ x: Float; y: Float }>;
  contentSize: Readonly<{ width: Float; height: Float }>;
  layoutMeasurement: Readonly<{ width: Float; height: Float }>;
}>;

interface NativeProps extends ViewProps {
  layoutType?: WithDefault<'list' | 'grid' | 'masonry' | 'flow', 'list'>;
  columns?: Int32;
  columnSpacing?: Float;
  rowSpacing?: Float;
  sectionInsetTop?: Float;
  sectionInsetBottom?: Float;
  sectionInsetLeft?: Float;
  sectionInsetRight?: Float;
  layoutCacheId?: Int32;
  layoutCacheVersion?: Int32;
  estimatedItemHeight?: Float;
  renderRangeStart?: Int32;
  renderRangeEnd?: Int32;
  maintainVisibleContentPosition?: WithDefault<boolean, true>;
  horizontal?: WithDefault<boolean, false>;
  scrollEnabled?: WithDefault<boolean, true>;
  bounces?: WithDefault<boolean, true>;
  showsVerticalScrollIndicator?: WithDefault<boolean, true>;
  scrollEventThrottle?: Float;
  onScroll?: DirectEventHandler<OnScrollEvent>;
}

export default codegenNativeComponent<NativeProps>(
  'RNCollectionViewContainer',
) as HostComponent<NativeProps>;
