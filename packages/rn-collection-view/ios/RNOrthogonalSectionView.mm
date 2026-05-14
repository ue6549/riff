#import "RNOrthogonalSectionView.h"

// Codegen-generated helpers (same spec namespace as the rest of the package).
#import <react/renderer/components/RNCollectionViewSpec/ComponentDescriptors.h>
#import <react/renderer/components/RNCollectionViewSpec/EventEmitters.h>
#import <react/renderer/components/RNCollectionViewSpec/Props.h>
#import <react/renderer/components/RNCollectionViewSpec/RCTComponentViewHelpers.h>

#import <React/RCTFabricComponentsPlugins.h>

using namespace facebook::react;

// H-1 debug: gesture/lifecycle tracing for RNOrthogonalSectionView.
// Filter tag: "RNCV-H-GEST". Set macro to 1 to re-enable.
// Kept available for future debugging of H-section gesture/scroll issues.
#define RNCV_HGEST_LOGS 0
#if RNCV_HGEST_LOGS
#define HGEST_LOG(fmt, ...) NSLog(@"RNCV-H-GEST [s%d] " fmt, _sectionIndex, ##__VA_ARGS__)
#define HGEST_LOG_NOIDX(fmt, ...) NSLog(@"RNCV-H-GEST " fmt, ##__VA_ARGS__)
#else
#define HGEST_LOG(fmt, ...) ((void)0)
#define HGEST_LOG_NOIDX(fmt, ...) ((void)0)
#endif

// ── Main-thread hitch detector (process-wide singleton) ──────────────────────
// CADisplayLink ticks at the screen refresh rate (60Hz here, ~16.67ms). When
// a main-thread stall causes a frame to be missed, the gap between two
// consecutive ticks exceeds the frame interval. We log only when the gap
// exceeds 32ms (= at least 1 frame missed) to keep logs quiet on healthy paths.
@interface HGestMainThreadDetector : NSObject
+ (void)startIfNeeded;
@end

@implementation HGestMainThreadDetector {
  CADisplayLink *_link;
  CFTimeInterval _lastTick;
}
+ (instancetype)shared {
  static HGestMainThreadDetector *s;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ s = [HGestMainThreadDetector new]; });
  return s;
}
+ (void)startIfNeeded {
  HGestMainThreadDetector *s = [self shared];
  @synchronized (s) {
    if (s->_link) return;
    s->_link = [CADisplayLink displayLinkWithTarget:s selector:@selector(tick:)];
    s->_lastTick = CACurrentMediaTime();
    [s->_link addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
    HGEST_LOG_NOIDX(@"[hitch] detector started");
  }
}
- (void)tick:(CADisplayLink *)link {
  CFTimeInterval now = link.timestamp;
  CFTimeInterval delta = now - _lastTick;
  _lastTick = now;
  if (delta > 0.032) {
    HGEST_LOG_NOIDX(@"[hitch] main-thread gap %.1fms ending at t=%.3f", delta * 1000.0, now);
  }
}
@end

// H-1 debug: per-second aggregator for Fabric main-thread work.
// Sums mount/unmount/updateProps/layoutSubviews durations across ALL H wrapper
// instances. Flushes once per second so we can see total main-thread work even
// when individual calls are <2ms (which the per-call timing logs gate at).
//
// All increments happen on the main thread, so no atomics are needed.
// The flush timer also runs on the main thread, so reads/resets are safe.
@interface HGestWorkAggregator : NSObject
+ (void)startIfNeeded;
+ (void)addMountMs:(double)ms;
+ (void)addUnmountMs:(double)ms;
+ (void)addUpdatePropsMs:(double)ms;
+ (void)addLayoutSubviewsMs:(double)ms;
+ (void)addHitTestCount;
@end

@implementation HGestWorkAggregator {
  NSTimer  *_timer;
  // Counts and accumulated durations for the current 1-second window.
  uint32_t  _mountN, _unmountN, _updateN, _layoutN, _hitTestN;
  double    _mountMs, _unmountMs, _updateMs, _layoutMs;
}
+ (instancetype)shared {
  static HGestWorkAggregator *s;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ s = [HGestWorkAggregator new]; });
  return s;
}
+ (void)startIfNeeded {
  HGestWorkAggregator *s = [self shared];
  @synchronized (s) {
    if (s->_timer) return;
    s->_timer = [NSTimer scheduledTimerWithTimeInterval:1.0
                                                 target:s
                                               selector:@selector(flush:)
                                               userInfo:nil
                                                repeats:YES];
    HGEST_LOG_NOIDX(@"[work] aggregator started");
  }
}
+ (void)addMountMs:(double)ms        { HGestWorkAggregator *s = [self shared]; s->_mountN++;   s->_mountMs   += ms; }
+ (void)addUnmountMs:(double)ms      { HGestWorkAggregator *s = [self shared]; s->_unmountN++; s->_unmountMs += ms; }
+ (void)addUpdatePropsMs:(double)ms  { HGestWorkAggregator *s = [self shared]; s->_updateN++;  s->_updateMs  += ms; }
+ (void)addLayoutSubviewsMs:(double)ms { HGestWorkAggregator *s = [self shared]; s->_layoutN++; s->_layoutMs += ms; }
+ (void)addHitTestCount               { HGestWorkAggregator *s = [self shared]; s->_hitTestN++; }
- (void)flush:(NSTimer *)t {
  // Skip log when no activity to keep the stream clean.
  if (_mountN + _unmountN + _updateN + _layoutN + _hitTestN == 0) return;
  HGEST_LOG_NOIDX(@"[work] mount=%u/%.1fms unmount=%u/%.1fms updateProps=%u/%.1fms layoutSubviews=%u/%.1fms hitTest=%u",
                  _mountN, _mountMs,
                  _unmountN, _unmountMs,
                  _updateN, _updateMs,
                  _layoutN, _layoutMs,
                  _hitTestN);
  _mountN = _unmountN = _updateN = _layoutN = _hitTestN = 0;
  _mountMs = _unmountMs = _updateMs = _layoutMs = 0;
}
@end

