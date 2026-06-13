#import "RNRiffCell.h"

@implementation RNRiffCell {
  UIView * __weak _adoptedView;
}

- (UIView *)adoptedView { return _adoptedView; }

- (void)adoptView:(UIView *)view
{
  NSAssert(view != nil, @"RNRiffCell: adoptView: called with nil");
  view.frame = self.contentView.bounds;
  view.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  [self.contentView addSubview:view];
  _adoptedView = view;
}

- (nullable UIView *)releaseAdoptedView
{
  UIView *view = _adoptedView;
  if (view) {
    [view removeFromSuperview];
    _adoptedView = nil;
  }
  return view;
}

- (void)prepareForReuse
{
  [super prepareForReuse];
  // Do NOT release adoptedView here — the container coordinates reuse by
  // calling releaseAdoptedView before dequeueing a cell for new content.
  // Releasing here would race against the container's bookkeeping.
}

@end
