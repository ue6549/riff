#import "RNCollectionSubContainerView.h"
#import "RNMeasuredCellView.h"
#include <memory>
namespace rncv { class LayoutCache; }
namespace facebook::react {
  std::shared_ptr<rncv::LayoutCache> layoutCacheForId(int32_t cacheId);
}

// Our custom ShadowNode + descriptor (NOT the codegen default).
#import "CollectionSubContainerComponentDescriptor.h"
#import "CollectionSubContainerShadowNode.h"

// Codegen-generated helpers (props protocol, event emitter types).
#import <react/renderer/components/RNCollectionViewSpec/EventEmitters.h>
#import <react/renderer/components/RNCollectionViewSpec/Props.h>
#import <react/renderer/components/RNCollectionViewSpec/RCTComponentViewHelpers.h>

#import <React/RCTFabricComponentsPlugins.h>

using namespace facebook::react;

// Cross-platform debug logging for the sub-container view.
// Active only in DEBUG builds; no-op in release.
#ifndef RNCV_ENABLE_NATIVE_LOGS
#define RNCV_ENABLE_NATIVE_LOGS 0
#endif

#if DEBUG && RNCV_ENABLE_NATIVE_LOGS
#define RNSUB_LOG(fmt, ...) NSLog(@"[RNCV-SUB] " @ fmt, ##__VA_ARGS__)
#else
#define RNSUB_LOG(fmt, ...) ((void)0)
#endif

// On-screen outlines for H sub-container (same switch as RNMeasuredCellView).
// See RNMeasuredCellView.mm header: RNCV_DEBUG_COLLECTION_VISUALS.
#ifndef RNCV_DEBUG_COLLECTION_VISUALS
#define RNCV_DEBUG_COLLECTION_VISUALS 0
#endif

// Targeted H sub-container scroll diagnostics. Independent from the broader
// RNCV_ENABLE_NATIVE_LOGS so we can flip these on without re-enabling every
// generic native log site in the codebase. Defaults OFF.
//
// Flip to 1 to enable. Sister flags:
//   - example/components/CollectionView.tsx          → RNCV_HSUB_LOGS
//   - cpp/CollectionSubContainerShadowNode.cpp       → RNCV_ENABLE_HSUB_LOGS
//   - cpp/CollectionViewModule.cpp                   → RNCV_ENABLE_HSUB_LOGS
//
// Filterable tags emitted from this file:
//   RNCV-HSUB-IOS-PROPS    updateProps deltas + applied scrollview contentSize
//   RNCV-HSUB-IOS-STATE    updateState contentSize transitions + scrollview snapshot
//   RNCV-HSUB-IOS-LAYOUT   layoutSubviews bounds-gate decisions
//   RNCV-HSUB-IOS-SCROLL   scrollViewDidScroll throttle + contentOffset/Size/bounds
//   RNCV-HSUB-IOS-APPLY    _applyChildVisualStates per-child target frame
//   RNCV-HSUB-IOS-DUP      duplicate target-X warnings (catches "2 cards at index 0")
#ifndef RNCV_ENABLE_HSUB_LOGS
#define RNCV_ENABLE_HSUB_LOGS 0
#endif

#if RNCV_ENABLE_HSUB_LOGS
#define RNHSUB_LOG(fmt, ...) NSLog(@"[RNCV-HSUB-IOS] " @ fmt, ##__VA_ARGS__)
#else
#define RNHSUB_LOG(fmt, ...) ((void)0)
#endif

// Optional gesture trace (compile-time): set RNCV_ENABLE_HSUB_GEST_TRACE to 1
// for ENTER/EXIT site logs, pan state transitions, and pan recognizer wiring.
// Default 0 — no extra NSLog or per-gesture target overhead.
#ifndef RNCV_ENABLE_HSUB_GEST_TRACE
#define RNCV_ENABLE_HSUB_GEST_TRACE 0
#endif

// A/B toggle for H-2.1.1's deferred-frame logic. When 1, frame writes from
// -layoutSubviews apply immediately even when the scroll view is
// tracking/dragging/decelerating, and -_flushPendingScrollViewFrameIfNeeded
// becomes a no-op (nothing ever gets queued). Use this to confirm or rule
// out the deferred-frame flush as the source of the "H list goes dead at
// end of decel" wedge.
//
// Default 0 (defer logic active, matching H-2.1.1 behavior). Flip to 1 to
// reproduce the pre-H-2.1.1 immediate-apply path for comparison.
#ifndef RNCV_DISABLE_HSUB_DEFERRED_FRAME
#define RNCV_DISABLE_HSUB_DEFERRED_FRAME 0
#endif

#if RNCV_ENABLE_HSUB_GEST_TRACE

#define RNHGEST_LOG(fmt, ...) NSLog(@"[RNCV-HSUB-GEST] " @ fmt, ##__VA_ARGS__)

// Compact tracking-state tuple. "no-sv" when the wrapper hasn't promoted to a
// scroll view yet (initial Fabric commit before the dir prop arrives).
#define RNHGEST_SV_FLAGS(sv) \
  ((sv) ? [NSString stringWithFormat:@"track%d/drag%d/decel%d", \
            (sv).isTracking    ? 1 : 0, \
            (sv).isDragging    ? 1 : 0, \
            (sv).isDecelerating ? 1 : 0] \
        : @"no-sv")

// ENTER / EXIT pair for a method body. The ENTER captures a local timestamp
// (`__rnhgest_enter_t`) referenced by the matching EXIT to compute dt. Both
// macros are usable in the same function only — must be paired one-to-one.
//
// `fmt` arguments are C-string literals; RNHGEST_LOG promotes them to NSString
// via the standard Objective-C `@` prefix-concatenation idiom (see RNHSUB_LOG
// above for the same convention).
#define RNHGEST_TRACE_ENTER(siteName) \
  NSTimeInterval __rnhgest_enter_t = CACurrentMediaTime(); \
  RNHGEST_LOG("s=%d t=%.6f site=%s event=ENTER sv=%@", \
              _sectionIndex, __rnhgest_enter_t, siteName, \
              RNHGEST_SV_FLAGS(_scrollView))

#define RNHGEST_TRACE_EXIT(siteName) \
  RNHGEST_LOG("s=%d t=%.6f site=%s event=EXIT  dt=%.3fms sv=%@", \
              _sectionIndex, CACurrentMediaTime(), siteName, \
              (CACurrentMediaTime() - __rnhgest_enter_t) * 1000.0, \
              RNHGEST_SV_FLAGS(_scrollView))

static inline NSString *RNHGestStateToString(UIGestureRecognizerState s) {
  switch (s) {
    case UIGestureRecognizerStatePossible:  return @"Possible";
    case UIGestureRecognizerStateBegan:     return @"Began";
    case UIGestureRecognizerStateChanged:   return @"Changed";
    case UIGestureRecognizerStateEnded:     return @"Ended";  // == Recognized
    case UIGestureRecognizerStateCancelled: return @"Cancelled";
    case UIGestureRecognizerStateFailed:    return @"Failed";
  }
  return @"Unknown";
}

