#import "RNCollectionViewContainerView.h"
#import "RNCVContentView.h"
#import "RNMeasuredCellView.h"
#import "RNOrthogonalSectionView.h"
#import "RNCollectionSubContainerView.h"

// Our custom ShadowNode and ComponentDescriptor (NOT the codegen-generated ones).
#import "CollectionViewContainerComponentDescriptor.h"
#import "CollectionViewContainerShadowNode.h"
#import "RNScrollCoordinatedViewView.h"

// LayoutCache: full include for LayoutAttributes (alpha, transform3D, zIndex).
#include "LayoutCache.h"
#include <memory>
#include <cstdint>
#include <functional>
namespace facebook::react {
  std::shared_ptr<rncv::LayoutCache> layoutCacheForId(int32_t cacheId);
  using ScrollHandler = std::function<void(double x, double y, bool animated)>;
  void registerScrollHandler(int32_t cacheId, ScrollHandler handler);
  void unregisterScrollHandler(int32_t cacheId);
}

// Codegen-generated helpers (props protocol, event emitter types).
#import <react/renderer/components/RiffSpec/EventEmitters.h>
#import <react/renderer/components/RiffSpec/Props.h>
#import <react/renderer/components/RiffSpec/RCTComponentViewHelpers.h>

#import <React/RCTFabricComponentsPlugins.h>

#import <os/log.h>

using namespace facebook::react;

// Cross-platform logging — active only in DEBUG builds; no-op in release.
#ifndef RNCV_ENABLE_NATIVE_LOGS
#define RNCV_ENABLE_NATIVE_LOGS 0
#endif

// Set RNCV_ENABLE_MVC_TRACE=1 to enable verbose MVC lifecycle tracing.
// Covers updateState:, layoutSubviews, scrollTo, and scrollViewDidScroll.
// Keep 0 in normal development; enable only to debug insert/delete/correction bugs.
#ifndef RNCV_ENABLE_MVC_TRACE
#define RNCV_ENABLE_MVC_TRACE 0
#endif

#if DEBUG && RNCV_ENABLE_NATIVE_LOGS
#define RNCV_LOG(fmt, ...) NSLog(@"[RNCV] " @ fmt, ##__VA_ARGS__)
#else
#define RNCV_LOG(fmt, ...) ((void)0)
#endif

#if DEBUG && RNCV_ENABLE_MVC_TRACE
#define RNCV_MVC_TRACE(fmt, ...) NSLog(@"[MVC-TRACE] " @ fmt, ##__VA_ARGS__)
#else
#define RNCV_MVC_TRACE(fmt, ...) ((void)0)
#endif

@interface RNCollectionViewContainerView () <RCTRNCollectionViewContainerViewProtocol>
@end

@implementation RNCollectionViewContainerView {
  UIScrollView *_scrollView;
  RNCVContentView *_contentView;

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
  double _pendingMVCCorrection;       // delta (for threshold check only)
  double _pendingMVCScrollTarget;     // absolute target offset (snapshotScroll + delta)

  // LayoutCache registry ID — cached from props for scroll offset wiring.
  int32_t _layoutCacheId;

  // Scroll axis — when YES, UIScrollView scrolls horizontally.
  BOOL _horizontal;

  // True when the current layout writes non-default LayoutAttributes (alpha,
  // zIndex, transform3D). When NO, applyPositionsFromState: skips the
  // per-cell visual-attrs read/write block entirely — eliminates N mutex-
  // locked LayoutCache lookups + N CALayer property writes per commit.
  // Mirrored from RNCollectionViewContainerProps.layoutWritesVisualAttributes.
  BOOL _layoutWritesVisualAttributes;

  // Last seen layoutRevision — used to fire onScroll when positions change
  // even if content size is unchanged (e.g. flow reflow after width measurement).
  int32_t _lastLayoutRevision;

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
    _pendingMVCScrollTarget = 0;
    _lastLayoutRevision = -1;

    // Create internal UIScrollView.
    _scrollView = [[UIScrollView alloc] initWithFrame:self.bounds];
    _scrollView.autoresizingMask =
        UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _scrollView.delegate = self;

    // Content view holds all children.
    _contentView = [[RNCVContentView alloc] initWithFrame:CGRectZero];
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
  _pendingMVCScrollTarget = 0;
  [_scrollView setContentOffset:CGPointZero animated:NO];
  _scrollView.contentSize = CGSizeZero;
  _scrollView.zoomScale = 1.0;
  _scrollView.contentInset = UIEdgeInsetsZero;
  _scrollView.scrollIndicatorInsets = UIEdgeInsetsZero;
  _contentView.frame = CGRectZero;
  if (_layoutCacheId != 0) {
    facebook::react::unregisterScrollHandler(_layoutCacheId);
    _layoutCacheId = 0;
  }
  RNCV_LOG("prepareForRecycle — reset for reuse");
}