@interface RNOrthogonalSectionView () <RCTRNOrthogonalSectionViewViewProtocol>
@end

@implementation RNOrthogonalSectionView {
  UIScrollView *_scrollView;
  UIView       *_contentView;
  int32_t       _sectionIndex;
  CGFloat       _contentWidth;
  // Throttle: skip events fired within 16ms of the last one.
  NSTimeInterval _lastScrollEventTime;
}

// ── Fabric registration ─────────────────────────────────────────────────────

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<RNOrthogonalSectionViewComponentDescriptor>();
}

// ── Init ────────────────────────────────────────────────────────────────────

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps =
        std::make_shared<const RNOrthogonalSectionViewProps>();
    _props = defaultProps;

    _sectionIndex = 0;
    _contentWidth = 0;
    _lastScrollEventTime = 0;
    _shadowNodePositioned = NO;

    // Horizontal UIScrollView — fills this view's bounds.
    _scrollView = [[UIScrollView alloc] initWithFrame:self.bounds];
    _scrollView.autoresizingMask =
        UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _scrollView.scrollEnabled        = YES;
    _scrollView.bounces              = YES;
    _scrollView.alwaysBounceHorizontal = YES;
    _scrollView.alwaysBounceVertical   = NO;
    // Lock to horizontal axis once the gesture direction is determined.
    _scrollView.directionalLockEnabled = YES;
    _scrollView.showsHorizontalScrollIndicator = NO;
    _scrollView.showsVerticalScrollIndicator   = NO;
    _scrollView.delegate = self;

    // Content view holds absolutely-positioned cell subviews.
    _contentView = [[UIView alloc] initWithFrame:CGRectZero];
    _contentView.clipsToBounds = NO;
    [_scrollView addSubview:_contentView];

    self.clipsToBounds = YES;
    [self addSubview:_scrollView];

#if RNCV_HGEST_LOGS
    // H-1 debug: KVO on pan gesture state. Logs every state transition. If
    // we see touches arriving but state never leaves Possible (or jumps to
    // Failed/Cancelled), gesture system is being blocked or another
    // recognizer is winning.
    [_scrollView.panGestureRecognizer addObserver:self
                                       forKeyPath:@"state"
                                          options:NSKeyValueObservingOptionNew
                                          context:nil];

    // Start the process-wide main-thread hitch detector and work aggregator.
    [HGestMainThreadDetector startIfNeeded];
    [HGestWorkAggregator    startIfNeeded];
