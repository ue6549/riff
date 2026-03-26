#pragma once

#import <React/RCTViewComponentView.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * RNScrollCoordinatedViewView — UI-thread scroll-driven positioning.
 *
 * Fabric positions this view at its natural layout Y (like any cell).
 * Internally, it observes the nearest ancestor UIScrollView's contentOffset
 * via KVO and applies a CATransform3D translateY to its content layer.
 *
 * Because the transform is internal to this view, Fabric never resets it —
 * Fabric only manages the outer frame (position + size from Yoga).
 *
 * The KVO callback fires on the UI thread, in the same run loop iteration
 * as the scroll event — zero frame delay.
 *
 * Behaviours:
 *   sticky: translateY = max(0, scrollY - naturalY)
 *   push:   translateY = max(0, min(scrollY - naturalY, boundaryY - naturalY - headerHeight))
 */
@interface RNScrollCoordinatedViewView : RCTViewComponentView

@end

NS_ASSUME_NONNULL_END
