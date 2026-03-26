#include "CollectionViewModule.h"

namespace facebook::react {

using namespace facebook::jsi;

CollectionViewModule::CollectionViewModule(
    std::shared_ptr<CallInvoker> jsInvoker)
    : TurboModule(kModuleName, jsInvoker)
    , _layoutCache(std::make_shared<rncv::LayoutCache>())
    , _listLayout(std::make_shared<rncv::ListLayout>(_layoutCache)) {}

std::string CollectionViewModule::ping() {
  return "pong";
}

Value CollectionViewModule::getLayoutCacheObject(Runtime& rt) {
  if (!_layoutCacheJSI.has_value()) {
    Object obj(rt);
    _layoutCache->installJSIBindings(rt, obj);
    _layoutCacheJSI = std::move(obj);
  }
  return Value(rt, *_layoutCacheJSI);
}

Value CollectionViewModule::getListLayoutObject(Runtime& rt) {
  if (!_listLayoutJSI.has_value()) {
    Object obj(rt);
    _listLayout->installJSIBindings(rt, obj);
    _listLayoutJSI = std::move(obj);
  }
  return Value(rt, *_listLayoutJSI);
}

void CollectionViewModule::updateScrollPosition(double scrollY, double scrollX) {
  _scrollY.store(scrollY, std::memory_order_relaxed);
  _scrollX.store(scrollX, std::memory_order_relaxed);
}

void CollectionViewModule::setAttachScrollViewCallback(std::function<void(int)> cb) {
  _attachScrollViewCallback = std::move(cb);
}

Value CollectionViewModule::getWindowControllerObject(Runtime& rt) {
  if (!_windowControllerJSI.has_value()) {
    Object obj(rt);

    // updateScrollPosition(y, x) → undefined
    // Called by the JS scroll bridge on every onScroll event.
    obj.setProperty(rt, "updateScrollPosition",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "updateScrollPosition"), 2,
        [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
          double y = count > 0 && args[0].isNumber() ? args[0].getNumber() : 0.0;
          double x = count > 1 && args[1].isNumber() ? args[1].getNumber() : 0.0;
          updateScrollPosition(y, x);
          return Value::undefined();
        }));