#endif
  }
  return self;
}

- (void)dealloc
{
#if RNCV_HGEST_LOGS
  @try {
    [_scrollView.panGestureRecognizer removeObserver:self forKeyPath:@"state"];
  } @catch (...) {}
#endif
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey,id> *)change
                       context:(void *)context
{
  if ([keyPath isEqualToString:@"state"]) {
    UIGestureRecognizerState state = (UIGestureRecognizerState)
        [change[NSKeyValueChangeNewKey] integerValue];
    NSString *name;
    switch (state) {
      case UIGestureRecognizerStatePossible:  name = @"Possible";  break;
      case UIGestureRecognizerStateBegan:     name = @"Began";     break;
      case UIGestureRecognizerStateChanged:   name = @"Changed";   break;
      case UIGestureRecognizerStateEnded:     name = @"Ended";     break;
      case UIGestureRecognizerStateCancelled: name = @"Cancelled"; break;
      case UIGestureRecognizerStateFailed:    name = @"Failed";    break;
      default:                                name = @"?";         break;
    }
    HGEST_LOG(@"panGesture state -> %@", name);
  }
}

// H-1 debug: hit test logging.
// Logs only when the scroll view is idle (not dragging or decelerating) to
// avoid spam during active scrolling. If the user is touching this section but
// no hitTest log fires, touches aren't being routed to this wrapper at all
// (likely captured by parent V scroll's gesture recognizer or some other view).
// If hitTest fires but no panGesture state transition follows, the gesture
// recognizer is being denied (delegate method, or competing recognizer wins).
- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event
{
  UIView *result = [super hitTest:point withEvent:event];
  // Count every hit test that lands inside this wrapper (regardless of touch
  // phase) — gives us a per-second rate so we can tell whether iOS is
  // routing touch events into this view at all.
#if RNCV_HGEST_LOGS
  if (result) {
    [HGestWorkAggregator addHitTestCount];
  }
#endif
  // Verbose log only on fresh finger-down when the scroll view is idle —
  // tells us if the gesture system "saw" a new touch but failed to start.
  if (result &&
      event &&
      event.type == UIEventTypeTouches &&
      !_scrollView.dragging &&
      !_scrollView.decelerating) {
    NSSet<UITouch *> *touches = [event touchesForView:result];
    UITouch *t = touches.anyObject;
    if (t && t.phase == UITouchPhaseBegan) {
      HGEST_LOG(@"hitTest pt=(%.0f,%.0f) -> %@ scrollEnabled=%d userIA=%d sv.userIA=%d",
                point.x, point.y,
                NSStringFromClass([result class]),
                _scrollView.scrollEnabled,
                self.userInteractionEnabled,
                _scrollView.userInteractionEnabled);
    }
  }
  return result;
}

// ── Fabric recycling ─────────────────────────────────────────────────────────

- (void)prepareForRecycle
{
  HGEST_LOG(@"prepareForRecycle (cw=%.1f bounds=%@ off=%.1f)",
            _contentWidth, NSStringFromCGRect(self.bounds),
            _scrollView.contentOffset.x);
  [super prepareForRecycle];
  _sectionIndex = 0;
  _contentWidth = 0;
  _lastScrollEventTime = 0;
  _shadowNodePositioned = NO;
  [_scrollView setContentOffset:CGPointZero animated:NO];
  _scrollView.contentSize = CGSizeZero;
  _contentView.frame = CGRectZero;
}

// ── Fabric layout metrics ────────────────────────────────────────────────────
// Prevent Fabric's default updateLayoutMetrics: from overwriting the cache-based
// position set by the container's applyPositionsFromState.  Yoga computes a
// sequential flex-column layout for all container children — wrong for
// compositional-layout sections positioned by LayoutCache.
// We preserve the current native origin and only let Yoga-measured SIZE through.