#else

#define RNHGEST_LOG(fmt, ...)            ((void)0)
#define RNHGEST_TRACE_ENTER(siteName)    ((void)0)
#define RNHGEST_TRACE_EXIT(siteName)     ((void)0)

#endif

// Snapshot the scroll view's geometry / scroll-related properties for inclusion
// in a single log line. Useful in event handlers where you want a one-shot
// dump of "what does UIKit think this scroll view is right now?".
#define RNHSUB_SV_SNAPSHOT(sv) \
  [NSString stringWithFormat: \
    @"frame=(%.1f,%.1f,%.1fx%.1f) bounds=(%.1f,%.1f,%.1fx%.1f) " \
    @"cs=(%.1fx%.1f) co=(%.1f,%.1f) inset=(t%.1f,l%.1f,b%.1f,r%.1f) " \
    @"adjInset=(t%.1f,l%.1f,b%.1f,r%.1f) " \
    @"scrollEn=%d bounceH=%d bounceV=%d dirLock=%d pagingEn=%d " \
    @"isDragging=%d isDecel=%d isTracking=%d", \
    (sv).frame.origin.x, (sv).frame.origin.y, \
    (sv).frame.size.width, (sv).frame.size.height, \
    (sv).bounds.origin.x, (sv).bounds.origin.y, \
    (sv).bounds.size.width, (sv).bounds.size.height, \
    (sv).contentSize.width, (sv).contentSize.height, \
    (sv).contentOffset.x, (sv).contentOffset.y, \
    (sv).contentInset.top, (sv).contentInset.left, \
    (sv).contentInset.bottom, (sv).contentInset.right, \
    (sv).adjustedContentInset.top, (sv).adjustedContentInset.left, \
    (sv).adjustedContentInset.bottom, (sv).adjustedContentInset.right, \
    (sv).scrollEnabled ? 1 : 0, \
    (sv).alwaysBounceHorizontal ? 1 : 0, \
    (sv).alwaysBounceVertical ? 1 : 0, \
    (sv).directionalLockEnabled ? 1 : 0, \
    (sv).pagingEnabled ? 1 : 0, \
    (sv).isDragging ? 1 : 0, \
    (sv).isDecelerating ? 1 : 0, \
    (sv).isTracking ? 1 : 0]

@interface RNCollectionSubContainerView () <RCTRNCollectionSubContainerViewProtocol>
@end

// ── Static scroll-offset registry ──────────────────────────────────────────
// Persists the last contentOffset.x per (layoutCacheId, sectionIndex) across
// Fabric recycle events so H sections can restore scroll position on remount.
// Key: @"cacheId:sectionIndex"  Value: NSNumber(CGFloat)
static NSMutableDictionary<NSString*, NSNumber*> *sSavedHScrollOffsets;

static NSString *_hScrollKey(int32_t cacheId, int32_t sectionIdx) {
  return [NSString stringWithFormat:@"%d:%d", cacheId, sectionIdx];
}

@implementation RNCollectionSubContainerView {
  // Optional UIScrollView (created when scrollDirection != 'none').
  UIScrollView *_scrollView;
  // Holds cells as subviews. Always present. When scrollable, sits inside _scrollView.
  UIView       *_contentView;

  // State from ShadowNode (rich ChildVisualState array).
  std::shared_ptr<const CollectionSubContainerShadowNode::ConcreteState> _state;

  // Cached props.
  int32_t       _sectionIndex;
  int32_t       _layoutCacheId;
  RNCollectionSubContainerScrollDirection _scrollDirection;
  CGSize        _propContentSize;

  // Scroll position restoration after Fabric recycle.
  // Set in updateProps when sectionIndex is assigned; applied once in
  // updateState after contentSize is valid so UIKit doesn't clamp the offset.
  CGFloat       _pendingRestoreScrollX;
  BOOL          _needsScrollRestore;

  // Throttle scroll events.
  NSTimeInterval _lastScrollEventTime;

  // Bounds that were active the last time _applyChildVisualStates ran from
  // layoutSubviews. Used to gate the cascade-cost: parent V-scroll triggers
  // the main container's Yoga relayout on every cell mount/unmount, which
  // cascades down to this wrapper's layoutSubviews even when our own bounds
  // didn't change. We re-apply child positions only when the wrapper itself
  // resized — updateState: handles the "real state changed" path separately.
  CGRect _lastAppliedBounds;

  // Pending _scrollView.frame value deferred from layoutSubviews because the
  // scroll view was actively tracking / dragging / decelerating at the time.
  // CGRectNull means "no pending update". See -layoutSubviews and the
  // scrollViewDidEnd* delegate hooks for the apply path.
  CGRect _pendingScrollViewFrame;

  // Last observed UIGestureRecognizerState for the inner scroll view's pan
  // recognizer (only updated when RNCV_ENABLE_HSUB_GEST_TRACE is 1).
  UIGestureRecognizerState _lastPanState;
}

@synthesize contentView = _contentView;

// ── Fabric registration ─────────────────────────────────────────────────────

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<CollectionSubContainerComponentDescriptor>();
}

// ── Init ────────────────────────────────────────────────────────────────────

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps =
        std::make_shared<const RNCollectionSubContainerProps>();
    _props = defaultProps;

    _sectionIndex          = 0;
    _layoutCacheId         = 0;
    _scrollDirection       = RNCollectionSubContainerScrollDirection::None;
    _propContentSize       = CGSizeZero;
    _shadowNodePositioned  = NO;
    _lastScrollEventTime   = 0;
    _lastAppliedBounds     = CGRectZero;
    _pendingScrollViewFrame = CGRectNull;
    _lastPanState          = UIGestureRecognizerStatePossible;

    // Default to non-scrollable: contentView is the immediate child of self.
    // _ensureScrollViewIfNeeded() will reparent it into a UIScrollView when
    // scrollDirection becomes != 'none' on first updateProps.
    //
    // No autoresizingMask. _contentView.frame is set explicitly in TWO places:
    //   - layoutSubviews (non-scrollable mode)         → _contentView.frame = self.bounds
    //   - updateProps / updateState / promote-to-scroll → _contentView.frame = (0, 0, contentSize)
    //
    // An autoresize mask would race those explicit assignments. The exact
    // failure mode we hit on device:
    //   1. _scrollView.bounds.height briefly drops to 0 during a parent V
    //      relayout transient (cell mount/unmount in the main container
    //      cascades a Yoga reflow that touches our wrapper's height).
    //   2. UIViewAutoresizingFlexibleHeight propagates that 0 into
    //      _contentView.frame.size.height = 0.
    //   3. The next gesture lands on a content view with zero height; the H
    //      sub-container appears blank and gestures stop responding because
    //      UIScrollView clamps contentOffset against (W, 0) bounds.
    // Logs caught this as `contentViewFrame=(0.0,0.0,1516.0x0.0)` after a
    // bounce. Removing the mask makes _contentView's frame purely a function
    // of explicit writes, which we already drive correctly.
    _contentView = [[UIView alloc] initWithFrame:self.bounds];
    _contentView.autoresizingMask = UIViewAutoresizingNone;
    _contentView.clipsToBounds = NO;
    [self addSubview:_contentView];

    self.clipsToBounds = YES;
    RNSUB_LOG("init");

