#pragma once

#include <ReactCommon/TurboModule.h>
#include <jsi/jsi.h>
#include <string>
#include <memory>
#include <optional>
#include <atomic>
#include <functional>
#include <unordered_map>

#include "LayoutCache.h"
#include "LayoutEngine.h"
#include "layouts/ListLayout.h"
#include "layouts/MasonryLayout.h"
#include "layouts/GridLayout.h"
#include "layouts/FlowLayout.h"
#include "layouts/CompositionalLayout.h"
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
  void invalidate();
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

  /**
   * P4.1 — Memory management.
   * getMemoryCb: called synchronously on JS thread to get available process memory.
   * triggerMemoryPressure(level): called by ObjC on UIApplicationDidReceiveMemoryWarningNotification.
   *   level: 0=normal  1=low  2=critical
   */
  void setGetAvailableMemoryCallback(std::function<int64_t()> cb);
  void triggerMemoryPressure(int level);

  /**
   * P5.1 — Main-thread CPU utilization.
   * cb is called synchronously on the JS thread; the ObjC layer dispatches
   * to the main thread (dispatch_sync) and reads thread_basic_info.cpu_usage.
   * Returns 0–100 (% of one core). -1 if unavailable.
   */
  void setMainThreadCPUCallback(std::function<double()> cb);

  static constexpr const char* kModuleName = "RNCollectionViewModule";

  // ── Static LayoutCache registry ──────────────────────────────────────────
  // ShadowNodes (cloned by Fabric, value semantics) can't hold shared_ptr.
  // Instead, this module registers its LayoutCache in a static map keyed by
  // integer ID. JS passes the ID as a prop on <RNCollectionViewContainer>.
  // The ShadowNode looks up the cache during layout().
  static std::shared_ptr<rncv::LayoutCache> getLayoutCacheForId(int32_t id);
  static std::shared_ptr<rncv::LayoutEngine> getLayoutEngineForId(
      int32_t id, const std::string& layoutType);
  static int32_t registerLayoutCache(std::shared_ptr<rncv::LayoutCache> cache);
  static void registerLayoutEngine(
      int32_t id, const std::string& layoutType,
      std::shared_ptr<rncv::LayoutEngine> engine);
  static void unregisterLayoutCache(int32_t id);

  int32_t layoutCacheId() const { return _layoutCacheId; }

