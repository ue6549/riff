/**
 * RNCollectionViewContainer — Fabric component with custom ShadowNode.
 *
 * This native component owns a UIScrollView internally and provides:
 * - Zero-frame measurement correction via ShadowNode layout() override
 * - Scroll offset correction when items above viewport change height
 * - Content size management
 *
 * The ShadowNode reads Yoga-computed child heights during the layout phase
 * and repositions children using the C++ layout engine — all within a single
 * Fabric commit cycle, eliminating the native→JS→native measurement roundtrip.
 *
 * Props:
 *   layoutCacheId    — integer key for static LayoutCache registry (ShadowNode lookup)
 *   layoutCacheVersion — bumped when JS enriches cache (triggers Fabric re-commit)
 *   estimatedItemHeight — fallback height for items not in LayoutCache
 *   layoutType       — which layout engine to use ('list' | 'grid' | 'masonry' | 'flow')
 *   columns          — number of columns (grid/masonry)
 *   columnSpacing    — horizontal spacing between columns
 *   rowSpacing       — vertical spacing between rows (or itemSpacing for list)
 *   sectionInsetTop/Bottom/Left/Right — content insets
 *   maintainVisibleContentPosition — opt-in scroll offset correction (default true)
 *   onScroll         — scroll event forwarded to JS for render range computation
 */
import type { ViewProps, HostComponent } from 'react-native';
import type { WithDefault, Float, Int32, DirectEventHandler } from 'react-native/Libraries/Types/CodegenTypes';
type OnScrollEvent = Readonly<{
    contentOffset: Readonly<{
        x: Float;
        y: Float;
    }>;
    contentSize: Readonly<{
        width: Float;
        height: Float;
    }>;
    layoutMeasurement: Readonly<{
        width: Float;
        height: Float;
    }>;
}>;
interface NativeProps extends ViewProps {
    layoutType?: WithDefault<'list' | 'grid' | 'masonry' | 'flow' | 'compositional', 'list'>;
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
    onScrollBeginDrag?: DirectEventHandler<OnScrollEvent>;
    onScrollEndDrag?: DirectEventHandler<OnScrollEvent>;
    onMomentumScrollBegin?: DirectEventHandler<OnScrollEvent>;
    onMomentumScrollEnd?: DirectEventHandler<OnScrollEvent>;
}
declare const _default: HostComponent<NativeProps>;
export default _default;