#if DEBUG && RNCV_DEBUG_COLLECTION_VISUALS
    // Outline the H sub-container, the scroll view we install on promotion,
    // and its content view (see RNMeasuredCellView.mm: RNCV_DEBUG_COLLECTION_VISUALS).
    //
    //   self          -> thick yellow border  (the sub-container UIView)
    //   _scrollView   -> thick orange border  (set on promotion)
    //   _contentView  -> thick cyan   border  (inner scrollable content)
    //
    // Anything magenta/green/blue inside the yellow box is inside the H
    // sub-container. Anything overlapping the yellow box from outside is a
    // sibling in the main scroll view.
    self.layer.borderColor = [UIColor colorWithRed:1.00 green:0.85 blue:0.00 alpha:1.00].CGColor;
    self.layer.borderWidth = 2.0;
    self.accessibilityLabel = @"RNCollectionSubContainerView";

    _contentView.layer.borderColor = [UIColor colorWithRed:0.00 green:0.85 blue:0.95 alpha:1.00].CGColor;
    _contentView.layer.borderWidth = 2.0;
    _contentView.accessibilityLabel = @"HSub._contentView";
#endif
  }
  return self;
}

// ── Fabric recycling ────────────────────────────────────────────────────────

- (void)prepareForRecycle
{
  RNHGEST_TRACE_ENTER("prepareForRecycle");
  [super prepareForRecycle];

  // Save scroll position before resetting so it can be restored when this
  // section re-enters the V render range on a recycled native view.
  if (_scrollView && _layoutCacheId > 0 && _sectionIndex >= 0) {
    CGFloat ox = _scrollView.contentOffset.x;
    if (ox > 0.5f) { // Don't save near-zero; default is already 0
      if (!sSavedHScrollOffsets) sSavedHScrollOffsets = [NSMutableDictionary new];
      sSavedHScrollOffsets[_hScrollKey(_layoutCacheId, _sectionIndex)] = @(ox);
    }
  }

  _state = nullptr;
  _shadowNodePositioned = NO;
  _lastScrollEventTime  = 0;
  _propContentSize      = CGSizeZero;
  _lastAppliedBounds    = CGRectZero;
  _pendingScrollViewFrame = CGRectNull;
  _lastPanState         = UIGestureRecognizerStatePossible;
  _needsScrollRestore   = NO;
  _pendingRestoreScrollX = 0;

  if (_scrollView) {
    [_scrollView setContentOffset:CGPointZero animated:NO];
    _scrollView.contentSize = CGSizeZero;
  }
  _contentView.frame = self.bounds;
  RNSUB_LOG("prepareForRecycle");
  RNHGEST_TRACE_EXIT("prepareForRecycle");
}

// ── Layout authority for THIS wrapper (positioned + sized by parent) ───────
//
// Why we override BOTH origin AND size when the parent has positioned us:
//
// CollectionSubContainerShadowNode does not set an explicit Yoga style.height
// on the wrapper. Yoga therefore computes the wrapper's intrinsic height as
// the sum of its children's natural heights (default flex-direction: column).
// For an H sub-container with 8 cells of ~320pt each, that's ~2600pt — vastly
// larger than the section's actual allotted height (~343pt set by the layout
// engine via finalizeHSection in C++ / hSectionInfoFn in JS).
//
// What goes wrong if we let Yoga's intrinsic size reach self.frame:
//   1. self.frame.size grows from (W, 343) to (W, 2600) on a Fabric commit
//      whenever the H render window expands (e.g. fast bounce-back).
//   2. -layoutSubviews then propagates that growth into _scrollView.frame
//      (in IDLE state — the gesture-active guard would defer it).
//   3. UIKit re-tracks the active gesture against the new (much taller)
//      bounds. The bounce-back animation state becomes inconsistent; UIKit
//      snaps contentOffset back toward (0, 0) MID-DRAG.
//   4. On the next commit the parent main container's applyPositionsFromState
//      corrects self.frame back to (W, 343); the scroll view shrinks again.
//   5. The user sees a violent left/right oscillation during slow drags, and
//      a hard "snap" instead of a natural rubber-band bounce at the edges.
//
// The parent main container's ShadowNode is the SINGLE source of truth for
// this wrapper's geometry: its layout cache stores both the section's origin
// (sectionX, sectionY) and the section's size (containerWidth, sectionHeight),
// and applyPositionsFromState applies the full frame on every commit.
//
// Once the parent has positioned us (shadowNodePositioned = YES, set by the
// parent on first apply), self.frame is the authoritative geometry. Preserve
// it through subsequent Fabric commits — let neither origin nor size change.

- (void)updateLayoutMetrics:(const facebook::react::LayoutMetrics &)layoutMetrics
           oldLayoutMetrics:(const facebook::react::LayoutMetrics &)oldLayoutMetrics
{
  RNHGEST_TRACE_ENTER("updateLayoutMetrics");
  auto adjusted = layoutMetrics;
  if (_shadowNodePositioned) {
    // Authoritative geometry is set by the parent main container's
    // applyPositionsFromState — preserve it through subsequent commits.
    // See file-header comment block on Yoga vs. layout-cache authority.
    adjusted.frame.origin.x    = self.frame.origin.x;
    adjusted.frame.origin.y    = self.frame.origin.y;
    adjusted.frame.size.width  = self.frame.size.width;
    adjusted.frame.size.height = self.frame.size.height;
  } else if (self.frame.size.height > 0 && self.frame.size.width > 0) {
    // Defensive sub-pixel filter for the brief window before the parent has
    // claimed authority via shadowNodePositioned=YES (first commit only).
    //
    // C++ finalizeHSection rounds & hysteresis-stabilizes the wrapper height
    // in the layout cache (see CompositionalLayout::finalizeHSection), so
    // by the time the parent's applyPositionsFromState runs, the height is
    // already integer-point and stable across MVC cycles. This filter is
    // a backstop: if Yoga ever proposes a height delta < 0.5pt in this
    // pre-positioned window, ignore it. Real layout deltas are >= 1pt and
    // pass through unchanged.
    const CGFloat dh = std::abs((CGFloat)layoutMetrics.frame.size.height - self.frame.size.height);
    const CGFloat dw = std::abs((CGFloat)layoutMetrics.frame.size.width  - self.frame.size.width);
    if (dh < 0.5f) adjusted.frame.size.height = self.frame.size.height;
    if (dw < 0.5f) adjusted.frame.size.width  = self.frame.size.width;
  }
  [super updateLayoutMetrics:adjusted oldLayoutMetrics:oldLayoutMetrics];
  RNHGEST_TRACE_EXIT("updateLayoutMetrics");
}

// ── Props ───────────────────────────────────────────────────────────────────

