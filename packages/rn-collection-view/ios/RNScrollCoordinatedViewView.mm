#import "RNScrollCoordinatedViewView.h"

#import <react/renderer/components/RNCollectionViewSpec/ComponentDescriptors.h>
#import <react/renderer/components/RNCollectionViewSpec/EventEmitters.h>
#import <react/renderer/components/RNCollectionViewSpec/Props.h>
#import <react/renderer/components/RNCollectionViewSpec/RCTComponentViewHelpers.h>

#import <React/RCTFabricComponentsPlugins.h>

using namespace facebook::react;

#ifndef RNCV_ENABLE_STICKY_TRACE
#define RNCV_ENABLE_STICKY_TRACE 0
#endif

#if DEBUG && RNCV_ENABLE_STICKY_TRACE
  #define RNCV_IOS_STICKY_LOG(...) NSLog(__VA_ARGS__)
#else
  #define RNCV_IOS_STICKY_LOG(...) ((void)0)
#endif

// String→enum for behavior prop.
static inline bool isPush(RNScrollCoordinatedViewBehavior b) {
  return b == RNScrollCoordinatedViewBehavior::Push;
}

@interface RNScrollCoordinatedViewView () <RCTRNScrollCoordinatedViewViewProtocol>
@end

@implementation RNScrollCoordinatedViewView {
  __weak UIScrollView *_parentScrollView;
  BOOL _observing;

  // Cached props — read on UI thread in KVO callback.
  CGFloat _boundaryY;
  CGFloat _headerHeight;
  BOOL    _isPush;
  BOOL    _enabled;
  BOOL    _isFooter;
}

// ── Fabric registration ──────────────────────────────────────────────────────

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<RNScrollCoordinatedViewComponentDescriptor>();
}

// ── Init ─────────────────────────────────────────────────────────────────────

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const RNScrollCoordinatedViewProps>();
    _props       = defaultProps;
    _boundaryY   = CGFLOAT_MAX;
    _headerHeight = 0;
    _isPush      = YES;    // default behavior = push
    _enabled     = YES;
    _isFooter    = NO;
    _observing   = NO;
  }
  return self;
}

- (void)dealloc
{
  [self _stopObserving];
}

// ── Layout metrics ────────────────────────────────────────────────────────────
//
// Fabric calls this when Yoga assigns a new frame to the view.  The base class
// sets center/bounds from the Yoga-computed natural position but does NOT touch
// layer.transform.  If a sticky translate is active the view would appear at
// naturalY + staleTranslate — visually wrong.  Re-apply the transform
// immediately so the correct visual position is established.

- (void)updateLayoutMetrics:(const facebook::react::LayoutMetrics &)layoutMetrics
           oldLayoutMetrics:(const facebook::react::LayoutMetrics &)oldLayoutMetrics
{
  [super updateLayoutMetrics:layoutMetrics oldLayoutMetrics:oldLayoutMetrics];
  [self _applyTransform];
}

// ── Props ─────────────────────────────────────────────────────────────────────

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps
{
  [super updateProps:props oldProps:oldProps];

  const auto &newProps = *std::static_pointer_cast<const RNScrollCoordinatedViewProps>(props);

  _boundaryY    = newProps.boundaryY;
  _headerHeight = newProps.headerHeight;
  _isPush       = isPush(newProps.behavior);
  _enabled      = newProps.enabled;
  _isFooter     = (newProps.kind == "footer");

  // Re-apply transform immediately with current scroll position.
  [self _applyTransform];
}

// ── View hierarchy — find parent UIScrollView ────────────────────────────────

- (void)didMoveToWindow
{
  [super didMoveToWindow];

  if (self.window) {
    [self _findAndObserveScrollView];
  } else {
    [self _stopObserving];
  }
}

- (void)didMoveToSuperview
{
  [super didMoveToSuperview];

  // Re-search if we're reparented (e.g. cell recycling, though we don't recycle).
  if (self.superview && self.window) {
    [self _findAndObserveScrollView];
  }
}

