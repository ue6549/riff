/**
 * Re-export of the RNOrthogonalSectionView codegen spec.
 *
 * Must live in example/components/ so codegenNativeComponent resolves
 * react-native from the example app's node_modules (not the library's).
 * Same dual-registry pattern as RNCollectionViewContainerNativeComponent.ts.
 */
import type { ViewProps, HostComponent } from 'react-native';
import type {
  Float,
  Int32,
  DirectEventHandler,
} from 'react-native/Libraries/Types/CodegenTypes';
import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';

type OnHScrollEvent = Readonly<{
  sectionIndex: Int32;
  scrollX: Float;
}>;

interface NativeProps extends ViewProps {
  sectionIndex?: Int32;
  contentWidth?: Float;
  onHScroll?: DirectEventHandler<OnHScrollEvent>;
}

export default codegenNativeComponent<NativeProps>(
  'RNOrthogonalSectionView',
) as HostComponent<NativeProps>;
