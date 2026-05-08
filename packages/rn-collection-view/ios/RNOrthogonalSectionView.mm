#import "RNOrthogonalSectionView.h"

// Codegen-generated helpers (same spec namespace as the rest of the package).
#import <react/renderer/components/RNCollectionViewSpec/ComponentDescriptors.h>
#import <react/renderer/components/RNCollectionViewSpec/EventEmitters.h>
#import <react/renderer/components/RNCollectionViewSpec/Props.h>
#import <react/renderer/components/RNCollectionViewSpec/RCTComponentViewHelpers.h>

#import <React/RCTFabricComponentsPlugins.h>

using namespace facebook::react;

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
  }
  return self;
}

// ── Fabric recycling ─────────────────────────────────────────────────────────

- (void)prepareForRecycle
{
  [super prepareForRecycle];
  _sectionIndex = 0;
  _contentWidth = 0;
  _lastScrollEventTime = 0;
  [_scrollView setContentOffset:CGPointZero animated:NO];
  _scrollView.contentSize = CGSizeZero;
  _contentView.frame = CGRectZero;
}

// ── Child management ─────────────────────────────────────────────────────────
// Fabric mounts H-section cells as children of this view.
// They land in _contentView, absolutely positioned along the H axis.

- (void)mountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView
                          index:(NSInteger)index
{
  [_contentView insertSubview:childComponentView atIndex:index];
}

- (void)unmountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView
                            index:(NSInteger)index
{
  [childComponentView removeFromSuperview];
}

// ── Props ────────────────────────────────────────────────────────────────────

- (void)updateProps:(const Props::Shared &)props
           oldProps:(const Props::Shared &)oldProps
{
  [super updateProps:props oldProps:oldProps];

  const auto &p =
      *std::static_pointer_cast<const RNOrthogonalSectionViewProps>(props);

  _sectionIndex = p.sectionIndex;

  if (p.contentWidth != _contentWidth) {
    _contentWidth = p.contentWidth;
    // Update scroll content size width; height matches our own bounds height.
    _scrollView.contentSize = CGSizeMake(_contentWidth,
                                         _scrollView.bounds.size.height);
    _contentView.frame = CGRectMake(0, 0, _contentWidth,
                                    _scrollView.bounds.size.height);
  }
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

// ── Layout ───────────────────────────────────────────────────────────────────

- (void)layoutSubviews
{
  [super layoutSubviews];

  if (!CGRectEqualToRect(_scrollView.frame, self.bounds)) {
    _scrollView.frame = self.bounds;
  }

  // Keep content size in sync with current bounds height (height may change
  // as items measure and MVC updates the section height).
  CGSize needed = CGSizeMake(MAX(_contentWidth, self.bounds.size.width),
                             self.bounds.size.height);
  if (!CGSizeEqualToSize(_scrollView.contentSize, needed)) {
    _scrollView.contentSize = needed;
    _contentView.frame = CGRectMake(0, 0, needed.width, needed.height);
  }
}

@end

// ── Fabric export ─────────────────────────────────────────────────────────────
// Required: lets Fabric's component registry find this class.

Class<RCTComponentViewProtocol> RNOrthogonalSectionViewCls(void)
{
  return RNOrthogonalSectionView.class;
}
