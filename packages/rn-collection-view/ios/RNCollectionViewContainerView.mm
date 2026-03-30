#import "RNCollectionViewContainerView.h"

// Our custom ShadowNode and ComponentDescriptor (NOT the codegen-generated ones).
#import "CollectionViewContainerComponentDescriptor.h"
#import "CollectionViewContainerShadowNode.h"

// Codegen-generated helpers (props protocol, event emitter types).
#import <react/renderer/components/RNCollectionViewSpec/EventEmitters.h>
#import <react/renderer/components/RNCollectionViewSpec/Props.h>
#import <react/renderer/components/RNCollectionViewSpec/RCTComponentViewHelpers.h>

#import <React/RCTFabricComponentsPlugins.h>

#import <os/log.h>

using namespace facebook::react;

// Cross-platform logging — active only in DEBUG builds; no-op in release.
#if DEBUG
static os_log_t rncvLog(void) {
  static os_log_t log;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    log = os_log_create("com.rncv", "nativeview");
  });
  return log;
}
#define RNCV_LOG(fmt, ...) os_log_info(rncvLog(), "[RNCV] " fmt, ##__VA_ARGS__)
#else
#define RNCV_LOG(fmt, ...) ((void)0)
#endif

@interface RNCollectionViewContainerView () <RCTRNCollectionViewContainerViewProtocol>
@end

@implementation RNCollectionViewContainerView {
  UIScrollView *_scrollView;
  UIView *_contentView;

  // State from ShadowNode.
  std::shared_ptr<const CollectionViewContainerShadowNode::ConcreteState> _state;

  // Whether we've received our first state update (used to reset scroll offset).
  BOOL _hasReceivedFirstState;

  // Throttle scroll events — store last fire time.
  NSTimeInterval _lastScrollEventTime;
  NSTimeInterval _scrollEventMinInterval; // seconds between events

  // Guard: ignore scrollViewDidScroll during programmatic offset correction.
  BOOL _applyingCorrection;

  // Track which layoutRevision we last applied correction for.
  int32_t _lastCorrectedRevision;

}

// ── Fabric registration ─────────────────────────────────────────────────────
// Return OUR custom descriptor, not the codegen-generated default.

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<CollectionViewContainerComponentDescriptor>();
}

// ── Init ────────────────────────────────────────────────────────────────────

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps =
        std::make_shared<const RNCollectionViewContainerProps>();
    _props = defaultProps;

    _lastScrollEventTime = 0;
    _scrollEventMinInterval = 16.0 / 1000.0; // 16ms default
    _hasReceivedFirstState = NO;
    _applyingCorrection = NO;
    _lastCorrectedRevision = 0;

    // Create internal UIScrollView.
    _scrollView = [[UIScrollView alloc] initWithFrame:self.bounds];
    _scrollView.autoresizingMask =
        UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _scrollView.delegate = self;

    // Content view holds all children.
    _contentView = [[UIView alloc] initWithFrame:CGRectZero];
    [_scrollView addSubview:_contentView];
    [self addSubview:_scrollView];

    RNCV_LOG("init");
  }
  return self;
}

// ── Fabric view recycling ────────────────────────────────────────────────────
// Called by Fabric before returning this view to its pool for reuse.

- (void)prepareForRecycle
{
  [super prepareForRecycle];
  _state = nullptr;
  _hasReceivedFirstState = NO;
  _lastScrollEventTime = 0;
  _lastCorrectedRevision = 0;
  [_scrollView setContentOffset:CGPointZero animated:NO];
  _scrollView.contentSize = CGSizeZero;
  _scrollView.zoomScale = 1.0;
  _scrollView.contentInset = UIEdgeInsetsZero;
  _scrollView.scrollIndicatorInsets = UIEdgeInsetsZero;
  _contentView.frame = CGRectZero;
  RNCV_LOG("prepareForRecycle — reset for reuse");
}

// ── Child management ────────────────────────────────────────────────────────
// Children from React are mounted into _contentView, not directly into self.

