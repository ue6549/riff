#pragma once
#import <UIKit/UIKit.h>
#include <memory>

namespace facebook::react { class CollectionViewModule; }

/**
 * RNCVScrollObserver — UI-thread UIScrollViewDelegate interceptor.
 *
 * Inserts itself between the original delegate (RCTScrollView) and the
 * UIScrollView. On every `scrollViewDidScroll:` it writes the new content
 * offset directly into the C++ window controller on the UI thread, then
 * forwards the call to the original delegate so RN's own scroll event
 * pipeline is unaffected.
 *
 * All other UIScrollViewDelegate methods are forwarded transparently via
 * ObjC message forwarding (-forwardInvocation:).
 *
 * M2.2b — JS-thread delivery (the onScroll bridge in CollectionView.tsx)
 * remains as a fallback; once this observer is attached the C++ value is
 * updated one full JS frame earlier (UI thread vs JS thread).
 */
@interface RNCVScrollObserver : NSObject <UIScrollViewDelegate>

- (instancetype)initWithScrollView:(UIScrollView *)scrollView
                         cppModule:(std::shared_ptr<facebook::react::CollectionViewModule>)module;

/** Restore the original delegate and release the C++ module reference. */
- (void)detach;

@end
