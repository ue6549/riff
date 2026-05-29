#pragma once

#import <React/RCTViewComponentView.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * RNMeasuredCellView — M4.2 Fabric view for zero-flicker cell measurement.
 *
 * When Fabric commits a layout pass, UIKit calls -layoutSubviews on every view
 * whose frame changed.  At that point self.bounds already reflects the Yoga-
 * computed content height (no fixed height style is set on this view, so Yoga
 * sizes it intrinsically from its children).  We fire the onMeasured event
 * synchronously here — BEFORE the native transaction reaches the screen — so
 * CollectionView.tsx receives the actual height in the same commit cycle.
 *
 * This eliminates the JS measurement loop:
 *   useLayoutEffect → ref.measure() (bridge call) → RAF batch → setMeasuredVersion
 * and replaces it with a single direct event that arrives before the first paint.
 */
@interface RNMeasuredCellView : RCTViewComponentView

/**
 * Set to YES by RNCollectionViewContainerView.applyPositionsFromState when this
 * cell is a direct container child and the ShadowNode is the position authority.
 * When NO (default), Fabric/Yoga CSS absolute position is used — this is the case
 * for H-section cells that are children of RNOrthogonalSectionView.
 */
@property (nonatomic) BOOL shadowNodePositioned;

/**
 * Cache key from props — used by applyPositionsFromState: to look up visual
 * attributes (alpha, transform3D, zIndex) from the LayoutCache and apply them
 * to this view's layer after the frame is set.
 */
@property (nonatomic, copy, nullable) NSString *cacheKey;

@end

NS_ASSUME_NONNULL_END