    // getScrollPosition() → { y: number, x: number }
    obj.setProperty(rt, "getScrollPosition",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "getScrollPosition"), 0,
        [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
          Object result(rt);
          result.setProperty(rt, "y", Value(_scrollY.load(std::memory_order_relaxed)));
          result.setProperty(rt, "x", Value(_scrollX.load(std::memory_order_relaxed)));
          return Value(rt, result);
        }));

    // getWindowState(scrollY, vpWidth, vpHeight, renderMultiplier)
    //   → { visibleKeys: string[], renderKeys: string[] }
    //
    // Pure synchronous query — JS calls this from onScroll (and on mount).
    // renderMultiplier controls how many viewport-heights to keep rendered
    // above and below the visible area. E.g. mult=1.0 keeps 1 extra viewport
    // above and 1 below, so total render height = 3x viewport.
    obj.setProperty(rt, "getWindowState",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "getWindowState"), 4,
        [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
          double scrollY    = count > 0 && args[0].isNumber() ? args[0].getNumber() : 0.0;
          double vpWidth    = count > 1 && args[1].isNumber() ? args[1].getNumber() : 0.0;
          double vpHeight   = count > 2 && args[2].isNumber() ? args[2].getNumber() : 0.0;
          double renderMult = count > 3 && args[3].isNumber() ? args[3].getNumber() : 1.0;

          if (vpHeight <= 0) {
            // Viewport unknown — return empty so JS falls back to render-all.
            Object result(rt);
            result.setProperty(rt, "visibleKeys", Array(rt, 0));
            result.setProperty(rt, "renderKeys",  Array(rt, 0));
            return Value(rt, result);
          }

          // Visible window: exactly the on-screen rect.
          rncv::Rect visibleRect{0.0, scrollY, vpWidth, vpHeight};

          // Render window: renderMult viewports above + below the visible area.
          double pad = renderMult * vpHeight;
          rncv::Rect renderRect{0.0, scrollY - pad, vpWidth, vpHeight + 2.0 * pad};

          auto visibleAttrs = _layoutCache->getAttributesInRect(visibleRect);
          auto renderAttrs  = _layoutCache->getAttributesInRect(renderRect);

          Array visibleArr(rt, visibleAttrs.size());
          for (size_t i = 0; i < visibleAttrs.size(); i++) {
            const auto& k = visibleAttrs[i].key;
            visibleArr.setValueAtIndex(rt, i,
              String::createFromAscii(rt, k.c_str(), k.size()));
          }
          Array renderArr(rt, renderAttrs.size());
          for (size_t i = 0; i < renderAttrs.size(); i++) {
            const auto& k = renderAttrs[i].key;
            renderArr.setValueAtIndex(rt, i,
              String::createFromAscii(rt, k.c_str(), k.size()));
          }

          Object result(rt);
          result.setProperty(rt, "visibleKeys", std::move(visibleArr));
          result.setProperty(rt, "renderKeys",  std::move(renderArr));
          return Value(rt, result);
        }));

    // attachScrollView(reactTag) → undefined
    // Called once from JS after the ScrollView mounts. Fires the ObjC callback
    // which installs RNCVScrollObserver on the UIScrollView on the main thread.
    obj.setProperty(rt, "attachScrollView",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "attachScrollView"), 1,
        [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
          int tag = (count > 0 && args[0].isNumber())
                    ? static_cast<int>(args[0].getNumber()) : -1;
          if (_attachScrollViewCallback) {
            _attachScrollViewCallback(tag);
          }
          return Value::undefined();
        }));

    // ── P1.1: C++ Window Controller ────────────────────────────────────────────
    //
    // computeRanges(scrollY, vpHeight, itemCount, stride, renderMult,
    //               sectionInsetTop, velocity)
    //   → { render: { first, last }, visible: { first, last } }
    //
    // Fixed-height O(1) range computation. Replaces the JS computeRanges().
    obj.setProperty(rt, "computeRanges",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "computeRanges"), 7,
        [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
          double scrollY        = count > 0 && args[0].isNumber() ? args[0].getNumber() : 0.0;
          double vpHeight       = count > 1 && args[1].isNumber() ? args[1].getNumber() : 0.0;
          int    itemCount      = count > 2 && args[2].isNumber() ? static_cast<int>(args[2].getNumber()) : 0;
          double stride         = count > 3 && args[3].isNumber() ? args[3].getNumber() : 0.0;
          double renderMult     = count > 4 && args[4].isNumber() ? args[4].getNumber() : 1.0;
          double sectionInsetTop= count > 5 && args[5].isNumber() ? args[5].getNumber() : 0.0;
          double velocity       = count > 6 && args[6].isNumber() ? args[6].getNumber() : 0.0;

          auto ws = rncv::WindowController::computeRanges(
            scrollY, vpHeight, itemCount, stride, renderMult, sectionInsetTop, velocity);

          Object render(rt);
          render.setProperty(rt, "first", Value(ws.render.first));
          render.setProperty(rt, "last",  Value(ws.render.last));
          Object visible(rt);
          visible.setProperty(rt, "first", Value(ws.visible.first));
          visible.setProperty(rt, "last",  Value(ws.visible.last));
          Object result(rt);
          result.setProperty(rt, "render",  std::move(render));
          result.setProperty(rt, "visible", std::move(visible));
          return Value(rt, result);
        }));

    // computeVariableRanges(scrollY, vpHeight, positions: Float64Array,
    //                       itemCount, renderMult, velocity)
    //   → { render: { first, last }, visible: { first, last } }
    //
    // Variable-height O(log n) binary search on positions array.
    // Accepts a TypedArray (Float64Array) for zero-copy access to positions.
    obj.setProperty(rt, "computeVariableRanges",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "computeVariableRanges"), 6,
        [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
          double scrollY    = count > 0 && args[0].isNumber() ? args[0].getNumber() : 0.0;
          double vpHeight   = count > 1 && args[1].isNumber() ? args[1].getNumber() : 0.0;
          int    itemCount  = count > 3 && args[3].isNumber() ? static_cast<int>(args[3].getNumber()) : 0;
          double renderMult = count > 4 && args[4].isNumber() ? args[4].getNumber() : 1.0;
          double velocity   = count > 5 && args[5].isNumber() ? args[5].getNumber() : 0.0;

          // Read positions from JS Array
          int posCount = 0;
          const double* posPtr = nullptr;
          std::vector<double> posVec; // fallback storage

          if (count > 2 && args[2].isObject()) {
            auto posObj = args[2].getObject(rt);
            if (posObj.isArray(rt)) {
              auto arr = posObj.getArray(rt);
              posCount = static_cast<int>(arr.size(rt));
              posVec.resize(posCount);
              for (int i = 0; i < posCount; i++) {
                posVec[i] = arr.getValueAtIndex(rt, i).getNumber();
              }
              posPtr = posVec.data();
            }
          }

          if (itemCount == 0 || posCount == 0) {
            Object render(rt);
            render.setProperty(rt, "first", Value(0));
            render.setProperty(rt, "last",  Value(-1));
            Object visible(rt);
            visible.setProperty(rt, "first", Value(0));
            visible.setProperty(rt, "last",  Value(-1));
            Object result(rt);
            result.setProperty(rt, "render",  std::move(render));
            result.setProperty(rt, "visible", std::move(visible));
            return Value(rt, result);
          }

          auto ws = rncv::WindowController::computeVariableRanges(
            scrollY, vpHeight, posPtr, posCount, itemCount, renderMult, velocity);

          Object render(rt);
          render.setProperty(rt, "first", Value(ws.render.first));
          render.setProperty(rt, "last",  Value(ws.render.last));
          Object visible(rt);
          visible.setProperty(rt, "first", Value(ws.visible.first));
          visible.setProperty(rt, "last",  Value(ws.visible.last));
          Object result(rt);
          result.setProperty(rt, "render",  std::move(render));
          result.setProperty(rt, "visible", std::move(visible));
          return Value(rt, result);
        }));

    // applyBudget(renderFirst, renderLast, visibleFirst, visibleLast,
    //             mountedWindowSize, vpHeight, stride)
    //   → { first, last }
    //
    // M3.5 cell budget constraint. Trims render range to fit budget.
    obj.setProperty(rt, "applyBudget",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "applyBudget"), 7,
        [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
          int    rFirst    = count > 0 && args[0].isNumber() ? static_cast<int>(args[0].getNumber()) : 0;
          int    rLast     = count > 1 && args[1].isNumber() ? static_cast<int>(args[1].getNumber()) : -1;
          int    vFirst    = count > 2 && args[2].isNumber() ? static_cast<int>(args[2].getNumber()) : 0;
          int    vLast     = count > 3 && args[3].isNumber() ? static_cast<int>(args[3].getNumber()) : -1;
          double mws       = count > 4 && args[4].isNumber() ? args[4].getNumber() : 1e10;
          double vpHeight  = count > 5 && args[5].isNumber() ? args[5].getNumber() : 0.0;
          double stride    = count > 6 && args[6].isNumber() ? args[6].getNumber() : 0.0;

          rncv::Range render  = { rFirst, rLast };
          rncv::Range visible = { vFirst, vLast };
          auto budgeted = rncv::WindowController::applyBudget(render, visible, mws, vpHeight, stride);

          Object result(rt);
          result.setProperty(rt, "first", Value(budgeted.first));
          result.setProperty(rt, "last",  Value(budgeted.last));
          return Value(rt, result);
        }));

    // computeMeasureRange(budgetedFirst, budgetedLast, ahead, itemCount)
    //   → { first, last }
    obj.setProperty(rt, "computeMeasureRange",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "computeMeasureRange"), 4,
        [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
          int bFirst   = count > 0 && args[0].isNumber() ? static_cast<int>(args[0].getNumber()) : 0;
          int bLast    = count > 1 && args[1].isNumber() ? static_cast<int>(args[1].getNumber()) : -1;
          int ahead    = count > 2 && args[2].isNumber() ? static_cast<int>(args[2].getNumber()) : 0;
          int itemCnt  = count > 3 && args[3].isNumber() ? static_cast<int>(args[3].getNumber()) : 0;

          rncv::Range budgeted = { bFirst, bLast };
          auto mr = rncv::WindowController::computeMeasureRange(budgeted, ahead, itemCnt);

          Object result(rt);
          result.setProperty(rt, "first", Value(mr.first));
          result.setProperty(rt, "last",  Value(mr.last));
          return Value(rt, result);
        }));

    _windowControllerJSI = std::move(obj);
  }
  return Value(rt, *_windowControllerJSI);
}

