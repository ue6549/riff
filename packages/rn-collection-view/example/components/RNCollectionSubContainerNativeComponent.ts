/**
 * Re-export of the RNCollectionSubContainer codegen spec.
 *
 * Must live in example/components/ so codegenNativeComponent resolves
 * react-native from the example app's node_modules (not the library's).
 * Same dual-registry pattern as RNCollectionViewContainerNativeComponent.ts
 * and RNOrthogonalSectionNativeComponent.ts.
 */
import type { ViewProps, HostComponent } from 'react-native';
import type {
  WithDefault,
  Float,
  Int32,
  DirectEventHandler,
} from 'react-native/Libraries/Types/CodegenTypes';
import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';

type OnSubScrollEvent = Readonly<{
  sectionIndex: Int32;
  scrollX: Float;
  scrollY: Float;
}>;

interface NativeProps extends ViewProps {
  layoutCacheId?: Int32;
  sectionIndex?: Int32;
  scrollDirection?: WithDefault<'vertical' | 'horizontal' | 'none', 'none'>;
  contentWidth?: Float;
  contentHeight?: Float;
  layoutCacheVersion?: Int32;
  onSubScroll?: DirectEventHandler<OnSubScrollEvent>;
}

export default codegenNativeComponent<NativeProps>(
  'RNCollectionSubContainer',
) as HostComponent<NativeProps>;