- (void)updateProps:(const Props::Shared &)props
           oldProps:(const Props::Shared &)oldProps
{
  RNHGEST_TRACE_ENTER("updateProps");
  [super updateProps:props oldProps:oldProps];

  const auto &p =
      *std::static_pointer_cast<const RNCollectionSubContainerProps>(props);

  _sectionIndex   = p.sectionIndex;
  _layoutCacheId  = p.layoutCacheId;

  // Check for a saved scroll offset from a previous recycle of this section.
  // Defer actual application to updateState (after contentSize is set) so
  // UIKit doesn't clamp the offset to a zero-sized content area.
  if (_scrollView && sSavedHScrollOffsets) {
    NSString *key = _hScrollKey(_layoutCacheId, _sectionIndex);
    NSNumber *saved = sSavedHScrollOffsets[key];
    if (saved) {
      _pendingRestoreScrollX = saved.floatValue;
      _needsScrollRestore = YES;
      [sSavedHScrollOffsets removeObjectForKey:key]; // consume once
    }
  }

  // Lazily create / tear down the embedded scroll view based on scrollDirection.
  if (p.scrollDirection != _scrollDirection) {
    _scrollDirection = p.scrollDirection;
    [self _reconfigureScrollViewForDirection:_scrollDirection];
  }

  // Apply content size hints from props (layout.contentSize()).
  //
  // We track _propContentSize unconditionally so it can serve as the fallback
  // in updateState:, but we only forward it to _scrollView.contentSize when the
  // SCROLL-AXIS dimension changes by a non-trivial amount.
  //
  // Why we filter on the scroll-axis only:
  //
  // Cell heights coming from Yoga measurement drift by sub-pixel amounts pass-
  // to-pass (text rendering, image sizing, accumulated float rounding). For an
  // H sub-container, this surfaces as the section's contentHeight oscillating
  // between e.g. 342.7 ↔ 343.3 across consecutive Fabric commits. The width —
  // the actual horizontal scroll axis — stays at 1516 throughout.
  //
  // Setting `_scrollView.contentSize` mid-bounce (or mid-deceleration) makes
  // UIKit re-clamp `contentOffset` to the new content bounds and RESETS the
  // active rubber-band animation. Doing this on every commit during a bounce
  // turns a snappy 200ms rubber-band into a multi-second slow decay because:
  //   1. JS commits 6–10× per second (window edge cells flutter in/out at low
  //      bounce velocities — see C++ hysteresis in CollectionViewModule).
  //   2. Each commit fires this updateProps with a slightly different height.
  //   3. Each contentSize write restarts UIScrollView's decel timing.
  // The net effect: the scroll never gets to decelerate cleanly, and the
  // gesture engine can end up stuck in `isDecelerating=1` after the user
  // lifts, refusing further pan gestures until the limbo decel finally times
  // out.
  //
  // Cross-axis drift cannot affect horizontal scroll bounds in any meaningful
  // way (UIKit only clamps offset against the contentSize component on the
  // scroll axis). Skipping cross-axis-only contentSize updates is therefore
  // safe AND removes the bounce-disruption vector.
  //
  // The 0.5pt tolerance also absorbs scroll-axis sub-pixel jitter without
  // affecting the layout-meaningful threshold (cells are 180pt wide, gaps
  // are 8pt — 0.5pt is well below any user-visible signal).
  CGSize newSize = CGSizeMake((CGFloat)p.contentWidth, (CGFloat)p.contentHeight);
  CGSize prevPropSize = _propContentSize;
  BOOL appliedToScrollView = NO;
  if (!CGSizeEqualToSize(newSize, _propContentSize)) {
    _propContentSize = newSize;
    if (_scrollView && newSize.width > 0 && newSize.height > 0) {
      const CGSize svCS = _scrollView.contentSize;
      const CGFloat widthDelta  = std::abs(newSize.width  - svCS.width);
      const CGFloat heightDelta = std::abs(newSize.height - svCS.height);

      // contentView.frame: update on either axis to fix cross-axis sizing.
      if (widthDelta > 0.5f || heightDelta > 0.5f) {
        _contentView.frame = CGRectMake(0, 0, newSize.width, newSize.height);
      }

      // contentSize: only update on scroll-axis change to avoid bounce
      // disruption from cross-axis sub-pixel drift. See updateState for
      // the full rationale.
      const BOOL isHScroll =
          (_scrollDirection == RNCollectionSubContainerScrollDirection::Horizontal);
      const CGFloat scrollAxisDelta = isHScroll ? widthDelta : heightDelta;
      if (scrollAxisDelta > 0.5f) {
        _scrollView.contentSize = newSize;
        appliedToScrollView = YES;
      }
    }
  }

#if RNCV_ENABLE_HSUB_LOGS
  NSLog(@"[RNCV-HSUB-IOS-PROPS] s=%d dir=%d "
        @"newPropCS=(%.1fx%.1f) prevPropCS=(%.1fx%.1f) appliedToSV=%d "
        @"sv=%@",
        _sectionIndex, (int)_scrollDirection,
        newSize.width, newSize.height,
        prevPropSize.width, prevPropSize.height,
        appliedToScrollView ? 1 : 0,
        _scrollView ? RNHSUB_SV_SNAPSHOT(_scrollView) : @"(no scrollView)");
#endif
  RNHGEST_TRACE_EXIT("updateProps");
}