Value CollectionViewModule::get(Runtime& rt, const PropNameID& name) {
  auto prop = name.utf8(rt);

  if (prop == "ping") {
    return Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "ping"), 0,
        [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
          const auto s = ping();
          return Value(String::createFromAscii(rt, s.c_str(), s.size()));
        });
  }

  if (prop == "layoutCache")      return getLayoutCacheObject(rt);
  if (prop == "listLayout")       return getListLayoutObject(rt);
  if (prop == "windowController") return getWindowControllerObject(rt);
  if (prop == "metrics")          return getMetricsObject(rt);
  if (prop == "signpost")         return getSignpostObject(rt);
  if (prop == "diffEngine")       return getDiffEngineObject(rt);

  return Value::undefined();
}

void CollectionViewModule::setMetricsCallbacks(
    std::function<void()> startCb, std::function<void()> stopCb) {
  _startMetricsCb = std::move(startCb);
  _stopMetricsCb  = std::move(stopCb);
}

void CollectionViewModule::recordFrame(double durationMs) {
  _metricCollector.recordFrame(durationMs);
}

void CollectionViewModule::resetMetrics() {
  _metricCollector.reset();
}

// ── P5.1: metrics JSI object ──────────────────────────────────────────────────

Value CollectionViewModule::getMetricsObject(Runtime& rt) {
  if (!_metricsJSI.has_value()) {
    Object obj(rt);

    // startFrameTimer() → undefined
    // Fires the ObjC callback which starts CADisplayLink on the main thread.
    obj.setProperty(rt, "startFrameTimer",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "startFrameTimer"), 0,
        [this](Runtime&, const Value&, const Value*, size_t) -> Value {
          if (_startMetricsCb) _startMetricsCb();
          return Value::undefined();
        }));

    // stopFrameTimer() → undefined
    obj.setProperty(rt, "stopFrameTimer",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "stopFrameTimer"), 0,
        [this](Runtime&, const Value&, const Value*, size_t) -> Value {
          if (_stopMetricsCb) _stopMetricsCb();
          return Value::undefined();
        }));

    // getFrameMetrics() → { fps: number, frameTimeMs: number }
    // Reads the ring buffer averaged over the last 30 frames (~0.5 s).
    // Called at ~10 Hz from JS — sub-microsecond, no allocation on hot path.
    obj.setProperty(rt, "getFrameMetrics",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "getFrameMetrics"), 0,
        [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
          auto m = _metricCollector.getFrameMetrics();
          Object result(rt);
          result.setProperty(rt, "fps",         Value(m.fps));
          result.setProperty(rt, "frameTimeMs", Value(m.frameTimeMs));
          return Value(rt, result);
        }));

    // resetMetrics() → undefined
    obj.setProperty(rt, "resetMetrics",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "resetMetrics"), 0,
        [this](Runtime&, const Value&, const Value*, size_t) -> Value {
          _metricCollector.reset();
          return Value::undefined();
        }));

    _metricsJSI = std::move(obj);
  }
  return Value(rt, *_metricsJSI);
}