private:
  int32_t _layoutCacheId = 0;
  std::shared_ptr<rncv::LayoutCache>   _layoutCache;
  std::shared_ptr<rncv::ListLayout>          _listLayout;
  std::shared_ptr<rncv::MasonryLayout>       _masonryLayout;
  std::shared_ptr<rncv::GridLayout>          _gridLayout;
  std::shared_ptr<rncv::FlowLayout>          _flowLayout;
  std::shared_ptr<rncv::CompositionalLayout> _compositionalLayout;

  // Scroll position — written from UI thread (M2.2b) or JS thread (M2.2).
  std::atomic<double> _scrollY{0.0};
  std::atomic<double> _scrollX{0.0};

  // H-3: Per-section H velocity tracking for velocity-adaptive windowing.
  // Each processHScroll call updates this state using std::chrono wall-clock
  // timestamps, computing px/ms velocity from consecutive (scrollX, time) pairs.
  // Mirrors the per-module velocity tracking that LayoutCache does for V scroll.
  struct HScrollState {
    double lastScrollX     = 0.0;
    double lastTimestampMs = -1.0;  // -1 = uninitialized (first call)
    double velocity        = 0.0;   // px/ms, signed (+ve = scrolling right)
    // H-4: Stable-band skip — cache last result to avoid redundant spatial queries.
    int    prevRenderFirst = 0;
    int    prevRenderLast  = -1;    // first > last = no previous result
    uint64_t prevCacheVersion = 0;
  };
  std::unordered_map<int, HScrollState> _hScrollStates;

  // processScroll early-return state (Opt 6 — stable-band skip).
  // When cacheVersion hasn't changed and scroll offset is within the band,
  // processScroll returns the cached result without re-running spatial queries.
  struct LastScrollResult {
    int32_t renderFirst = 0, renderLast = -1;
    int32_t visibleFirst = 0, visibleLast = -1;
    int32_t measureFirst = 0, measureLast = -1;
    int32_t cacheVersion = -1;
    double bandLow = 0.0, bandHigh = 0.0;
    double blankBefore = 0.0, blankAfter = 0.0;
    // Change C: frame data returned alongside indices to eliminate per-cell JSI.
    std::vector<double> frames; // flat [x,y,w,h] per flat index in [measureFirst,measureLast]
    int32_t framesFirst = 0;
  };
  LastScrollResult _lastScrollResult;

  // B4.9: Per-instance data. One entry per CollectionView instance.
  // The default instance (_layoutCacheId) mirrors the legacy singleton objects.
  struct PerInstanceData {
    std::shared_ptr<rncv::LayoutCache>         cache;
    std::shared_ptr<rncv::ListLayout>          listLayout;
    std::shared_ptr<rncv::MasonryLayout>       masonryLayout;
    std::shared_ptr<rncv::GridLayout>          gridLayout;
    std::shared_ptr<rncv::FlowLayout>          flowLayout;
    std::shared_ptr<rncv::CompositionalLayout> compositionalLayout;
    LastScrollResult                           lastScrollResult;
    std::unordered_map<int, HScrollState>      hScrollStates;
  };
  std::unordered_map<int32_t, PerInstanceData>            _instances;
  std::unordered_map<int32_t, std::optional<jsi::Object>> _instanceCacheJSI;
  std::unordered_map<int32_t, std::optional<jsi::Object>> _instanceListLayoutJSI;
  std::unordered_map<int32_t, std::optional<jsi::Object>> _instanceMasonryLayoutJSI;
  std::unordered_map<int32_t, std::optional<jsi::Object>> _instanceGridLayoutJSI;
  std::unordered_map<int32_t, std::optional<jsi::Object>> _instanceFlowLayoutJSI;
  std::unordered_map<int32_t, std::optional<jsi::Object>> _instanceCompositionalLayoutJSI;

  // Called when JS invokes windowController.attachScrollView(tag).
  std::function<void(int)> _attachScrollViewCallback;

  // P5.1 — metrics callbacks (fired on JS thread, dispatch to main in ObjC layer).
  std::function<void()> _startMetricsCb;
  std::function<void()> _stopMetricsCb;

  // P5.3 — signpost callbacks (fired synchronously on JS thread).
  std::function<void(int)> _signpostBeginCb;
  std::function<void(int)> _signpostEndCb;

  // P4.1 — memory management callbacks.
  std::function<int64_t()>              _getAvailableMemoryCb;

  // P5.1 — main-thread CPU callback (synchronous, ObjC dispatches to main).
  std::function<double()>               _mainThreadCPUCb;
  std::shared_ptr<jsi::Function>        _memoryPressureJsFn;
  jsi::Runtime*                         _memoryPressureRt{nullptr};

  // P5.1 — frame time ring buffer, written from main thread via recordFrame().
  rncv::MetricCollector _metricCollector;

  // Lazily-created JSI wrapper objects (created once, reused)
  std::optional<jsi::Object> _layoutCacheJSI;
  std::optional<jsi::Object> _listLayoutJSI;
  std::optional<jsi::Object> _windowControllerJSI;
  std::optional<jsi::Object> _metricsJSI;
  std::optional<jsi::Object> _signpostJSI;
  std::optional<jsi::Object> _diffEngineJSI;
  std::optional<jsi::Object> _memoryJSI;
  std::optional<jsi::Object> _masonryLayoutJSI;
  std::optional<jsi::Object> _gridLayoutJSI;
  std::optional<jsi::Object> _flowLayoutJSI;
  std::optional<jsi::Object> _compositionalLayoutJSI;

  jsi::Value getLayoutCacheObject(jsi::Runtime& rt);
  jsi::Value getListLayoutObject(jsi::Runtime& rt);
  jsi::Value getWindowControllerObject(jsi::Runtime& rt);
  jsi::Value getMetricsObject(jsi::Runtime& rt);
  jsi::Value getSignpostObject(jsi::Runtime& rt);
  jsi::Value getDiffEngineObject(jsi::Runtime& rt);
  jsi::Value getMemoryObject(jsi::Runtime& rt);
  jsi::Value getMasonryLayoutObject(jsi::Runtime& rt);
  jsi::Value getGridLayoutObject(jsi::Runtime& rt);
  jsi::Value getFlowLayoutObject(jsi::Runtime& rt);
  jsi::Value getCompositionalLayoutObject(jsi::Runtime& rt);
};

} // namespace facebook::react
