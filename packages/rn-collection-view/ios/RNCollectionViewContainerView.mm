#import "RNCollectionViewContainerView.h"

// Our custom ShadowNode and ComponentDescriptor (NOT the codegen-generated ones).
#import "CollectionViewContainerComponentDescriptor.h"
#import "CollectionViewContainerShadowNode.h"

// Forward-declare layoutCacheForId to avoid pulling in CollectionViewModule's heavy deps.
#include <memory>
#include <cstdint>
namespace rncv { class LayoutCache; }
namespace facebook::react {
  std::shared_ptr<rncv::LayoutCache> layoutCacheForId(int32_t cacheId);
}

// Codegen-generated helpers (props protocol, event emitter types).
#import <react/renderer/components/RNCollectionViewSpec/EventEmitters.h>
#import <react/renderer/components/RNCollectionViewSpec/Props.h>
#import <react/renderer/components/RNCollectionViewSpec/RCTComponentViewHelpers.h>

#import <React/RCTFabricComponentsPlugins.h>

#import <os/log.h>

using namespace facebook::react;

// Cross-platform logging — active only in DEBUG builds; no-op in release.
#ifndef RNCV_ENABLE_NATIVE_LOGS
#define RNCV_ENABLE_NATIVE_LOGS 0
#endif

#if DEBUG && RNCV_ENABLE_NATIVE_LOGS
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

  // MVC correction deferred from updateState: to layoutSubviews (after applyPositionsFromState).
  // Ensures sticky-view KVO fires after children have their final positions.
  double _pendingMVCCorrection;

  // LayoutCache registry ID — cached from props for scroll offset wiring.
  int32_t _layoutCacheId;

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
    _pendingMVCCorrection = 0;

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
  _pendingMVCCorrection = 0;
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

  _layoutCacheId = newProps.layoutCacheId;
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
  RNCV_LOG("updateState rev=%d contentOffset=(%.1f,%.1f)",
           data.layoutRevision, _scrollView.contentOffset.x, _scrollView.contentOffset.y);

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

  // Compute MVC correction here (post-Yoga positions are in LayoutCache), but
  // defer applying it to contentOffset until the end of layoutSubviews — AFTER
  // applyPositionsFromState has set all children to their final positions.
  // This ensures the KVO-triggered _applyTransform on sticky views reads the
  // correct naturalY instead of stale pre-commit values.
  {
    auto cache = facebook::react::layoutCacheForId(_layoutCacheId);
    if (cache) {
      double correction = cache->computeCorrection();
      if (std::abs(correction) > 0.5) {
        _pendingMVCCorrection = correction;
      }
    }
  }

  [self setNeedsLayout];
}

// ── UIScrollViewDelegate ────────────────────────────────────────────────────

- (void)scrollViewDidScroll:(UIScrollView *)scrollView
{
  // Ignore programmatic offset changes during correction.
  if (_applyingCorrection) return;

  // Write scroll offset to LayoutCache on every scroll event (not throttled).
  // The ShadowNode reads this during layout() to compute offset correction.
  // Must happen before the throttle check so the ShadowNode always has current data.
  {
    auto cache = facebook::react::layoutCacheForId(_layoutCacheId);
    if (cache) {
      cache->setScrollOffset(scrollView.contentOffset.x, scrollView.contentOffset.y);
    }
  }

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

  // Apply deferred MVC correction AFTER positions are set. Sticky views (RNScrollCoordinatedView)
  // observe contentOffset via KVO and call _applyTransform when it changes. By deferring until
  // here, their center/bounds already reflect final post-Yoga layout, so _applyTransform reads
  // the correct naturalY and produces the right sticky transform.
  if (std::abs(_pendingMVCCorrection) > 0.5) {
    CGPoint offset = _scrollView.contentOffset;
    RNCV_LOG("applying MVC correction=%.1f oldY=%.1f newY=%.1f",
             _pendingMVCCorrection, offset.y, offset.y + _pendingMVCCorrection);
    offset.y += (CGFloat)_pendingMVCCorrection;
    _applyingCorrection = YES;
    [_scrollView setContentOffset:offset animated:NO];
    _applyingCorrection = NO;
    auto cache = facebook::react::layoutCacheForId(_layoutCacheId);
    if (cache) {
      cache->setScrollOffset(offset.x, offset.y);
    }
    _pendingMVCCorrection = 0;

    // Notify JS of the corrected scroll position so it can recompute the render
    // range. Without this, the render window stays computed for the pre-correction
    // offset and cells at the new viewport edges appear blank.
    if (_eventEmitter) {
      auto emitter = std::static_pointer_cast<
          const RNCollectionViewContainerEventEmitter>(_eventEmitter);
      RNCollectionViewContainerEventEmitter::OnScroll event;
      event.contentOffset.x = offset.x;
      event.contentOffset.y = offset.y;
      event.contentSize.width = _scrollView.contentSize.width;
      event.contentSize.height = _scrollView.contentSize.height;
      event.layoutMeasurement.width = _scrollView.bounds.size.width;
      event.layoutMeasurement.height = _scrollView.bounds.size.height;
      emitter->onScroll(event);
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
    const BOOL hasActiveTransform = !CGAffineTransformIsIdentity(child.transform) ||
        !CATransform3DIsIdentity(child.layer.transform);
    const CGFloat currentNaturalX =
        hasActiveTransform ? (child.center.x - child.bounds.size.width * 0.5f) : frame.origin.x;
    const CGFloat currentNaturalY =
        hasActiveTransform ? (child.center.y - child.bounds.size.height * 0.5f) : frame.origin.y;
    const CGFloat currentNaturalW = hasActiveTransform ? child.bounds.size.width : frame.size.width;
    const CGFloat currentNaturalH = hasActiveTransform ? child.bounds.size.height : frame.size.height;
    static const CGFloat kLayoutEpsilon = 0.1f;
    const BOOL differsX = std::abs(currentNaturalX - targetX) > kLayoutEpsilon;
    const BOOL differsY = std::abs(currentNaturalY - targetY) > kLayoutEpsilon;
    const BOOL differsW = std::abs(currentNaturalW - targetW) > kLayoutEpsilon;
    const BOOL differsH = std::abs(currentNaturalH - targetH) > kLayoutEpsilon;

    // Log first 5 children
    if (i < 8) {
      RNCV_LOG("  apply[%zu] tag=%ld transformed=%s target=(%.1f,%.1f,%.1f,%.1f) current=(%.1f,%.1f,%.1f,%.1f) natural=(%.1f,%.1f,%.1f,%.1f)",
               i, (long)child.tag, hasActiveTransform ? "YES" : "NO", targetX, targetY, targetW, targetH,
               frame.origin.x, frame.origin.y, frame.size.width, frame.size.height,
               currentNaturalX, currentNaturalY, currentNaturalW, currentNaturalH);
    }

    if (targetW > 0 && targetH > 0 &&
        (differsX || differsY || differsW || differsH)) {
      if (hasActiveTransform) {
        // Keep transformed sticky views stable by updating their natural geometry
        // (bounds + center) instead of transformed frame.
        child.bounds = CGRectMake(0, 0, targetW, targetH);
        child.center = CGPointMake(targetX + targetW * 0.5f, targetY + targetH * 0.5f);
      } else {
        child.frame = CGRectMake(targetX, targetY, targetW, targetH);
      }
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