- (void)_reconfigureScrollViewForDirection:(RNCollectionSubContainerScrollDirection)dir
{
  RNHGEST_TRACE_ENTER("_reconfigureScrollViewForDirection");
  const BOOL needsScroll = (dir != RNCollectionSubContainerScrollDirection::None);

  if (needsScroll && !_scrollView) {
    // Promote: move _contentView into a fresh UIScrollView.
    //
    // No autoresize. _scrollView.frame is managed explicitly in -layoutSubviews
    // with a gesture-active guard. UIKit cancels the active pan recognizer
    // (UIGestureRecognizerStateCancelled) when a UIScrollView's frame is
    // rewritten while isTracking/isDragging/isDecelerating is true, which
    // leaves the scroll view in an isDragging=1 isDecel=1 isTracking=0 wedge
    // state and breaks subsequent gestures until the touch is released and
    // re-acquired. With FlexibleHeight, even after H-2.1 cut the JS round-
    // trip, any future source of self.bounds churn (real cell-content
    // resize, image load completing, etc.) would propagate into the scroll
    // view's frame mid-gesture and reproduce the wedge. Defending the scroll
    // view's frame here is independent of any single source of churn.
    _scrollView = [[UIScrollView alloc] initWithFrame:self.bounds];
    _scrollView.autoresizingMask = UIViewAutoresizingNone;
    _scrollView.delegate = self;
    _scrollView.scrollEnabled = YES;
    _scrollView.bounces = YES;
    _scrollView.showsHorizontalScrollIndicator = NO;
    _scrollView.showsVerticalScrollIndicator   = NO;

    if (dir == RNCollectionSubContainerScrollDirection::Horizontal) {
      _scrollView.alwaysBounceHorizontal = YES;
      _scrollView.alwaysBounceVertical   = NO;
      _scrollView.directionalLockEnabled = YES;
    } else {
      _scrollView.alwaysBounceHorizontal = NO;
      _scrollView.alwaysBounceVertical   = YES;
      _scrollView.directionalLockEnabled = YES;
    }

    [_contentView removeFromSuperview];
    [_scrollView addSubview:_contentView];
    [self addSubview:_scrollView];

#if DEBUG && RNCV_DEBUG_COLLECTION_VISUALS
    // Orange border: inner H UIScrollView (same macro as RNMeasuredCellView).
    _scrollView.layer.borderColor = [UIColor colorWithRed:1.00 green:0.45 blue:0.00 alpha:1.00].CGColor;
    _scrollView.layer.borderWidth = 2.0;
    _scrollView.accessibilityLabel = [NSString stringWithFormat:@"HSub._scrollView[s=%d]", _sectionIndex];
#endif

    if (!CGSizeEqualToSize(_propContentSize, CGSizeZero)) {
      _scrollView.contentSize = _propContentSize;
      _contentView.frame = CGRectMake(0, 0, _propContentSize.width, _propContentSize.height);
    }

#if RNCV_ENABLE_HSUB_GEST_TRACE
    // Observe pan recognizer state transitions (compile-time opt-in only).
    [_scrollView.panGestureRecognizer addTarget:self
                                         action:@selector(_panGestureStateChanged:)];
    _lastPanState = UIGestureRecognizerStatePossible;
#endif
  } else if (!needsScroll && _scrollView) {
    // Demote: detach _contentView from _scrollView and re-attach to self.
    // The pan recognizer is owned by _scrollView, so dropping the strong ref
    // also tears down our `_panGestureStateChanged:` target registration.
    [_contentView removeFromSuperview];
    [_scrollView removeFromSuperview];
    _scrollView.delegate = nil;
    _scrollView = nil;
    _lastPanState = UIGestureRecognizerStatePossible;
    _contentView.frame = self.bounds;
    [self addSubview:_contentView];
  } else if (needsScroll && _scrollView) {
    // Existing scroll view but axis changed.
    if (dir == RNCollectionSubContainerScrollDirection::Horizontal) {
      _scrollView.alwaysBounceHorizontal = YES;
      _scrollView.alwaysBounceVertical   = NO;
    } else {
      _scrollView.alwaysBounceHorizontal = NO;
      _scrollView.alwaysBounceVertical   = YES;
    }
  }
  RNHGEST_TRACE_EXIT("_reconfigureScrollViewForDirection");
}

// ── Child management ────────────────────────────────────────────────────────
// Cells land in _contentView, where their frames + transforms are applied
// from the ShadowNode-driven state in updateState:.
//
// IMPORTANT: Fabric does not guarantee that updateState: runs after every
// matching mountChildComponentView:. In practice for the H sub-container the
// order is:
//
//   1. updateState:                  ← childTags now lists the new tag(s)
//   2. _applyChildVisualStates       ← skips the new tag(s) as MISSING
//   3. mountChildComponentView:      ← the new subview gets added
//   4. (no further state arrives until the next user input)
//
// Step 3 leaves the new subview at its Yoga-default frame. The wrapper has
// no explicit child Yoga config, so Fabric/Yoga lays children out as a
// flex-direction: column stack: (0, 0), (0, h0), (0, h0+h1), …. The first
// new mount sits at (0, 0) — visible to the user as a duplicate cell next
// to the legitimate index-0 card at (10, 8). The rest of the new cells are
// stacked further down (clipped by self.clipsToBounds = YES).
//
// Re-applying visual states from mountChildComponentView: closes the race:
// the new subview's frame is corrected on the same CA commit, before the
// user ever sees the Yoga-stacked default position.
//
// _applyChildVisualStates iterates state.children with an eps-gated diff
// check, so the cost is one tagToView dictionary build + N near-no-op
// frame compares per mount. With our typical N (cells-in-window ≈ 5–8)
// this is well below the cost of one extra CA commit.

- (void)mountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView
                          index:(NSInteger)index
{
  RNHGEST_TRACE_ENTER("mountChildComponentView");
  [_contentView insertSubview:childComponentView atIndex:index];
  [self _applyChildVisualStates];
  RNHGEST_TRACE_EXIT("mountChildComponentView");
}

- (void)unmountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView
                            index:(NSInteger)index
{
  RNHGEST_TRACE_ENTER("unmountChildComponentView");
  [childComponentView removeFromSuperview];
  RNHGEST_TRACE_EXIT("unmountChildComponentView");
}

// ── State ───────────────────────────────────────────────────────────────────

