#import "RNCVScrollObserver.h"
#import "../cpp/CollectionViewModule.h"

@implementation RNCVScrollObserver {
  __weak UIScrollView                                              *_scrollView;
  __weak id<UIScrollViewDelegate>                                   _originalDelegate;
  std::shared_ptr<facebook::react::CollectionViewModule>            _cppModule;
}

- (instancetype)initWithScrollView:(UIScrollView *)scrollView
                         cppModule:(std::shared_ptr<facebook::react::CollectionViewModule>)module
{
  self = [super init];
  if (self) {
    _scrollView        = scrollView;
    _originalDelegate  = scrollView.delegate;   // save RCTScrollView's delegate
    _cppModule         = module;
    scrollView.delegate = self;                  // insert ourselves
  }
  return self;
}

- (void)detach
{
  UIScrollView *sv = _scrollView;
  if (sv && sv.delegate == self) {
    sv.delegate = _originalDelegate;
  }
  _cppModule.reset();
}

// ── Core intercept — called on UI thread ─────────────────────────────────────

- (void)scrollViewDidScroll:(UIScrollView *)scrollView
{
  if (_cppModule) {
    CGPoint off = scrollView.contentOffset;
    _cppModule->updateScrollPosition(off.y, off.x);
  }
  if ([_originalDelegate respondsToSelector:@selector(scrollViewDidScroll:)]) {
    [_originalDelegate scrollViewDidScroll:scrollView];
  }
}

// ── Transparent forwarding of all other delegate methods ─────────────────────

- (BOOL)respondsToSelector:(SEL)aSelector
{
  return [super respondsToSelector:aSelector]
      || [_originalDelegate respondsToSelector:aSelector];
}

- (NSMethodSignature *)methodSignatureForSelector:(SEL)aSelector
{
  NSMethodSignature *sig = [super methodSignatureForSelector:aSelector];
  if (!sig) {
    sig = [(id)_originalDelegate methodSignatureForSelector:aSelector];
  }
  return sig;
}

- (void)forwardInvocation:(NSInvocation *)invocation
{
  if ([_originalDelegate respondsToSelector:invocation.selector]) {
    [invocation invokeWithTarget:_originalDelegate];
  }
}

@end
