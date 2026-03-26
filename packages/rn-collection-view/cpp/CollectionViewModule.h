#pragma once

#include <ReactCommon/TurboModule.h>
#include <jsi/jsi.h>
#include <string>
#include <memory>
#include <optional>
#include <atomic>
#include <functional>

#include "LayoutCache.h"
#include "layouts/ListLayout.h"
#include "WindowController.h"
#include "MetricCollector.h"
#include "DiffEngine.h"

namespace facebook::react {

/**
 * RNCollectionViewModule — C++ TurboModule.
 *
 * M0.3: ping()
 * M1.1: layoutCache        — in-memory attribute store
 * M1.2: listLayout         — fixed-height list computation
 * M1.3: invalidateListLayoutFrom — partial re-layout
 * M1.5: computeSections / invalidateSectionsFrom
 * M2.2: windowController   — scroll bridge + future window tier engine
 *
 * M2.2  scroll bridge — JS-thread delivery:
 *   JS onScroll → JSI → updateScrollPosition(y, x)
 * M2.2b scroll bridge — UI-thread delivery:
 *   UIScrollViewDelegate → RNCVScrollObserver → updateScrollPosition(y, x)
 *   Both paths write the same atomics; UI-thread path wins when observer is
 *   attached because it runs one JS frame earlier.
 */
class CollectionViewModule : public TurboModule {
public:
  explicit CollectionViewModule(std::shared_ptr<CallInvoker> jsInvoker);

  std::string ping();
  jsi::Value get(jsi::Runtime& rt, const jsi::PropNameID& name) override;

  /**
   * Called by either the JS onScroll bridge (M2.2) or the UI-thread
   * UIScrollViewDelegate observer (M2.2b). Both paths are active when the
   * observer is attached; the UI-thread path simply wins (arrives first).
   * Thread-safe: _scrollY/_scrollX are std::atomic<double>.
   */
  void updateScrollPosition(double scrollY, double scrollX);

  /**
   * Register a callback that fires (on whatever thread calls it) when JS
   * calls windowController.attachScrollView(reactTag). The ObjC layer uses
   * this to find the UIScrollView and install RNCVScrollObserver on the UI thread.
   */
  void setAttachScrollViewCallback(std::function<void(int)> cb);

  /**
   * P5.1 — Metrics callbacks.
   * startCb: fired when JS calls metrics.startFrameTimer(). ObjC layer starts CADisplayLink.
   * stopCb:  fired when JS calls metrics.stopFrameTimer().  ObjC layer stops CADisplayLink.
   */
  void setMetricsCallbacks(std::function<void()> startCb, std::function<void()> stopCb);

  /** Called by the CADisplayLink callback on the main thread. */
  void recordFrame(double durationMs);

  /** Called before starting a new CADisplayLink session to clear stale data. */
  void resetMetrics();

  /**
   * P5.3 — Signpost callbacks.
   * beginCb(id) / endCb(id) fire on JS thread; ObjC layer calls os_signpost.
   * IDs:  0 = ScrollHandler  1 = LayoutPass  2 = MeasureFlush
   */
  void setSignpostCallbacks(std::function<void(int)> beginCb,
                            std::function<void(int)> endCb);

  static constexpr const char* kModuleName = "RNCollectionViewModule";

private:
  std::shared_ptr<rncv::LayoutCache> _layoutCache;
  std::shared_ptr<rncv::ListLayout>  _listLayout;

  // Scroll position — written from UI thread (M2.2b) or JS thread (M2.2).
  std::atomic<double> _scrollY{0.0};
  std::atomic<double> _scrollX{0.0};

  // Called when JS invokes windowController.attachScrollView(tag).
  std::function<void(int)> _attachScrollViewCallback;

  // P5.1 — metrics callbacks (fired on JS thread, dispatch to main in ObjC layer).
  std::function<void()> _startMetricsCb;
  std::function<void()> _stopMetricsCb;

  // P5.3 — signpost callbacks (fired synchronously on JS thread).
  std::function<void(int)> _signpostBeginCb;
  std::function<void(int)> _signpostEndCb;

  // P5.1 — frame time ring buffer, written from main thread via recordFrame().
  rncv::MetricCollector _metricCollector;

  // Lazily-created JSI wrapper objects (created once, reused)
  std::optional<jsi::Object> _layoutCacheJSI;
  std::optional<jsi::Object> _listLayoutJSI;
  std::optional<jsi::Object> _windowControllerJSI;
  std::optional<jsi::Object> _metricsJSI;
  std::optional<jsi::Object> _signpostJSI;
  std::optional<jsi::Object> _diffEngineJSI;

  jsi::Value getLayoutCacheObject(jsi::Runtime& rt);
  jsi::Value getListLayoutObject(jsi::Runtime& rt);
  jsi::Value getWindowControllerObject(jsi::Runtime& rt);
  jsi::Value getMetricsObject(jsi::Runtime& rt);
  jsi::Value getSignpostObject(jsi::Runtime& rt);
  jsi::Value getDiffEngineObject(jsi::Runtime& rt);
};

} // namespace facebook::react