- (void)updateState:(const facebook::react::State::Shared &)state
           oldState:(const facebook::react::State::Shared &)oldState
{
  RNHGEST_TRACE_ENTER("updateState");
  _state = std::static_pointer_cast<
      const CollectionSubContainerShadowNode::ConcreteState>(state);

  if (!_state) {
    RNHGEST_TRACE_EXIT("updateState");
    return;
  }

  const auto &data = _state->getData();

  // Apply content size to scroll view ONLY when both dims are strictly
  // positive AND the SCROLL-AXIS dimension actually changed by > 0.5pt.
  //
  // See the long comment in updateProps: above for the full explanation. Same
  // problem (sub-pixel cross-axis drift restarting the bounce / decel timing),
  // same fix (filter on the scroll axis only). This path fires from C++
  // ShadowNode commits which can churn even more than props during bounce.
  //
  // _propContentSize (from updateProps:) is the fallback when state contentSize
  // hasn't been written yet; if both signals are still zero we keep the last
  // valid _scrollView.contentSize untouched.
  CGSize prevSVCS = _scrollView ? _scrollView.contentSize : CGSizeZero;
  CGSize csIn = CGSizeMake(data.contentSize.width, data.contentSize.height);
  CGSize csApplied = csIn;
  BOOL didApplyCS = NO;
  if (_scrollView) {
    CGSize cs = csIn;
    if (cs.width <= 0)  cs.width  = _propContentSize.width;
    if (cs.height <= 0) cs.height = _propContentSize.height;
    csApplied = cs;
    if (cs.width > 0 && cs.height > 0) {
      const CGFloat widthDelta  = std::abs(cs.width  - prevSVCS.width);
      const CGFloat heightDelta = std::abs(cs.height - prevSVCS.height);

      // _contentView.frame: update on EITHER axis change (fixes cross-axis
      // height not filling the scrollview for H sections).
      if (widthDelta > 0.5f || heightDelta > 0.5f) {
        _contentView.frame = CGRectMake(0, 0, cs.width, cs.height);
      }

      // _scrollView.contentSize: ONLY update when the SCROLL-AXIS changes.
      // Writing contentSize during bounce/decel makes UIKit re-clamp the
      // offset and restart the rubber-band animation. Cross-axis drift from
      // sub-pixel font rounding (342.7↔343.3) fires 6-10x/sec during a
      // bounce, truncating it visibly. The cross-axis dimension of contentSize
      // doesn't affect scroll bounds for single-axis scrollviews, so it's
      // safe to defer.
      const BOOL isHScroll =
          (_scrollDirection == RNCollectionSubContainerScrollDirection::Horizontal);
      const CGFloat scrollAxisDelta = isHScroll ? widthDelta : heightDelta;
      if (scrollAxisDelta > 0.5f) {
        _scrollView.contentSize = cs;
        didApplyCS = YES;
      }
    }

    // Restore saved scroll position after contentSize is valid.
    // Deferred from updateProps so UIKit doesn't clamp to zero-size bounds.
    // Guard against firing during active bounce — only restore when idle.
    if (_needsScrollRestore && csApplied.width > 0 &&
        !_scrollView.isDecelerating && !_scrollView.isDragging) {
      CGFloat maxX = csApplied.width - _scrollView.bounds.size.width;
      if (maxX < 0) maxX = 0;
      CGFloat targetX = _pendingRestoreScrollX < maxX ? _pendingRestoreScrollX : maxX;
      [_scrollView setContentOffset:CGPointMake(targetX, 0) animated:NO];
      _needsScrollRestore = NO;
      _pendingRestoreScrollX = 0;
    }

    // H-list MVC: apply horizontal scroll correction if an anchor was snapshotted.
    // Computed from LayoutCache after applyMeasurements wrote final H item positions.
    // Applied immediately (no deceleration guard) — same timing as V-scroll MVC.
    if (_layoutCacheId > 0 && _sectionIndex >= 0) {
      auto cache = facebook::react::layoutCacheForId(_layoutCacheId);
      if (cache) {
        const double correction = cache->computeHCorrection(_sectionIndex);
        if (std::fabs(correction) > 0.5 && csApplied.width > 0) {
          CGFloat newX = _scrollView.contentOffset.x + (CGFloat)correction;
          CGFloat maxX = csApplied.width - _scrollView.bounds.size.width;
          if (maxX < 0) maxX = 0;
          newX = MAX(0, MIN(newX, maxX));
          [_scrollView setContentOffset:CGPointMake(newX, 0) animated:NO];
        }
      }
    }
  }

#if RNCV_ENABLE_HSUB_LOGS
  NSLog(@"[RNCV-HSUB-IOS-STATE] s=%d childCount=%zu "
        @"stateCS=(%.1fx%.1f) propCS=(%.1fx%.1f) afterFallback=(%.1fx%.1f) "
        @"prevSVCS=(%.1fx%.1f) didApplyCS=%d "
        @"contentViewFrame=(%.1f,%.1f,%.1fx%.1f) "
        @"sv=%@",
        _sectionIndex, data.children.size(),
        csIn.width, csIn.height,
        _propContentSize.width, _propContentSize.height,
        csApplied.width, csApplied.height,
        prevSVCS.width, prevSVCS.height,
        didApplyCS ? 1 : 0,
        _contentView.frame.origin.x, _contentView.frame.origin.y,
        _contentView.frame.size.width, _contentView.frame.size.height,
        _scrollView ? RNHSUB_SV_SNAPSHOT(_scrollView) : @"(no scrollView)");
#endif

  [self _applyChildVisualStates];
  RNHGEST_TRACE_EXIT("updateState");
}

// ── layoutSubviews ──────────────────────────────────────────────────────────
// Re-apply child positions only when our own bounds actually changed.
//
// Why the gate matters: every cell mount/unmount in the parent main container
// triggers Yoga to relayout its direct children, which cascades down to this
// wrapper's layoutSubviews — even when our bounds are unchanged. Without the
// gate, every V scroll tick during fast scrolling re-runs _applyChildVisualStates
// (NSDictionary build + per-child eps comparison + setFrame for any drift) for
// every H sub-container on screen. With H-3.5's wider H window mounting more
// children, this is the dominant V-scroll jank source.
//
// State-driven changes (real frame deltas after a Fabric commit) still flow
// through updateState: → _applyChildVisualStates, so this gate only suppresses
// the no-op path.

- (void)layoutSubviews
{
  RNHGEST_TRACE_ENTER("layoutSubviews");
  [super layoutSubviews];

  // Keep _contentView frame in sync with bounds when not scrollable.
  if (!_scrollView) {
    _contentView.frame = self.bounds;
  } else {
    // Explicit _scrollView.frame management with a gesture-active guard.
    //
    // Setting a UIScrollView's frame while isTracking / isDragging /
    // isDecelerating is true CANCELS the active pan recognizer
    // (UIGestureRecognizerStateCancelled) and leaves UIKit in an
    // isDragging=1 isDecel=1 isTracking=0 wedge state. The user's symptom
    // is "bounce decays slowly and then no further gestures register until
    // I lift my finger and tap again." See _reconfigureScrollViewForDirection
    // for the full rationale.
    //
    // If the scroll view is busy when self.bounds changes, defer the frame
    // write into _pendingScrollViewFrame and apply it on scroll-end. The
    // user-visible cost of the deferral is at most a 1-2pt cropping mismatch
    // until the gesture ends, which is hidden by self.clipsToBounds = YES.
    [self _applyOrDeferScrollViewFrame];
  }

  BOOL boundsChanged = !CGRectEqualToRect(self.bounds, _lastAppliedBounds);
#if RNCV_ENABLE_HSUB_LOGS
  NSLog(@"[RNCV-HSUB-IOS-LAYOUT] s=%d boundsChanged=%d "
        @"selfBounds=(%.1f,%.1f,%.1fx%.1f) lastApplied=(%.1f,%.1f,%.1fx%.1f) "
        @"sv=%@",
        _sectionIndex, boundsChanged ? 1 : 0,
        self.bounds.origin.x, self.bounds.origin.y,
        self.bounds.size.width, self.bounds.size.height,
        _lastAppliedBounds.origin.x, _lastAppliedBounds.origin.y,
        _lastAppliedBounds.size.width, _lastAppliedBounds.size.height,
        _scrollView ? RNHSUB_SV_SNAPSHOT(_scrollView) : @"(no scrollView)");
#endif
  if (boundsChanged) {
    _lastAppliedBounds = self.bounds;
    [self _applyChildVisualStates];
  }
  RNHGEST_TRACE_EXIT("layoutSubviews");
}

