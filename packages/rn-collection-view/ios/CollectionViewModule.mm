#import "CollectionViewModule.h"
#import "RNCVScrollObserver.h"
#import <os/signpost.h>
#import <os/proc.h>

// New Arch / TurboModule includes
#import <React/RCTUtils.h>
#import <ReactCommon/RCTTurboModule.h>
#import <ReactCommon/TurboModuleUtils.h>

// Our C++ implementation
#import "../cpp/CollectionViewModule.h"

using namespace facebook::react;

/**
 * RNCollectionViewModule — New Arch TurboModule registration.
 *
 * M2.2b: holds the C++ module shared_ptr so it can register the
 * attachScrollView callback and install RNCVScrollObserver on the
 * UIScrollView on the main thread.
 */
@interface RNCollectionViewModule () <RCTTurboModule>
@end

// P5.3 — one os_log handle shared across all signpost intervals.
// Defined at file scope so it outlives any module instance.
static os_log_t _rncvLog;
static const BOOL kRNCVEnableSignposts = NO;

@implementation RNCollectionViewModule {
  std::shared_ptr<CollectionViewModule> _cppModule;
  RNCVScrollObserver                   *_scrollObserver;
  // P5.1 — CADisplayLink for accurate frame-time measurement.
  CADisplayLink                        *_displayLink;
  CFTimeInterval                        _lastTimestamp;
}

RCT_EXPORT_MODULE(RNCollectionViewModule)

- (std::shared_ptr<TurboModule>)getTurboModule:
    (const ObjCTurboModule::InitParams&)params
{
  auto mod = std::make_shared<CollectionViewModule>(params.jsInvoker);
  _cppModule = mod;

  __weak RNCollectionViewModule *weakSelf = self;

  mod->setAttachScrollViewCallback(^(int tag) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [weakSelf attachToScrollViewWithTag:tag];
    });
  });

  // P5.1 — metrics callbacks: start/stop CADisplayLink on main thread.
  mod->setMetricsCallbacks(
    ^{
      dispatch_async(dispatch_get_main_queue(), ^{
        [weakSelf startDisplayLink];
      });
    },
    ^{
      dispatch_async(dispatch_get_main_queue(), ^{
        [weakSelf stopDisplayLink];
      });
    }
  );

  // P4.1 — memory: synchronous available-bytes query via os_proc_available_memory().
  mod->setGetAvailableMemoryCallback(^int64_t {
    return (int64_t)os_proc_available_memory();
  });

  // Register for system memory warnings — fires triggerMemoryPressure(2) on the
  // C++ module, which then invokes the JS callback via jsInvoker.
  [[NSNotificationCenter defaultCenter]
      addObserver:self
         selector:@selector(handleMemoryWarning)
             name:UIApplicationDidReceiveMemoryWarningNotification
           object:nil];

  // P5.3 — signpost callbacks. Called on JS thread; os_signpost is thread-safe.
  // Names must be compile-time string literals — os_signpost requirement.
  // id: 0=ScrollHandler  1=LayoutPass  2=MeasureFlush
  if (kRNCVEnableSignposts) {
    if (!_rncvLog) {
      _rncvLog = os_log_create("com.rncv", "CollectionView");
    }
    mod->setSignpostCallbacks(
      ^(int eventId) {
        switch (eventId) {
          case 0: os_signpost_interval_begin(_rncvLog, OS_SIGNPOST_ID_EXCLUSIVE, "ScrollHandler"); break;
          case 1: os_signpost_interval_begin(_rncvLog, OS_SIGNPOST_ID_EXCLUSIVE, "LayoutPass");    break;
          case 2: os_signpost_interval_begin(_rncvLog, OS_SIGNPOST_ID_EXCLUSIVE, "MeasureFlush"); break;
          default: break;
        }
      },
      ^(int eventId) {
        switch (eventId) {
          case 0: os_signpost_interval_end(_rncvLog, OS_SIGNPOST_ID_EXCLUSIVE, "ScrollHandler"); break;
          case 1: os_signpost_interval_end(_rncvLog, OS_SIGNPOST_ID_EXCLUSIVE, "LayoutPass");    break;
          case 2: os_signpost_interval_end(_rncvLog, OS_SIGNPOST_ID_EXCLUSIVE, "MeasureFlush"); break;
          default: break;
        }
      }
    );
  }

  return mod;
}

// ── View lookup + observer install (main thread) ──────────────────────────────

- (void)attachToScrollViewWithTag:(int)tag
{
  if (!_cppModule) return;

  // Find the RCTScrollView (or any view) with this reactTag.
  // In both old and new arch, RN sets view.tag = reactTag for compatibility.
  UIView *reactView = nil;
  for (UIWindow *window in UIApplication.sharedApplication.windows) {
    reactView = [self findViewWithTag:tag inView:window];
    if (reactView) break;
  }
  if (!reactView) return;

  // The found view is RCTScrollView (a plain UIView container).
  // The actual UIScrollView is its first UIScrollView-class descendant.
  UIScrollView *scrollView = [self findScrollViewInView:reactView];
  if (!scrollView) return;

  // Detach any previous observer, then install the new one.
  [_scrollObserver detach];
  _scrollObserver = [[RNCVScrollObserver alloc] initWithScrollView:scrollView
                                                         cppModule:_cppModule];
}

- (UIView *)findViewWithTag:(NSInteger)tag inView:(UIView *)root
{
  if (root.tag == tag) return root;
  for (UIView *child in root.subviews) {
    UIView *found = [self findViewWithTag:tag inView:child];
    if (found) return found;
  }
  return nil;
}

- (UIScrollView *)findScrollViewInView:(UIView *)root
{
  if ([root isKindOfClass:[UIScrollView class]]) return (UIScrollView *)root;
  for (UIView *child in root.subviews) {
    UIScrollView *found = [self findScrollViewInView:child];
    if (found) return found;
  }
  return nil;
}

// ── P5.1: CADisplayLink frame timer ───────────────────────────────────────────

- (void)startDisplayLink
{
  [self stopDisplayLink];
  _lastTimestamp = 0;
  if (_cppModule) _cppModule->resetMetrics();
  _displayLink = [CADisplayLink displayLinkWithTarget:self
                                             selector:@selector(displayLinkTick:)];
  // NSRunLoopCommonModes ensures it fires during scroll (UITrackingRunLoopMode).
  [_displayLink addToRunLoop:[NSRunLoop mainRunLoop]
                     forMode:NSRunLoopCommonModes];
}

- (void)stopDisplayLink
{
  [_displayLink invalidate];
  _displayLink = nil;
}

- (void)displayLinkTick:(CADisplayLink *)link
{
  CFTimeInterval now = link.timestamp;
  if (_lastTimestamp > 0 && _cppModule) {
    double durationMs = (now - _lastTimestamp) * 1000.0;
    _cppModule->recordFrame(durationMs);
  }
  _lastTimestamp = now;
}

// ── P4.1: memory warning handler ─────────────────────────────────────────────

- (void)handleMemoryWarning
{
  if (_cppModule) {
    _cppModule->triggerMemoryPressure(2);
  }
}

- (void)dealloc
{
  [[NSNotificationCenter defaultCenter] removeObserver:self
      name:UIApplicationDidReceiveMemoryWarningNotification
    object:nil];
  [self stopDisplayLink];
}

@end