- (void)updateLayoutMetrics:(const facebook::react::LayoutMetrics &)layoutMetrics
           oldLayoutMetrics:(const facebook::react::LayoutMetrics &)oldLayoutMetrics
{
  auto adjusted = layoutMetrics;
  if (_shadowNodePositioned) {
    adjusted.frame.origin.x = self.frame.origin.x;
    adjusted.frame.origin.y = self.frame.origin.y;
  }
  [super updateLayoutMetrics:adjusted oldLayoutMetrics:oldLayoutMetrics];
}

// ── Child management ─────────────────────────────────────────────────────────
// Fabric mounts H-section cells as children of this view.
// They land in _contentView, absolutely positioned along the H axis.

- (void)mountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView
                          index:(NSInteger)index
{
  CFTimeInterval t0 = CACurrentMediaTime();
  [_contentView insertSubview:childComponentView atIndex:index];
  CFTimeInterval dt = CACurrentMediaTime() - t0;
#if RNCV_HGEST_LOGS
  [HGestWorkAggregator addMountMs:dt * 1000.0];
  if (dt > 0.002) {  // > 2ms
    HGEST_LOG(@"mountChildComponentView idx=%ld took %.1fms", (long)index, dt * 1000.0);
  }
#else
  (void)dt;
#endif
}

- (void)unmountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView
                            index:(NSInteger)index
{
  CFTimeInterval t0 = CACurrentMediaTime();
  [childComponentView removeFromSuperview];
  CFTimeInterval dt = CACurrentMediaTime() - t0;
#if RNCV_HGEST_LOGS
  [HGestWorkAggregator addUnmountMs:dt * 1000.0];
  if (dt > 0.002) {
    HGEST_LOG(@"unmountChildComponentView idx=%ld took %.1fms", (long)index, dt * 1000.0);
  }
#else
  (void)dt;
#endif
}

// ── Props ────────────────────────────────────────────────────────────────────

- (void)updateProps:(const Props::Shared &)props
           oldProps:(const Props::Shared &)oldProps
{
  CFTimeInterval t0 = CACurrentMediaTime();
  [super updateProps:props oldProps:oldProps];

  const auto &p =
      *std::static_pointer_cast<const RNOrthogonalSectionViewProps>(props);

  // Note: at the time updateProps fires for the first time after mount,
  // _sectionIndex is still 0 (init value), so the first log line for any
  // wrapper will report s0 even if it's actually s2. Subsequent logs are
  // correct after _sectionIndex is assigned below.
  if (p.contentWidth != _contentWidth) {
    HGEST_LOG(@"updateProps cw %.1f -> %.1f (bounds=%@ off=%.1f drag=%d decel=%d)",
              _contentWidth, (CGFloat)p.contentWidth,
              NSStringFromCGRect(self.bounds),
              _scrollView.contentOffset.x,
              _scrollView.dragging, _scrollView.decelerating);
  }

  _sectionIndex = p.sectionIndex;

  if (p.contentWidth != _contentWidth) {
    _contentWidth = p.contentWidth;
    // Update scroll content size width; height matches our own bounds height.
    _scrollView.contentSize = CGSizeMake(_contentWidth,
                                         _scrollView.bounds.size.height);
    _contentView.frame = CGRectMake(0, 0, _contentWidth,
                                    _scrollView.bounds.size.height);
  }

  CFTimeInterval dt = CACurrentMediaTime() - t0;
#if RNCV_HGEST_LOGS
  [HGestWorkAggregator addUpdatePropsMs:dt * 1000.0];
  if (dt > 0.002) {
    HGEST_LOG(@"updateProps took %.1fms (drag=%d decel=%d)",
              dt * 1000.0, _scrollView.dragging, _scrollView.decelerating);
  }
#else
  (void)dt;
#endif
}

// ── UIScrollViewDelegate ─────────────────────────────────────────────────────

- (void)scrollViewDidScroll:(UIScrollView *)scrollView
{
  // Throttle to ~60fps (16ms).
  NSTimeInterval now = CACurrentMediaTime();
  if (now - _lastScrollEventTime < 0.016) return;
  _lastScrollEventTime = now;

  if (!_eventEmitter) return;
  auto emitter = std::static_pointer_cast<
      const RNOrthogonalSectionViewEventEmitter>(_eventEmitter);

  RNOrthogonalSectionViewEventEmitter::OnHScroll event;
  event.sectionIndex = _sectionIndex;
  event.scrollX      = scrollView.contentOffset.x;
  emitter->onHScroll(event);
}

