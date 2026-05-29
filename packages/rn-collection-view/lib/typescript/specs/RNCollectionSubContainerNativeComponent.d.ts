/**
 * RNCollectionSubContainer — generic Fabric component for ANY layout that
 * owns a slice of items inside a parent CollectionView.
 *
 * This is the framework component for H-2 and beyond. It hosts items in its
 * own coordinate space, applies frames + transforms + opacity + zIndex from
 * a C++ State object (CollectionSubContainerState), and optionally provides
 * a UIScrollView for layouts that need scroll-driven recomputation.
 *
 * Specialized wrappers compose this:
 *   - RNOrthogonalSectionView  → uses this + horizontal UIScrollView for H lists/grids
 *   - radial / spiral / carousel3D → use this + vertical UIScrollView; scroll drives layout
 *   - hex (C++)                → uses this + no scroll (static tiling)
 *
 * Frames & transforms are applied NATIVELY (no JS bridge), driven by a
 * dedicated CollectionSubContainerShadowNode that performs Yoga measurement
 * + cascade for its own children (scoped, not the entire collection).
 *
 * Props:
 *   layoutCacheId   — integer key for the LayoutCache registry (shared with parent)
 *   sectionIndex    — which slice of the cache this sub-container owns
 *   scrollDirection — 'vertical' | 'horizontal' | 'none'. When != 'none', the
 *                     view embeds a UIScrollView and forwards scroll events.
 *   contentWidth    — total content width along the X axis (STANDALONE ONLY).
 *                     For compositional H sections (H-2.1), the C++ ShadowNode
 *                     reads section size from the cache `h-section-cw-{N}` /
 *                     `h-section-wrapper-{N}` entries directly, NOT from these
 *                     props. Round-tripping section size through JS as a prop
 *                     created a Fabric-commit feedback loop that broke iOS
 *                     bounce animations and JS performance during deceleration.
 *                     Standalone consumers (CollectionSubContainer.tsx for
 *                     custom layouts like radial / spiral / carousel3D) still
 *                     pass these — they have no compositional cache entry.
 *   contentHeight   — total content height along the Y axis. Same semantics as
 *                     contentWidth above.
 *
 * Events:
 *   onSubScroll     — fires on every scroll tick when scrollDirection != 'none'.
 *                     JS handler should call processSubScroll(sectionIndex, x, y)
 *                     JSI to drive layout-cache update + window computation.
 */
import type { ViewProps, HostComponent } from 'react-native';
import type { WithDefault, Float, Int32, DirectEventHandler } from 'react-native/Libraries/Types/CodegenTypes';
type OnSubScrollEvent = Readonly<{
    sectionIndex: Int32;
    scrollX: Float;
    scrollY: Float;
}>;
interface NativeProps extends ViewProps {
    /** Integer key for the LayoutCache registry. Same as parent CollectionView's cache. */
    layoutCacheId?: Int32;
    /** Section index this sub-container owns (slice of the parent cache). */
    sectionIndex?: Int32;
    /** Scroll axis. 'none' = static tiling, no scroll view. */
    scrollDirection?: WithDefault<'vertical' | 'horizontal' | 'none', 'none'>;
    /**
     * Total content width along the X axis (STANDALONE ONLY).
     * Compositional H sections read from cache `h-section-cw-{N}` instead.
     * See file-header doc block for the H-2.1 round-trip-cut rationale.
     */
    contentWidth?: Float;
    /**
     * Total content height along the Y axis (STANDALONE ONLY).
     * Compositional H sections read from cache `h-section-wrapper-{N}` instead.
     */
    contentHeight?: Float;
    /** Bumped when the layout cache slice for this sub-container changes; triggers re-commit. */
    layoutCacheVersion?: Int32;
    /** Fired on every scroll tick when scrollDirection != 'none'. */
    onSubScroll?: DirectEventHandler<OnSubScrollEvent>;
}
declare const _default: HostComponent<NativeProps>;
export default _default;