- (void)mountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView
                          index:(NSInteger)index
{
  RNCV_LOG("mountChild index=%ld tag=%ld beforeSubviews=%lu",
           (long)index, (long)childComponentView.tag, (unsigned long)_contentView.subviews.count);
  [_contentView insertSubview:childComponentView atIndex:index];
  RNCV_LOG("mountChild index=%ld tag=%ld afterSubviews=%lu",
           (long)index, (long)childComponentView.tag, (unsigned long)_contentView.subviews.count);
}

- (void)unmountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView
                            index:(NSInteger)index
{
  RNCV_LOG("unmountChild index=%ld tag=%ld beforeSubviews=%lu",
           (long)index, (long)childComponentView.tag, (unsigned long)_contentView.subviews.count);
  [childComponentView removeFromSuperview];
  RNCV_LOG("unmountChild index=%ld tag=%ld afterSubviews=%lu",
           (long)index, (long)childComponentView.tag, (unsigned long)_contentView.subviews.count);
}

// ── Props ───────────────────────────────────────────────────────────────────

- (void)updateProps:(const Props::Shared &)props
           oldProps:(const Props::Shared &)oldProps
{
  [super updateProps:props oldProps:oldProps];

  const auto &newProps =
      *std::static_pointer_cast<const RNCollectionViewContainerProps>(props);

  // Forward scroll-related props to internal UIScrollView.
  _scrollView.scrollEnabled = newProps.scrollEnabled;
  _scrollView.bounces = newProps.bounces;
  _scrollView.showsVerticalScrollIndicator = newProps.showsVerticalScrollIndicator;

  if (newProps.scrollEventThrottle > 0) {
    _scrollEventMinInterval = newProps.scrollEventThrottle / 1000.0;
  }
}

// ── State ───────────────────────────────────────────────────────────────────

- (void)updateState:(const facebook::react::State::Shared &)state
           oldState:(const facebook::react::State::Shared &)oldState
{
  _state = std::static_pointer_cast<
      const CollectionViewContainerShadowNode::ConcreteState>(state);

  if (!_state) return;

  const auto &data = _state->getData();

  RNCV_LOG("updateState rev=%d posCount=%zu subviews=%lu contentH=%.1f",
           data.layoutRevision,
           data.positions.size() / 4,
           (unsigned long)_contentView.subviews.count,
           data.contentSize.height);
  RNCV_LOG("updateState rev=%d contentOffset=(%.1f,%.1f) correctionY=%.1f",
           data.layoutRevision, _scrollView.contentOffset.x, _scrollView.contentOffset.y,
           data.contentOffsetCorrectionY);

  // Reset scroll offset on first state (new mount).
  if (!_hasReceivedFirstState) {
    _hasReceivedFirstState = YES;
    [_scrollView setContentOffset:CGPointZero animated:NO];
  }

  // Apply content size to scroll view.
  CGSize contentSize = CGSizeMake(data.contentSize.width, data.contentSize.height);
  if (!CGSizeEqualToSize(_scrollView.contentSize, contentSize)) {
    _scrollView.contentSize = contentSize;
  }

  // Resize content view to match.
  _contentView.frame = CGRectMake(0, 0, contentSize.width, contentSize.height);

  [self setNeedsLayout];
}

// ── UIScrollViewDelegate ────────────────────────────────────────────────────

- (void)scrollViewDidScroll:(UIScrollView *)scrollView
{
  // Ignore programmatic offset changes during correction.
  if (_applyingCorrection) return;

  // Throttle scroll events.
  NSTimeInterval now = CACurrentMediaTime();
  if (now - _lastScrollEventTime < _scrollEventMinInterval) {
    return;
  }
  _lastScrollEventTime = now;

  RNCV_LOG("scrollViewDidScroll y=%.1f", scrollView.contentOffset.y);

  // Emit onScroll event to JS for render range computation.
  if (_eventEmitter) {
    auto emitter = std::static_pointer_cast<
        const RNCollectionViewContainerEventEmitter>(_eventEmitter);

    RNCollectionViewContainerEventEmitter::OnScroll event;
    event.contentOffset.x = scrollView.contentOffset.x;
    event.contentOffset.y = scrollView.contentOffset.y;
    event.contentSize.width = scrollView.contentSize.width;
    event.contentSize.height = scrollView.contentSize.height;
    event.layoutMeasurement.width = scrollView.bounds.size.width;
    event.layoutMeasurement.height = scrollView.bounds.size.height;
    emitter->onScroll(event);
  }

}

