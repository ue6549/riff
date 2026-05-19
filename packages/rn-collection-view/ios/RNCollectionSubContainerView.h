#pragma once

#import <React/RCTViewComponentView.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * RNCollectionSubContainerView — generic native host for a single section of
 * the parent CollectionView. Used by orthogonal sections, radial, spiral,
 * carousel3D, and any future custom layouts.
 *
 * Owns a `_contentView` that holds cells as subviews, optionally embedded in
 * a UIScrollView when `scrollDirection != 'none'`. Frames + transforms +
 * opacity + zIndex are applied natively from a CollectionSubContainerState
 * driven by the C++ ShadowNode — no JS round-trip on scroll.
 *
 * Scroll events (when scrollable) fire onSubScroll, which JS uses to invoke
 * the layout's processScroll() (e.g. radial drives rotation from scroll).
 */
@interface RNCollectionSubContainerView : RCTViewComponentView <UIScrollViewDelegate>

/// Set to YES by the parent container's applyPositionsFromState when the
/// ShadowNode has positioned this wrapper from the LayoutCache. Prevents
/// Fabric's updateLayoutMetrics: from overwriting that position with Yoga's
/// sequential flex-column origin.
@property (nonatomic) BOOL shadowNodePositioned;

/// Cells live as subviews of this view. Specialized wrappers (e.g. carousel)
/// can read it to compose additional decorations on top.
@property (nonatomic, readonly) UIView *contentView;

@end

NS_ASSUME_NONNULL_END
