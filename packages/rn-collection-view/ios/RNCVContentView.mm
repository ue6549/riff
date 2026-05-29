#import "RNCVContentView.h"

@implementation RNCVContentView

- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event
{
    if (!self.userInteractionEnabled || self.isHidden || self.alpha < 0.01) return nil;
    if (![self pointInside:point withEvent:event]) return nil;

    // First pass: visually-elevated views (sticky headers/footers, zPosition > 0).
    // These must win touch dispatch regardless of their position in the subview array.
    for (UIView *sub in [self.subviews reverseObjectEnumerator]) {
        if (sub.layer.zPosition <= 0) continue;
        CGPoint p = [sub convertPoint:point fromView:self];
        UIView *hit = [sub hitTest:p withEvent:event];
        if (hit) return hit;
    }

    // Second pass: all other views, in normal reverse-index order.
    for (UIView *sub in [self.subviews reverseObjectEnumerator]) {
        if (sub.layer.zPosition > 0) continue; // already checked above
        CGPoint p = [sub convertPoint:point fromView:self];
        UIView *hit = [sub hitTest:p withEvent:event];
        if (hit) return hit;
    }

    return self;
}

@end