void CollectionViewModule::setSignpostCallbacks(
    std::function<void(int)> beginCb, std::function<void(int)> endCb) {
  _signpostBeginCb = std::move(beginCb);
  _signpostEndCb   = std::move(endCb);
}

// ── P5.3: signpost JSI object ─────────────────────────────────────────────────

Value CollectionViewModule::getSignpostObject(Runtime& rt) {
  if (!_signpostJSI.has_value()) {
    Object obj(rt);

    // begin(id) → undefined  — marks the start of a named interval in Instruments.
    // id: 0=ScrollHandler  1=LayoutPass  2=MeasureFlush
    obj.setProperty(rt, "begin",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "begin"), 1,
        [this](Runtime&, const Value&, const Value* args, size_t count) -> Value {
          if (_signpostBeginCb && count > 0 && args[0].isNumber()) {
            _signpostBeginCb(static_cast<int>(args[0].getNumber()));
          }
          return Value::undefined();
        }));

    // end(id) → undefined
    obj.setProperty(rt, "end",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "end"), 1,
        [this](Runtime&, const Value&, const Value* args, size_t count) -> Value {
          if (_signpostEndCb && count > 0 && args[0].isNumber()) {
            _signpostEndCb(static_cast<int>(args[0].getNumber()));
          }
          return Value::undefined();
        }));

    _signpostJSI = std::move(obj);
  }
  return Value(rt, *_signpostJSI);
}

