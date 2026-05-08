#pragma once

#import <React/RCTViewComponentView.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * RNOrthogonalSectionView — Fabric view for a horizontally-scrolling section
 * inside the main vertical CollectionView.
 *
 * Wraps a UIScrollView (horizontal). Items belonging to this H-section are
 * Fabric children of this view; they are positioned absolutely along the H
 * axis using coordinates from the shared LayoutCache.
 *
 * On every H scroll tick, fires onHScroll({ sectionIndex, scrollX }) so JS
 * can call processHScroll(sectionIndex, scrollX) to update the render range.
 */
@interface RNOrthogonalSectionView : RCTViewComponentView <UIScrollViewDelegate>

@end

NS_ASSUME_NONNULL_END
