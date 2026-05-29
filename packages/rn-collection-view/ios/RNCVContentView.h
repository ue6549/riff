#pragma once
#import <UIKit/UIKit.h>

/**
 * Content view for RNCollectionViewContainerView.
 *
 * Overrides hitTest:withEvent: to check visually-elevated children (layer.zPosition > 0)
 * before the normal reverse-subview-index walk. UIKit's default hit-test uses subview
 * array order; layer.zPosition only affects CALayer rendering. Sticky headers/footers
 * set zPosition=100 when their transform is active, but may sit at a lower array index
 * than later-mounted cells that overlap the same visual area — causing those cells to
 * steal touches. The priority pass ensures sticky views win touch dispatch whenever
 * they are visually on top.
 */
@interface RNCVContentView : UIView
@end