// Apply self.bounds to _scrollView.frame when the scroll view is idle.
// When the scroll view is busy (tracking/dragging/decelerating), record the
// pending target so it can be applied from a scroll-end delegate callback.
- (void)_applyOrDeferScrollViewFrame
{
  RNHGEST_TRACE_ENTER("_applyOrDeferScrollViewFrame");
  if (!_scrollView) {
    RNHGEST_TRACE_EXIT("_applyOrDeferScrollViewFrame");
    return;
  }

  if (CGRectEqualToRect(_scrollView.frame, self.bounds)) {
    _pendingScrollViewFrame = CGRectNull;
    RNHGEST_TRACE_EXIT("_applyOrDeferScrollViewFrame");
    return;
  }

  const BOOL svBusy = _scrollView.isTracking ||
                      _scrollView.isDragging ||
                      _scrollView.isDecelerating;
#if RNCV_DISABLE_HSUB_DEFERRED_FRAME
  // A/B test mode: bypass the H-2.1.1 defer-and-flush pathway. Apply the
  // frame change immediately even when the scroll view is busy. This will
  // re-introduce the original symptoms H-2.1.1 was masking (recognizer
  // cancellation mid-drag, isDragging=1 isDecel=1 wedge state) but isolates
  // the deferred-flush as either the cause of the post-decel "H list dead"
  // wedge or not.
  const BOOL deferAllowed = NO;
#else
  const BOOL deferAllowed = YES;
#endif
  if (svBusy && deferAllowed) {
    _pendingScrollViewFrame = self.bounds;
#if RNCV_ENABLE_HSUB_LOGS
    NSLog(@"[RNCV-HSUB-IOS-LAYOUT] s=%d DEFER svFrame=(%.1f,%.1f,%.1fx%.1f) "
          @"target=(%.1f,%.1f,%.1fx%.1f) busy=tracking%d/drag%d/decel%d",
          _sectionIndex,
          _scrollView.frame.origin.x, _scrollView.frame.origin.y,
          _scrollView.frame.size.width, _scrollView.frame.size.height,
          self.bounds.origin.x, self.bounds.origin.y,
          self.bounds.size.width, self.bounds.size.height,
          _scrollView.isTracking ? 1 : 0,
          _scrollView.isDragging ? 1 : 0,
          _scrollView.isDecelerating ? 1 : 0);
#endif
    RNHGEST_TRACE_EXIT("_applyOrDeferScrollViewFrame");
    return;
  }

  _scrollView.frame = self.bounds;
  _pendingScrollViewFrame = CGRectNull;
  RNHGEST_TRACE_EXIT("_applyOrDeferScrollViewFrame");
}

// Apply any deferred _scrollView.frame target. Called from the scroll-end
// delegate hooks below (drag-end without decel, decel-end).
- (void)_flushPendingScrollViewFrameIfNeeded
{
  RNHGEST_TRACE_ENTER("_flushPendingScrollViewFrameIfNeeded");
  if (!_scrollView) {
    RNHGEST_TRACE_EXIT("_flushPendingScrollViewFrameIfNeeded");
    return;
  }
  if (CGRectIsNull(_pendingScrollViewFrame)) {
    RNHGEST_TRACE_EXIT("_flushPendingScrollViewFrameIfNeeded");
    return;
  }
  // Re-resolve against current bounds — they may have moved on while the
  // gesture was active. self.bounds is the up-to-date authoritative value.
  CGRect target = self.bounds;
  CGRect prev = _scrollView.frame;
  BOOL didApply = !CGRectEqualToRect(prev, target);
  if (didApply) {
    _scrollView.frame = target;
  }
  _pendingScrollViewFrame = CGRectNull;
  RNHGEST_TRACE_EXIT("_flushPendingScrollViewFrameIfNeeded");
}

// ── Apply ChildVisualState array to subviews via tag map ────────────────────

- (void)_applyChildVisualStates
{
  RNHGEST_TRACE_ENTER("_applyChildVisualStates");
  if (!_state) {
    RNHGEST_TRACE_EXIT("_applyChildVisualStates");
    return;
  }

  const auto &data = _state->getData();
  const auto &children  = data.children;
  const auto &childTags = data.childTags;

  NSArray<UIView *> *subviews = _contentView.subviews;
#if RNCV_ENABLE_HSUB_LOGS
  NSLog(@"[RNCV-HSUB-IOS-APPLY] s=%d children=%zu tags=%zu subviews=%lu",
        _sectionIndex, children.size(), childTags.size(),
        (unsigned long)subviews.count);
#endif
  if (children.empty() || subviews.count == 0) {
    RNHGEST_TRACE_EXIT("_applyChildVisualStates");
    return;
  }

  // Build tag → UIView map for identity-based lookup. Same rationale as the
  // main container: Fabric's reconciler "last index" optimization can leave
  // native subview order out of sync with ShadowNode child order.
  NSMutableDictionary<NSNumber *, UIView *> *tagToView =
      [NSMutableDictionary dictionaryWithCapacity:subviews.count];
  for (UIView *sv in subviews) {
    tagToView[@(sv.tag)] = sv;
  }

  static const CGFloat kEps = 0.1f;

#if RNCV_ENABLE_HSUB_LOGS
  // Track target X positions to surface duplicates. Same target X across two
  // distinct child indices is the smoking gun for the user's "2 cards rendered
  // on top of each other at index 0" report.
  NSMutableDictionary<NSNumber *, NSNumber *> *xToFirstIndex =
      [NSMutableDictionary dictionary];
  int missingTagCount = 0;
#endif

  for (size_t i = 0; i < children.size() && i < childTags.size(); i++) {
    UIView *child = tagToView[@(childTags[i])];
    if (!child) {
#if RNCV_ENABLE_HSUB_LOGS
      missingTagCount++;
      NSLog(@"[RNCV-HSUB-IOS-APPLY] s=%d MISSING tag=%d at i=%zu",
            _sectionIndex, childTags[i], i);
#endif
      continue;
    }

    const auto &cv = children[i];

    const CGFloat targetX = cv.x;
    const CGFloat targetY = cv.y;
    const CGFloat targetW = cv.w;
    const CGFloat targetH = cv.h;
    if (targetW <= 0 || targetH <= 0) {
#if RNCV_ENABLE_HSUB_LOGS
      NSLog(@"[RNCV-HSUB-IOS-APPLY] s=%d SKIP-ZERO i=%zu tag=%d "
            @"target=(%.1f,%.1f,%.1fx%.1f)",
            _sectionIndex, i, childTags[i],
            targetX, targetY, targetW, targetH);
#endif
      continue;
    }

#if RNCV_ENABLE_HSUB_LOGS
    {
      NSNumber *xKey = @((int)roundf((float)targetX));
      NSNumber *firstIdx = xToFirstIndex[xKey];
      if (firstIdx) {
        NSLog(@"[RNCV-HSUB-IOS-DUP] s=%d DUPLICATE-X target=%.1f "
              @"i=%zu tag=%d collides with i=%@ (target frame is the same)",
              _sectionIndex, targetX, i, childTags[i], firstIdx);
      } else {
        xToFirstIndex[xKey] = @(i);
      }
    }
#endif

    // Frame application (preserve transform — apply via bounds + center
    // when an active transform is present, like the main container does).
    const BOOL hasActiveTransform = !CGAffineTransformIsIdentity(child.transform) ||
        !CATransform3DIsIdentity(child.layer.transform) || cv.hasTransform;
    const CGFloat curNX = hasActiveTransform
        ? (child.center.x - child.bounds.size.width  * 0.5f)
        : child.frame.origin.x;
    const CGFloat curNY = hasActiveTransform
        ? (child.center.y - child.bounds.size.height * 0.5f)
        : child.frame.origin.y;
    const CGFloat curNW = hasActiveTransform ? child.bounds.size.width  : child.frame.size.width;
    const CGFloat curNH = hasActiveTransform ? child.bounds.size.height : child.frame.size.height;

    const BOOL diffX = std::abs(curNX - targetX) > kEps;
    const BOOL diffY = std::abs(curNY - targetY) > kEps;
    const BOOL diffW = std::abs(curNW - targetW) > kEps;
    const BOOL diffH = std::abs(curNH - targetH) > kEps;

#if RNCV_ENABLE_HSUB_LOGS
    NSLog(@"[RNCV-HSUB-IOS-APPLY] s=%d i=%zu tag=%d "
          @"target=(%.1f,%.1f,%.1fx%.1f) cur=(%.1f,%.1f,%.1fx%.1f) "
          @"diff=(x%d,y%d,w%d,h%d) hasTransform=%d alpha=%.2f z=%.0f",
          _sectionIndex, i, childTags[i],
          targetX, targetY, targetW, targetH,
          curNX, curNY, curNW, curNH,
          diffX ? 1 : 0, diffY ? 1 : 0, diffW ? 1 : 0, diffH ? 1 : 0,
          hasActiveTransform ? 1 : 0, cv.opacity, cv.zIndex);
#endif

    // Always claim authority over this cell's position, even when the
    // current frame already matches our target. Otherwise a child that
    // happens to mount with a Yoga-default frame coincidentally equal
    // to our target would later be moved by a Yoga reflow because the
    // flag was never raised.
    if ([child isKindOfClass:[RNMeasuredCellView class]]) {
      RNMeasuredCellView *cellChild = (RNMeasuredCellView *)child;
      if (!cellChild.shadowNodePositioned) {
        cellChild.shadowNodePositioned = YES;
      }
    }

    if (diffX || diffY || diffW || diffH) {
      if (hasActiveTransform) {
        child.bounds = CGRectMake(0, 0, targetW, targetH);
        child.center = CGPointMake(targetX + targetW * 0.5f, targetY + targetH * 0.5f);
      } else {
        child.frame = CGRectMake(targetX, targetY, targetW, targetH);
      }
    }

    // Opacity (skip when 1.0 to avoid no-op CALayer dirties).
    if (std::abs(child.alpha - cv.opacity) > 1e-3) {
      child.alpha = cv.opacity;
    }

    // Z-ordering. Use layer.zPosition for sub-frame z control without
    // requiring subview reordering.
    if (std::abs(child.layer.zPosition - cv.zIndex) > 1e-3) {
      child.layer.zPosition = cv.zIndex;
    }

    // Transform. Skip when identity to avoid re-rasterization cost.
    if (cv.hasTransform) {
      // Convert our 16-Float column-major matrix into a CATransform3D.
      CATransform3D t;
      t.m11 = cv.transform[0];  t.m12 = cv.transform[1];  t.m13 = cv.transform[2];  t.m14 = cv.transform[3];
      t.m21 = cv.transform[4];  t.m22 = cv.transform[5];  t.m23 = cv.transform[6];  t.m24 = cv.transform[7];
      t.m31 = cv.transform[8];  t.m32 = cv.transform[9];  t.m33 = cv.transform[10]; t.m34 = cv.transform[11];
      t.m41 = cv.transform[12]; t.m42 = cv.transform[13]; t.m43 = cv.transform[14]; t.m44 = cv.transform[15];

      if (!CATransform3DEqualToTransform(child.layer.transform, t)) {
        child.layer.transform = t;
      }
    } else if (!CATransform3DIsIdentity(child.layer.transform)) {
      // Layout dropped its transform — restore identity.
      child.layer.transform = CATransform3DIdentity;
    }
  }

#if RNCV_ENABLE_HSUB_LOGS
  NSLog(@"[RNCV-HSUB-IOS-APPLY] s=%d DONE missingTags=%d uniqueTargetXs=%lu "
        @"(if uniqueTargetXs < children.size, expect overlapping cards)",
        _sectionIndex, missingTagCount,
        (unsigned long)xToFirstIndex.count);
#endif
  RNHGEST_TRACE_EXIT("_applyChildVisualStates");
}