// ── Programmatic scroll ─────────────────────────────────────────────────────

- (void)_scrollToX:(double)x y:(double)y animated:(BOOL)animated
{
  CGFloat maxY = MAX(0.0, _scrollView.contentSize.height - _scrollView.bounds.size.height);
  CGFloat maxX = MAX(0.0, _scrollView.contentSize.width  - _scrollView.bounds.size.width);
  CGPoint target = CGPointMake(
    MAX(0.0, MIN((CGFloat)x, maxX)),
    MAX(0.0, MIN((CGFloat)y, maxY))
  );
  RNCV_MVC_TRACE("scrollTo x=%.1f y=%.1f animated=%s target=(%.1f,%.1f)",
                 x, y, animated ? "YES" : "NO", target.x, target.y);
  if (animated) {
    // Block MVC re-arming (snapshotAnchorIfNeeded) while the animation runs.
    // Cleared in all scroll-end callbacks to guard against animation cancellation.
    auto cache = facebook::react::layoutCacheForId(_layoutCacheId);
    if (cache) cache->setProgrammaticScrollActive(true);
  }
  [_scrollView setContentOffset:target animated:animated];
}

- (void)_clearProgrammaticScrollFlag
{
  auto cache = facebook::react::layoutCacheForId(_layoutCacheId);
  if (cache) cache->setProgrammaticScrollActive(false);
}

// ── Child management ────────────────────────────────────────────────────────
// Children from React are mounted into _contentView, not directly into self.