// ── Layout ──────────────────────────────────────────────────────────────────

- (void)layoutSubviews
{
  [super layoutSubviews];

  // Ensure scroll view fills our bounds.
  if (!CGRectEqualToRect(_scrollView.frame, self.bounds)) {
    _scrollView.frame = self.bounds;
  }

  RNCV_LOG("layoutSubviews subviews=%lu offset=(%.1f,%.1f) contentSize=(%.1f,%.1f)",
           (unsigned long)_contentView.subviews.count,
           _scrollView.contentOffset.x, _scrollView.contentOffset.y,
           _scrollView.contentSize.width, _scrollView.contentSize.height);

  [self applyPositionsFromState:@"layoutSubviews"];

  // Apply scroll offset correction AFTER positions are applied.
  if (_state) {
    const auto &data = _state->getData();
    if (std::abs(data.contentOffsetCorrectionY) > 0.5f &&
        data.layoutRevision != _lastCorrectedRevision) {
      _lastCorrectedRevision = data.layoutRevision;
      CGPoint offset = _scrollView.contentOffset;
      RNCV_LOG("applying offset correction=%.1f oldY=%.1f newY=%.1f rev=%d",
               data.contentOffsetCorrectionY, offset.y,
               offset.y + data.contentOffsetCorrectionY,
               data.layoutRevision);
      offset.y += data.contentOffsetCorrectionY;
      _applyingCorrection = YES;
      [_scrollView setContentOffset:offset animated:NO];
      _applyingCorrection = NO;
    }
  }
}

// ── Position application ────────────────────────────────────────────────────

- (void)applyPositionsFromState:(NSString *)caller
{
  if (!_state) {
    RNCV_LOG("applyPositions(%s) — no state, skipping", caller.UTF8String);
    return;
  }

  const auto &data = _state->getData();
  const auto &positions = data.positions;
  NSArray<UIView *> *subviews = _contentView.subviews;
  size_t childCount = positions.size() / 4;

  if (childCount == 0 || subviews.count == 0) {
    RNCV_LOG("applyPositions(%s) — empty: posCount=%zu subviews=%lu",
             caller.UTF8String, childCount, (unsigned long)subviews.count);
    return;
  }

  int32_t revision = _state ? _state->getData().layoutRevision : -1;
  RNCV_LOG("applyPositions(%s) rev=%d posCount=%zu subviews=%lu offset=(%.1f,%.1f)",
           caller.UTF8String, revision, childCount, (unsigned long)subviews.count,
           _scrollView.contentOffset.x, _scrollView.contentOffset.y);

  // Apply full frame (position + size) from ShadowNode-computed layout.
  for (size_t i = 0; i < childCount && i < (size_t)subviews.count; i++) {
    UIView *child = subviews[i];
    CGFloat targetX = positions[i * 4];
    CGFloat targetY = positions[i * 4 + 1];
    CGFloat targetW = positions[i * 4 + 2];
    CGFloat targetH = positions[i * 4 + 3];
    CGRect frame = child.frame;

    // Log first 5 children
    if (i < 8) {
      RNCV_LOG("  apply[%zu] tag=%ld target=(%.1f,%.1f,%.1f,%.1f) current=(%.1f,%.1f,%.1f,%.1f)",
               i, (long)child.tag, targetX, targetY, targetW, targetH,
               frame.origin.x, frame.origin.y, frame.size.width, frame.size.height);
    }

    if (targetW > 0 && targetH > 0 &&
        (frame.origin.x != targetX || frame.origin.y != targetY ||
         frame.size.width != targetW || frame.size.height != targetH)) {
      child.frame = CGRectMake(targetX, targetY, targetW, targetH);
      if (i < 8) {
        CGRect applied = child.frame;
        RNCV_LOG("  applied[%zu] tag=%ld frame=(%.1f,%.1f,%.1f,%.1f)",
                 i, (long)child.tag,
                 applied.origin.x, applied.origin.y, applied.size.width, applied.size.height);
      }
    }
  }
}

@end

// Required export for Fabric component registry.
Class<RCTComponentViewProtocol> RNCollectionViewContainerCls(void)
{
  return RNCollectionViewContainerView.class;
}