// ── UIScrollViewDelegate gesture lifecycle ───────────────────────────────────
// H-1 debug: log gesture state transitions to diagnose missing-gesture-after-
// boundary issue.

- (void)scrollViewWillBeginDragging:(UIScrollView *)scrollView
{
  HGEST_LOG(@"willBeginDragging off=%.1f cs=%.1fx%.1f bounds=%@ enabled=%d",
            scrollView.contentOffset.x,
            scrollView.contentSize.width, scrollView.contentSize.height,
            NSStringFromCGRect(self.bounds),
            scrollView.scrollEnabled);
}

- (void)scrollViewDidEndDragging:(UIScrollView *)scrollView
                  willDecelerate:(BOOL)decelerate
{
  HGEST_LOG(@"didEndDragging off=%.1f decel=%d cs=%.1fx%.1f",
            scrollView.contentOffset.x, decelerate,
            scrollView.contentSize.width, scrollView.contentSize.height);
}

- (void)scrollViewWillBeginDecelerating:(UIScrollView *)scrollView
{
  HGEST_LOG(@"willBeginDecelerating off=%.1f cs=%.1fx%.1f",
            scrollView.contentOffset.x,
            scrollView.contentSize.width, scrollView.contentSize.height);
}

- (void)scrollViewDidEndDecelerating:(UIScrollView *)scrollView
{
  HGEST_LOG(@"didEndDecelerating off=%.1f cs=%.1fx%.1f bounds=%@ enabled=%d",
            scrollView.contentOffset.x,
            scrollView.contentSize.width, scrollView.contentSize.height,
            NSStringFromCGRect(self.bounds),
            scrollView.scrollEnabled);
}

- (void)scrollViewDidEndScrollingAnimation:(UIScrollView *)scrollView
{
  HGEST_LOG(@"didEndScrollingAnimation off=%.1f", scrollView.contentOffset.x);
}

// ── Layout ───────────────────────────────────────────────────────────────────

- (void)layoutSubviews
{
  CFTimeInterval t0 = CACurrentMediaTime();
  [super layoutSubviews];

  BOOL frameChanged = NO;
  if (!CGRectEqualToRect(_scrollView.frame, self.bounds)) {
    _scrollView.frame = self.bounds;
    frameChanged = YES;
  }

  // Keep content size in sync with current bounds height (height may change
  // as items measure and MVC updates the section height).
  CGSize needed = CGSizeMake(MAX(_contentWidth, self.bounds.size.width),
                             self.bounds.size.height);
  if (!CGSizeEqualToSize(_scrollView.contentSize, needed)) {
    HGEST_LOG(@"layoutSubviews cs %.1fx%.1f -> %.1fx%.1f (cw=%.1f bounds=%@ off=%.1f drag=%d decel=%d)",
              _scrollView.contentSize.width, _scrollView.contentSize.height,
              needed.width, needed.height, _contentWidth,
              NSStringFromCGRect(self.bounds),
              _scrollView.contentOffset.x,
              _scrollView.dragging, _scrollView.decelerating);
    _scrollView.contentSize = needed;
    _contentView.frame = CGRectMake(0, 0, needed.width, needed.height);
  } else if (frameChanged) {
    HGEST_LOG(@"layoutSubviews frame -> %@ (cs unchanged %.1fx%.1f)",
              NSStringFromCGRect(self.bounds),
              _scrollView.contentSize.width, _scrollView.contentSize.height);
  }

  CFTimeInterval dt = CACurrentMediaTime() - t0;
#if RNCV_HGEST_LOGS
  [HGestWorkAggregator addLayoutSubviewsMs:dt * 1000.0];
  if (dt > 0.002) {
    HGEST_LOG(@"layoutSubviews took %.1fms (drag=%d decel=%d)",
              dt * 1000.0, _scrollView.dragging, _scrollView.decelerating);
  }
#else
  (void)dt;
#endif
}

@end

// ── Fabric export ─────────────────────────────────────────────────────────────
// Required: lets Fabric's component registry find this class.

Class<RCTComponentViewProtocol> RNOrthogonalSectionViewCls(void)
{
  return RNOrthogonalSectionView.class;
}
