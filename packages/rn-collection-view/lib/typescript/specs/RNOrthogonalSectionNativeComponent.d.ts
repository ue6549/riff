/**
 * RNOrthogonalSectionView — Fabric component for horizontal-scrolling sections
 * within the main vertical CollectionView.
 *
 * Each H-section is a UIScrollView (horizontal=true) placed at the section's
 * Y position in the outer container. Items belonging to the H-section are
 * Fabric children of this view, absolutely positioned along the H axis.
 *
 * Props:
 *   sectionIndex  — which compositional section this view represents
 *   contentWidth  — total H content size; sets UIScrollView.contentSize.width
 *
 * Events:
 *   onHScroll     — fires on every H scroll tick; payload includes sectionIndex
 *                   and scrollX so JS can call processHScroll() JSI
 */
import type { ViewProps, HostComponent } from 'react-native';
import type { Float, Int32, DirectEventHandler } from 'react-native/Libraries/Types/CodegenTypes';
type OnHScrollEvent = Readonly<{
    sectionIndex: Int32;
    scrollX: Float;
}>;
interface NativeProps extends ViewProps {
    /** Index of the compositional section this orthogonal view represents. */
    sectionIndex?: Int32;
    /** Total horizontal content width (sum of all item widths + spacing + insets). */
    contentWidth?: Float;
    /** Fired on every H scroll tick. */
    onHScroll?: DirectEventHandler<OnHScrollEvent>;
}
declare const _default: HostComponent<NativeProps>;
export default _default;