// ── F1.1: diff engine JSI object ─────────────────────────────────────────────

Value CollectionViewModule::getDiffEngineObject(Runtime& rt) {
  if (!_diffEngineJSI.has_value()) {
    Object obj(rt);

    // diff(oldKeys: string[], newKeys: string[]) →
    //   { removed: string[], inserted: string[],
    //     moved: Array<{ key: string, fromIndex: number, toIndex: number }> }
    obj.setProperty(rt, "diff",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "diff"), 2,
        [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
          if (count < 2) return Value::undefined();

          // Unpack oldKeys array
          auto oldArr = args[0].asObject(rt).asArray(rt);
          auto newArr = args[1].asObject(rt).asArray(rt);

          const size_t oldLen = oldArr.length(rt);
          const size_t newLen = newArr.length(rt);

          std::vector<std::string> oldKeys, newKeys;
          oldKeys.reserve(oldLen);
          newKeys.reserve(newLen);

          for (size_t i = 0; i < oldLen; ++i)
            oldKeys.push_back(oldArr.getValueAtIndex(rt, i).asString(rt).utf8(rt));
          for (size_t i = 0; i < newLen; ++i)
            newKeys.push_back(newArr.getValueAtIndex(rt, i).asString(rt).utf8(rt));

          const rncv::DiffResult dr = rncv::diff(oldKeys, newKeys);

          // Build JS result object
          Object result(rt);

          // removed: string[]
          Array removed(rt, dr.removed.size());
          for (size_t i = 0; i < dr.removed.size(); ++i)
            removed.setValueAtIndex(rt, i,
              String::createFromUtf8(rt, dr.removed[i]));
          result.setProperty(rt, "removed", removed);

          // inserted: string[]
          Array inserted(rt, dr.inserted.size());
          for (size_t i = 0; i < dr.inserted.size(); ++i)
            inserted.setValueAtIndex(rt, i,
              String::createFromUtf8(rt, dr.inserted[i]));
          result.setProperty(rt, "inserted", inserted);

          // moved: Array<{ key, fromIndex, toIndex }>
          Array moved(rt, dr.moved.size());
          for (size_t i = 0; i < dr.moved.size(); ++i) {
            Object m(rt);
            m.setProperty(rt, "key",
              String::createFromUtf8(rt, dr.moved[i].key));
            m.setProperty(rt, "fromIndex",
              Value(dr.moved[i].fromIndex));
            m.setProperty(rt, "toIndex",
              Value(dr.moved[i].toIndex));
            moved.setValueAtIndex(rt, i, m);
          }
          result.setProperty(rt, "moved", moved);

          return Value(rt, result);
        }));

    _diffEngineJSI = std::move(obj);
  }
  return Value(rt, *_diffEngineJSI);
}

} // namespace facebook::react