#if RNCV_ENABLE_HSUB_GEST_TRACE
// Pan recognizer state trace — only compiled when RNCV_ENABLE_HSUB_GEST_TRACE is 1.
- (void)_panGestureStateChanged:(UIPanGestureRecognizer *)recognizer
{
  UIGestureRecognizerState newState = recognizer.state;
  RNHGEST_LOG("s=%d t=%.6f site=panGesture transition=%@->%@ sv=%@",
              _sectionIndex, CACurrentMediaTime(),
              RNHGestStateToString(_lastPanState),
              RNHGestStateToString(newState),
              RNHGEST_SV_FLAGS(_scrollView));
  _lastPanState = newState;
}
#endif

// ── UIScrollViewDelegate ────────────────────────────────────────────────────

- (void)scrollViewDidScroll:(UIScrollView *)scrollView
{
  // Throttle to ~60fps.
  NSTimeInterval now = CACurrentMediaTime();
  BOOL throttled = (now - _lastScrollEventTime < 0.016);
#if RNCV_ENABLE_HSUB_LOGS
  NSLog(@"[RNCV-HSUB-IOS-SCROLL] s=%d throttled=%d sv=%@",
        _sectionIndex, throttled ? 1 : 0, RNHSUB_SV_SNAPSHOT(scrollView));
#endif
  if (throttled) return;
  _lastScrollEventTime = now;

  if (!_eventEmitter) return;
  auto emitter = std::static_pointer_cast<
      const RNCollectionSubContainerEventEmitter>(_eventEmitter);

  RNCollectionSubContainerEventEmitter::OnSubScroll event;
  event.sectionIndex = _sectionIndex;
  event.scrollX      = scrollView.contentOffset.x;
  event.scrollY      = scrollView.contentOffset.y;
  emitter->onSubScroll(event);
}

// Scroll-end hooks flush any _scrollView.frame update that was deferred from
// -layoutSubviews because the scroll view was busy at the time. By the time
// these fire, the gesture / decel animation is fully torn down and rewriting
// the frame is safe (no recognizer to cancel).

- (void)scrollViewDidEndDragging:(UIScrollView *)scrollView
                  willDecelerate:(BOOL)decelerate
{
  RNHGEST_TRACE_ENTER("scrollViewDidEndDragging");
  if (!decelerate) {
    [self _flushPendingScrollViewFrameIfNeeded];
  }
  RNHGEST_TRACE_EXIT("scrollViewDidEndDragging");
}

- (void)scrollViewDidEndDecelerating:(UIScrollView *)scrollView
{
  RNHGEST_TRACE_ENTER("scrollViewDidEndDecelerating");
  [self _flushPendingScrollViewFrameIfNeeded];
  RNHGEST_TRACE_EXIT("scrollViewDidEndDecelerating");
}

- (void)scrollViewDidEndScrollingAnimation:(UIScrollView *)scrollView
{
  RNHGEST_TRACE_ENTER("scrollViewDidEndScrollingAnimation");
  [self _flushPendingScrollViewFrameIfNeeded];
  RNHGEST_TRACE_EXIT("scrollViewDidEndScrollingAnimation");
}

@end

// Required export for Fabric component registry.
Class<RCTComponentViewProtocol> RNCollectionSubContainerCls(void)
{
  return RNCollectionSubContainerView.class;
}