- (void)mountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView
                          index:(NSInteger)index
{
  RNCV_LOG("mountChild index=%ld tag=%ld beforeSubviews=%lu",
           (long)index, (long)childComponentView.tag, (unsigned long)_contentView.subviews.count);
  [_contentView insertSubview:childComponentView atIndex:index];

  // Pass layoutCacheId to sticky children so they can read positions directly
  // from the LayoutCache in updateLayoutMetrics: (bypasses async state update).
  if ([childComponentView isKindOfClass:[RNScrollCoordinatedViewView class]]) {
    ((RNScrollCoordinatedViewView *)childComponentView).layoutCacheId = _layoutCacheId;
  }

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
  _horizontal = newProps.horizontal;
  _scrollView.scrollEnabled = newProps.scrollEnabled;
  _scrollView.bounces = newProps.bounces;
  _scrollView.showsVerticalScrollIndicator = newProps.showsVerticalScrollIndicator && !newProps.horizontal;
  _scrollView.showsHorizontalScrollIndicator = newProps.horizontal;

  if (newProps.scrollEventThrottle > 0) {
    _scrollEventMinInterval = newProps.scrollEventThrottle / 1000.0;
  }

  // Cache the visual-attrs flag — gates the per-cell attribute lookup +
  // CALayer writes in applyPositionsFromState:. Static layouts leave this
  // false → that block is skipped entirely.
  _layoutWritesVisualAttributes = newProps.layoutWritesVisualAttributes;

  // Register scroll handler when layoutCacheId is assigned.
  // The handler is invoked from JS (nativeMod.scrollTo) via the scroll handler
  // registry, dispatching to the main thread to call setContentOffset:.
  if (newProps.layoutCacheId != 0 && newProps.layoutCacheId != _layoutCacheId) {
    if (_layoutCacheId != 0) {
      facebook::react::unregisterScrollHandler(_layoutCacheId);
    }
    _layoutCacheId = newProps.layoutCacheId;
    __weak RNCollectionViewContainerView *weakSelf = self;
    facebook::react::registerScrollHandler(_layoutCacheId,
        [weakSelf](double x, double y, bool animated) {
          dispatch_async(dispatch_get_main_queue(), ^{
            RNCollectionViewContainerView *strongSelf = weakSelf;
            if (!strongSelf) return;
            [strongSelf _scrollToX:x y:y animated:animated];
          });
        });
  } else {
    _layoutCacheId = newProps.layoutCacheId;
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
  RNCV_LOG("updateState rev=%d contentOffset=(%.1f,%.1f)",
           data.layoutRevision, _scrollView.contentOffset.x, _scrollView.contentOffset.y);

  // Reset scroll offset on first state (new mount).
  if (!_hasReceivedFirstState) {
    _hasReceivedFirstState = YES;
    [_scrollView setContentOffset:CGPointZero animated:NO];
  }

  // Apply content size to scroll view.
  CGSize contentSize = CGSizeMake(data.contentSize.width, data.contentSize.height);
  BOOL contentSizeChanged = !CGSizeEqualToSize(_scrollView.contentSize, contentSize);
  if (contentSizeChanged) {
    _scrollView.contentSize = contentSize;
  }

  // Resize content view to match.
  _contentView.frame = CGRectMake(0, 0, contentSize.width, contentSize.height);

  // Track revision to detect position-only changes (e.g. flow reflow after
  // width measurement where total height happens to stay the same).
  BOOL revisionChanged = (data.layoutRevision != _lastLayoutRevision);
  _lastLayoutRevision = data.layoutRevision;

  // Fire onScroll when content size changes (JS synthesizes onContentSizeChange)
  // OR when layout revision changes (positions shifted → render range must refresh).
  // topContentSizeChange is not a registered Fabric event, so we piggyback on onScroll.
  if ((contentSizeChanged || revisionChanged) && _eventEmitter) {
    auto emitter = std::static_pointer_cast<
        const RNCollectionViewContainerEventEmitter>(_eventEmitter);
    RNCollectionViewContainerEventEmitter::OnScroll event;
    event.contentOffset.x        = _scrollView.contentOffset.x;
    event.contentOffset.y        = _scrollView.contentOffset.y;
    event.contentSize.width      = contentSize.width;
    event.contentSize.height     = contentSize.height;
    event.layoutMeasurement.width  = _scrollView.bounds.size.width;
    event.layoutMeasurement.height = _scrollView.bounds.size.height;
    emitter->onScroll(event);
  }

  // Compute MVC correction here (post-Yoga positions are in LayoutCache), but
  // defer applying it to contentOffset until the end of layoutSubviews — AFTER
  // applyPositionsFromState has set all children to their final positions.
  // This ensures the KVO-triggered _applyTransform on sticky views reads the
  // correct naturalY instead of stale pre-commit values.
  {
    auto cache = facebook::react::layoutCacheForId(_layoutCacheId);
    if (cache) {
      double correction = cache->computeCorrection();
      RNCV_MVC_TRACE("updateState: computeCorrection=%.1f pendingMVCBefore=%.1f",
                     correction, _pendingMVCCorrection);
      if (std::abs(correction) > 0.5) {
        _pendingMVCCorrection   = correction;
        _pendingMVCScrollTarget = cache->consumePendingScrollTarget();
      }
    }
  }

  // Apply positions immediately — don't wait for layoutSubviews.
  // Since updateLayoutMetrics: on children now preserves their OLD positions,
  // we must correct them synchronously here so data mutations (deletion)
  // don't show stale footer/header positions for even one frame.
  [self applyPositionsFromState:@"updateState"];
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
      cache->setScrollOffset(scrollView.contentOffset.x, scrollView.contentOffset.y,
                             CACurrentMediaTime() * 1000.0);
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

- (void)scrollViewWillBeginDragging:(UIScrollView *)scrollView
{
  if (!_eventEmitter) return;
  auto emitter = std::static_pointer_cast<
      const RNCollectionViewContainerEventEmitter>(_eventEmitter);
  RNCollectionViewContainerEventEmitter::OnScrollBeginDrag event;
  event.contentOffset.x        = scrollView.contentOffset.x;
  event.contentOffset.y        = scrollView.contentOffset.y;
  event.contentSize.width      = scrollView.contentSize.width;
  event.contentSize.height     = scrollView.contentSize.height;
  event.layoutMeasurement.width  = scrollView.bounds.size.width;
  event.layoutMeasurement.height = scrollView.bounds.size.height;
  emitter->onScrollBeginDrag(event);
}

- (void)scrollViewDidEndDragging:(UIScrollView *)scrollView willDecelerate:(BOOL)decelerate
{
  // User touch can cancel an animated scrollTo; clear the flag defensively.
  if (!decelerate) [self _clearProgrammaticScrollFlag];
  if (!_eventEmitter) return;
  auto emitter = std::static_pointer_cast<
      const RNCollectionViewContainerEventEmitter>(_eventEmitter);
  RNCollectionViewContainerEventEmitter::OnScrollEndDrag event;
  event.contentOffset.x        = scrollView.contentOffset.x;
  event.contentOffset.y        = scrollView.contentOffset.y;
  event.contentSize.width      = scrollView.contentSize.width;
  event.contentSize.height     = scrollView.contentSize.height;
  event.layoutMeasurement.width  = scrollView.bounds.size.width;
  event.layoutMeasurement.height = scrollView.bounds.size.height;
  emitter->onScrollEndDrag(event);
}

- (void)scrollViewWillBeginDecelerating:(UIScrollView *)scrollView
{
  if (!_eventEmitter) return;
  auto emitter = std::static_pointer_cast<
      const RNCollectionViewContainerEventEmitter>(_eventEmitter);
  RNCollectionViewContainerEventEmitter::OnMomentumScrollBegin event;
  event.contentOffset.x        = scrollView.contentOffset.x;
  event.contentOffset.y        = scrollView.contentOffset.y;
  event.contentSize.width      = scrollView.contentSize.width;
  event.contentSize.height     = scrollView.contentSize.height;
  event.layoutMeasurement.width  = scrollView.bounds.size.width;
  event.layoutMeasurement.height = scrollView.bounds.size.height;
  emitter->onMomentumScrollBegin(event);
}

- (void)scrollViewDidEndScrollingAnimation:(UIScrollView *)scrollView
{
  [self _clearProgrammaticScrollFlag];
}

- (void)scrollViewDidEndDecelerating:(UIScrollView *)scrollView
{
  // Also clear here: if user drags during animated scrollTo, deceleration
  // ends the motion but scrollViewDidEndScrollingAnimation: won't fire.
  [self _clearProgrammaticScrollFlag];
  if (!_eventEmitter) return;
  auto emitter = std::static_pointer_cast<
      const RNCollectionViewContainerEventEmitter>(_eventEmitter);
  RNCollectionViewContainerEventEmitter::OnMomentumScrollEnd event;
  event.contentOffset.x        = scrollView.contentOffset.x;
  event.contentOffset.y        = scrollView.contentOffset.y;
  event.contentSize.width      = scrollView.contentSize.width;
  event.contentSize.height     = scrollView.contentSize.height;
  event.layoutMeasurement.width  = scrollView.bounds.size.width;
  event.layoutMeasurement.height = scrollView.bounds.size.height;
  emitter->onMomentumScrollEnd(event);
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
  RNCV_MVC_TRACE("layoutSubviews: pendingMVCCorrection=%.1f offset=(%.1f,%.1f)",
                 _pendingMVCCorrection, _scrollView.contentOffset.x, _scrollView.contentOffset.y);
  if (std::abs(_pendingMVCCorrection) > 0.5) {
    // Use the absolute scroll target (snapshotScroll + delta), not current + delta.
    // This prevents double-correction when UIKit auto-clamps contentOffset on
    // contentSize shrink (e.g. delete at bottom of list, UIKit snaps first, then
    // current + delta would overshoot by the amount UIKit already moved).
    CGFloat maxPrimary = _horizontal
      ? MAX(0.0, _scrollView.contentSize.width  - _scrollView.bounds.size.width)
      : MAX(0.0, _scrollView.contentSize.height - _scrollView.bounds.size.height);
    CGFloat target = MAX(0.0, MIN((CGFloat)_pendingMVCScrollTarget, maxPrimary));
    CGPoint offset = _scrollView.contentOffset;
    if (_horizontal) {
      RNCV_LOG("applying MVC correction=%.1f oldX=%.1f newX=%.1f",
               _pendingMVCCorrection, offset.x, target);
      RNCV_MVC_TRACE("layoutSubviews: APPLYING correction=%.1f oldX=%.1f newX=%.1f",
                     _pendingMVCCorrection, offset.x, target);
      offset.x = target;
    } else {
      RNCV_LOG("applying MVC correction=%.1f oldY=%.1f newY=%.1f",
               _pendingMVCCorrection, offset.y, target);
      RNCV_MVC_TRACE("layoutSubviews: APPLYING correction=%.1f oldY=%.1f newY=%.1f",
                     _pendingMVCCorrection, offset.y, target);
      offset.y = target;
    }
    _applyingCorrection = YES;
    [_scrollView setContentOffset:offset animated:NO];
    _applyingCorrection = NO;
    auto cache = facebook::react::layoutCacheForId(_layoutCacheId);
    if (cache) {
      cache->setScrollOffset(offset.x, offset.y, CACurrentMediaTime() * 1000.0);
    }
    _pendingMVCCorrection   = 0;
    _pendingMVCScrollTarget = 0;

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
  const auto &childTags = data.childTags;
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

  // Build tag → UIView map for identity-based lookup.
  //
  // We use tag-based (not index-based) lookup because Fabric's reconciler
  // "last index" optimization can leave native subview order inconsistent
  // with ShadowNode child order: when new children (e.g. separators) are
  // inserted before existing non-moved children (e.g. section backgrounds),
  // Fabric doesn't generate MOVE operations for the non-moved views, so
  // their native index stays at the old position while their ShadowNode
  // index has shifted. Index-based mapping applies the wrong position to
  // the wrong view. Tag identity is Fabric's core contract — a native view
  // with tag X always corresponds to the ShadowNode child with tag X,
  // regardless of mount operation ordering. Covers ALL child types.
  NSMutableDictionary<NSNumber *, UIView *> *tagToView =
      [NSMutableDictionary dictionaryWithCapacity:subviews.count];
  for (UIView *sv in subviews) {
    tagToView[@(sv.tag)] = sv;
  }

  // When the layout writes visual attrs, batch-read them once. One mutex
  // acquisition for all keys instead of N per-cell getAttributes() calls.
  // Keys for non-RNMeasuredCellView children stay empty (cache miss) — the
  // per-cell visual-attrs branch checks isKindOfClass:[RNMeasuredCellView]
  // anyway. Skip the entire bulk read for static layouts.
  rncv::BulkAttributesResult bulkAttrs;
  if (_layoutWritesVisualAttributes && _layoutCacheId != 0 && !childTags.empty()) {
    std::vector<std::string> attrKeys(childCount);
    for (size_t i = 0; i < childCount && i < childTags.size(); ++i) {
      UIView *cv = tagToView[@(childTags[i])];
      if ([cv isKindOfClass:[RNMeasuredCellView class]]) {
        NSString *ck = ((RNMeasuredCellView *)cv).cacheKey;
        if (ck.length > 0) attrKeys[i] = ck.UTF8String;
      }
    }
    auto cache = facebook::react::layoutCacheForId(_layoutCacheId);
    if (cache) bulkAttrs = cache->getAttributesForKeys(attrKeys);
  }

  // Apply full frame (position + size) from ShadowNode-computed layout.
  for (size_t i = 0; i < childCount && i < childTags.size(); i++) {
    UIView *child = (childTags.empty()) ? subviews[i] : tagToView[@(childTags[i])];
    if (!child) {
      RNCV_LOG("  apply[%zu] tag=%d — no matching subview, skipping", i, childTags[i]);
      continue;
    }
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

    RNCV_LOG("  apply[%zu] tag=%ld transformed=%s target=(%.1f,%.1f,%.1f,%.1f) current=(%.1f,%.1f,%.1f,%.1f)",
             i, (long)child.tag, hasActiveTransform ? "YES" : "NO", targetX, targetY, targetW, targetH,
             frame.origin.x, frame.origin.y, frame.size.width, frame.size.height);

    if (targetW > 0 && targetH > 0 &&
        (differsX || differsY || differsW || differsH)) {
      // Mark as ShadowNode-positioned so updateLayoutMetrics: preserves this origin
      // rather than letting Fabric's Yoga layout overwrite it.
      if ([child isKindOfClass:[RNMeasuredCellView class]]) {
        ((RNMeasuredCellView *)child).shadowNodePositioned = YES;
      } else if ([child isKindOfClass:[RNOrthogonalSectionView class]]) {
        ((RNOrthogonalSectionView *)child).shadowNodePositioned = YES;
      } else if ([child isKindOfClass:[RNCollectionSubContainerView class]]) {
        // H-2: same protection for the new generic sub-container wrapper.
        ((RNCollectionSubContainerView *)child).shadowNodePositioned = YES;
      }
      if (hasActiveTransform) {
        // Keep transformed sticky views stable by updating their natural geometry
        // (bounds + center) instead of transformed frame.
        child.bounds = CGRectMake(0, 0, targetW, targetH);
        child.center = CGPointMake(targetX + targetW * 0.5f, targetY + targetH * 0.5f);
      } else {
        child.frame = CGRectMake(targetX, targetY, targetW, targetH);
      }
      RNCV_LOG("  applied[%zu] tag=%ld frame=(%.1f,%.1f,%.1f,%.1f)",
               i, (long)child.tag,
               child.frame.origin.x, child.frame.origin.y,
               child.frame.size.width, child.frame.size.height);

      // Apply visual attributes (alpha, transform3D, zIndex) from LayoutCache.
      // Gated on _layoutWritesVisualAttributes: static layouts (list/grid/
      // masonry/flow/compositional with all-static sub-sections) skip this
      // entire block — they leave attrs at defaults (alpha=1, zIndex=0,
      // transform=identity), so a per-cell mutex-locked cache lookup + three
      // CALayer property writes per cell per commit is pure overhead.
      // Attrs were bulk-read once at the top of this method — one mutex
      // acquisition for all keys. Per-cell value guards (stage 5) avoid
      // KVO/needs-display dispatch when the new value equals the current.
      if (_layoutWritesVisualAttributes &&
          i < bulkAttrs.found.size() && bulkAttrs.found[i]) {
        const auto& a = bulkAttrs.attrs[i];
        const CGFloat newAlpha = (CGFloat)a.alpha;
        if (child.alpha != newAlpha) child.alpha = newAlpha;
        const CGFloat newZ = (CGFloat)a.zIndex;
        if (child.layer.zPosition != newZ) child.layer.zPosition = newZ;
        const auto& t = a.transform3D;
        CATransform3D ct;
        if (t != rncv::kIdentityTransform3D) {
          ct.m11 = t[0];  ct.m21 = t[1];  ct.m31 = t[2];  ct.m41 = t[3];
          ct.m12 = t[4];  ct.m22 = t[5];  ct.m32 = t[6];  ct.m42 = t[7];
          ct.m13 = t[8];  ct.m23 = t[9];  ct.m33 = t[10]; ct.m43 = t[11];
          ct.m14 = t[12]; ct.m24 = t[13]; ct.m34 = t[14]; ct.m44 = t[15];
        } else {
          ct = CATransform3DIdentity;
        }
        if (!CATransform3DEqualToTransform(child.layer.transform, ct)) {
          child.layer.transform = ct;
        }
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