- (void)layoutSubviews
{
  [super layoutSubviews];

  // Fabric may assemble the view hierarchy after didMoveToWindow / didMoveToSuperview.
  // layoutSubviews is a reliable late hook — the hierarchy is fully connected by now.
  if (!_observing && self.window) {
    [self _findAndObserveScrollView];
  }

  // Recompute the sticky transform whenever our geometry changes.
  // applyPositionsFromState (in the container view) sets our bounds+center,
  // which marks us as needing layout and lands here.  Without this call,
  // the transform stays stale until the next scroll event fires KVO.
  [self _applyTransform];
}

- (void)_findAndObserveScrollView
{
  [self _stopObserving];

  UIView *v = self.superview;
  while (v) {
    if ([v isKindOfClass:[UIScrollView class]]) {
      _parentScrollView = (UIScrollView *)v;
      break;
    }
    v = v.superview;
  }

  if (_parentScrollView) {
    [_parentScrollView addObserver:self
                        forKeyPath:@"contentOffset"
                           options:NSKeyValueObservingOptionNew
                           context:nil];
    _observing = YES;

    // Apply immediately so the view starts at the correct position.
    [self _applyTransform];
  }
}

- (void)_stopObserving
{
  if (_observing && _parentScrollView) {
    @try {
      [_parentScrollView removeObserver:self forKeyPath:@"contentOffset"];
    } @catch (NSException *e) {
      // Already removed — ignore.
    }
  }
  _observing = NO;
  _parentScrollView = nil;
}

// ── KVO — fires on UI thread, same run loop as scroll ────────────────────────

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey,id> *)change
                       context:(void *)context
{
  if ([keyPath isEqualToString:@"contentOffset"]) {
    [self _applyTransform];
  }
}

// ── Transform computation ────────────────────────────────────────────────────

- (void)_applyTransform
{
  if (!_enabled || !_parentScrollView) {
    self.layer.transform = CATransform3DIdentity;
    return;
  }

  // Skip if Fabric hasn't laid us out yet (bounds are zero on the first frame
  // after mount — applying a transform here would flash the view at (0,0)).
  if (self.bounds.size.height <= 0) return;

  CGFloat scrollY = _parentScrollView.contentOffset.y;
  CGFloat viewportH = _parentScrollView.bounds.size.height;

  // Derive naturalY from the view's actual Fabric-managed position.
  // self.center and self.bounds are independent of self.layer.transform,
  // so this always reflects the true layout position even while a transform
  // is active.  This eliminates sync issues with the JS-side prop which can
  // lag behind as variable heights are measured and positions shift.
  CGFloat naturalY = self.center.y - self.bounds.size.height * 0.5;
  CGFloat translateY;
  CGFloat desiredTop = 0.0;

  if (_isFooter) {
    // Footer pins to viewport bottom: desiredTop = scrollY + viewportH - height
    // translate = min(0, desiredTop - naturalY), with optional push boundary.
    desiredTop = scrollY + viewportH - _headerHeight;
    if (_isPush) {
      // boundaryY = section start Y (header or first item). Footer shouldn't
      // be pulled above it. Use MAX so we pick the LESS negative value —
      // constraining upward movement, not exaggerating it.
      CGFloat minTranslate = _boundaryY - naturalY;
      translateY = MIN(0.0, MAX(desiredTop - naturalY, minTranslate));
    } else {
      translateY = MIN(0.0, desiredTop - naturalY);
    }
  } else {
    // Header pins to viewport top: translate = max(0, scrollY - naturalY), with push boundary.
    if (_isPush) {
      CGFloat maxTranslate = _boundaryY - naturalY - _headerHeight;
      translateY = MAX(0.0, MIN(scrollY - naturalY, maxTranslate));
    } else {
      translateY = MAX(0.0, scrollY - naturalY);
    }
  }

  self.layer.transform = CATransform3DMakeTranslation(0, translateY, 0);

  // Elevate z when actively sticky (translated > 0) so it floats above siblings.
  self.layer.zPosition = fabs(translateY) > 0.1 ? 100 : 0;
}

@end

// Required export for Fabric component registry.
Class<RCTComponentViewProtocol> RNScrollCoordinatedViewCls(void)
{
  return RNScrollCoordinatedViewView.class;
}
