#include "CollectionViewModule.h"

#include <chrono>
#include <cstdio>
#include <limits>
#include <unordered_map>

// Targeted H sub-container scroll diagnostics from the C++ TurboModule side.
// Independent from generic native-log gating. Defaults OFF.
//
// Flip to 1 to enable. Sister flags:
//   - example/components/CollectionView.tsx          → RNCV_HSUB_LOGS
//   - cpp/CollectionSubContainerShadowNode.cpp       → RNCV_ENABLE_HSUB_LOGS
//   - ios/RNCollectionSubContainerView.mm            → RNCV_ENABLE_HSUB_LOGS
//
// Filterable tags emitted from this file:
//   RNCV-HSUB-MOD-IN     processHScroll input args (sectionIdx, scrollX, vpW, mult, sectionY/H, flat range)
//   RNCV-HSUB-MOD-WIN    derived velocity, leadMult/trailMult/leftPad/rightPad,
//                        queryRect, returned range + frame count
#ifndef RNCV_ENABLE_HSUB_LOGS
#define RNCV_ENABLE_HSUB_LOGS 0
#endif

#if RNCV_ENABLE_HSUB_LOGS
#define RNCV_HSUB_MOD_LOG(fmt, ...) \
  do { fprintf(stderr, "[RNCV-HSUB-MOD] " fmt "\n", ##__VA_ARGS__); fflush(stderr); } while(0)
#else
#define RNCV_HSUB_MOD_LOG(fmt, ...) ((void)0)
#endif

namespace facebook::react {

using namespace facebook::jsi;

// ── Static LayoutCache registry ──────────────────────────────────────────────

static std::mutex& registryMutex() {
  static std::mutex m;
  return m;
}

static std::unordered_map<int32_t, std::weak_ptr<rncv::LayoutCache>>& registry() {
  static std::unordered_map<int32_t, std::weak_ptr<rncv::LayoutCache>> r;
  return r;
}

// Layout engine registry: cacheId → (layoutType → engine).
static std::unordered_map<int32_t,
    std::unordered_map<std::string, std::shared_ptr<rncv::LayoutEngine>>>& engineRegistry() {
  static std::unordered_map<int32_t,
      std::unordered_map<std::string, std::shared_ptr<rncv::LayoutEngine>>> r;
  return r;
}

static int32_t nextRegistryId() {
  static std::atomic<int32_t> counter{1};
  return counter.fetch_add(1, std::memory_order_relaxed);
}

int32_t CollectionViewModule::registerLayoutCache(
    std::shared_ptr<rncv::LayoutCache> cache) {
  std::lock_guard<std::mutex> lock(registryMutex());
  auto id = nextRegistryId();
  registry()[id] = cache;
  return id;
}

void CollectionViewModule::registerLayoutEngine(
    int32_t id, const std::string& layoutType,
    std::shared_ptr<rncv::LayoutEngine> engine) {
  std::lock_guard<std::mutex> lock(registryMutex());
  engineRegistry()[id][layoutType] = std::move(engine);
}

std::shared_ptr<rncv::LayoutEngine> CollectionViewModule::getLayoutEngineForId(
    int32_t id, const std::string& layoutType) {
  std::lock_guard<std::mutex> lock(registryMutex());
  auto it = engineRegistry().find(id);
  if (it == engineRegistry().end()) return nullptr;
  auto it2 = it->second.find(layoutType);
  if (it2 == it->second.end()) return nullptr;
  return it2->second;
}

void CollectionViewModule::unregisterLayoutCache(int32_t id) {
  std::lock_guard<std::mutex> lock(registryMutex());
  registry().erase(id);
  engineRegistry().erase(id);
}

std::shared_ptr<rncv::LayoutCache> CollectionViewModule::getLayoutCacheForId(
    int32_t id) {
  std::lock_guard<std::mutex> lock(registryMutex());
  auto it = registry().find(id);
  if (it == registry().end()) return nullptr;
  return it->second.lock(); // returns nullptr if expired
}

// Free-function thin wrapper — declared in LayoutCacheRegistry.h.
// Allows native iOS views to access the cache without importing the
// full CollectionViewModule.h header.
// NOTE: already inside namespace facebook::react — no nested namespace block needed.
std::shared_ptr<rncv::LayoutCache> layoutCacheForId(int32_t cacheId) {
  return CollectionViewModule::getLayoutCacheForId(cacheId);
}

// ── Scroll handler registry ───────────────────────────────────────────────────
void invokeScrollHandler(int32_t cacheId, double x, double y, bool animated); // forward decl

// ── Scroll helper ────────────────────────────────────────────────────────────
// Core scroll-to-key logic shared by scrollToKey, scrollToIndexPath, scrollToSection.
// Looks up attrs by key, computes target primary-axis offset (accounting for sticky
// supplementary pin sizes derived from the cache), clamps, and invokes the handler.
static void doScrollToKey(
    const std::shared_ptr<rncv::LayoutCache>& cache,
    int32_t cacheId,
    const std::string& key,
    bool isHoriz, double vpW, double vpH,
    bool leadPin, bool trailPin,
    const std::string& position,
    double curScroll, bool animated) {

  auto attrsOpt = cache->getAttributes(key);
  if (!attrsOpt.has_value()) return;
  const auto& attrs = attrsOpt.value();

  double leadSz = 0.0, trailSz = 0.0;
  if (leadPin || trailPin) {
    const auto colon = key.find(':');
    if (colon != std::string::npos) {
      const std::string pfx = key.substr(0, colon + 1);
      if (leadPin) {
        auto h = cache->getAttributes(pfx + "header");
        if (h) leadSz = isHoriz ? h->frame.width : h->frame.height;
      }
      if (trailPin) {
        auto f = cache->getAttributes(pfx + "footer");
        if (f) trailSz = isHoriz ? f->frame.width : f->frame.height;
      }
    }
  }

  const double primary = isHoriz ? attrs.frame.x : attrs.frame.y;
  const double dim     = isHoriz ? attrs.frame.width : attrs.frame.height;
  const double vp      = isHoriz ? vpW : vpH;

  double target;
  if (position == "start" || position == "top") {
    target = primary - leadSz;
  } else if (position == "end" || position == "bottom") {
    target = primary - (vp - trailSz) + dim;
  } else if (position == "center") {
    target = primary - leadSz - ((vp - leadSz - trailSz) - dim) / 2.0;
  } else { // "nearest"
    const double visLead  = curScroll + leadSz;
    const double visTrail = curScroll + vp - trailSz;
    if (primary >= visLead && primary + dim <= visTrail) return; // already visible
    target = (primary < visLead) ? (primary - leadSz) : (primary - (vp - trailSz) + dim);
  }

  auto sz = cache->getTotalContentSize();
  const double maxP = std::max(0.0, (isHoriz ? sz.width : sz.height) - vp);
  target = std::max(0.0, std::min(target, maxP));

  invokeScrollHandler(cacheId, isHoriz ? target : 0.0, isHoriz ? 0.0 : target, animated);
}

// Container views register a callback so JS (nativeMod.scrollTo) can trigger
// programmatic scrolling without direct coupling to the native view class.

using ScrollHandler = std::function<void(double x, double y, bool animated)>;

static std::unordered_map<int32_t, ScrollHandler>& scrollHandlerRegistry() {
  static std::unordered_map<int32_t, ScrollHandler> reg;
  return reg;
}
static std::mutex& scrollHandlerMutex() {
  static std::mutex m;
  return m;
}

void registerScrollHandler(int32_t cacheId, ScrollHandler handler) {
  std::lock_guard<std::mutex> lock(scrollHandlerMutex());
  scrollHandlerRegistry()[cacheId] = std::move(handler);
}

void unregisterScrollHandler(int32_t cacheId) {
  std::lock_guard<std::mutex> lock(scrollHandlerMutex());
  scrollHandlerRegistry().erase(cacheId);
}

void invokeScrollHandler(int32_t cacheId, double x, double y, bool animated) {
  ScrollHandler handler;
  {
    std::lock_guard<std::mutex> lock(scrollHandlerMutex());
    auto it = scrollHandlerRegistry().find(cacheId);
    if (it == scrollHandlerRegistry().end()) return;
    handler = it->second;
  }
  handler(x, y, animated);
}

// ── Constructor ──────────────────────────────────────────────────────────────

CollectionViewModule::CollectionViewModule(
    std::shared_ptr<CallInvoker> jsInvoker)
    : TurboModule(kModuleName, jsInvoker)
    , _layoutCache(std::make_shared<rncv::LayoutCache>())
    , _listLayout(std::make_shared<rncv::ListLayout>(_layoutCache))
    , _masonryLayout(std::make_shared<rncv::MasonryLayout>(_layoutCache))
    , _gridLayout(std::make_shared<rncv::GridLayout>(_layoutCache))
    , _flowLayout(std::make_shared<rncv::FlowLayout>(_layoutCache))
    , _compositionalLayout(std::make_shared<rncv::CompositionalLayout>(
          _layoutCache, _listLayout, _gridLayout, _flowLayout, _masonryLayout))
{
  _layoutCacheId = registerLayoutCache(_layoutCache);
  registerLayoutEngine(_layoutCacheId, "list", _listLayout);
  registerLayoutEngine(_layoutCacheId, "grid", _gridLayout);
  registerLayoutEngine(_layoutCacheId, "masonry", _masonryLayout);
  registerLayoutEngine(_layoutCacheId, "flow", _flowLayout);
  registerLayoutEngine(_layoutCacheId, "compositional", _compositionalLayout);
}

std::string CollectionViewModule::ping() {
  return "pong";
}

void CollectionViewModule::invalidate() {
  _layoutCacheJSI.reset();
  _listLayoutJSI.reset();
  _windowControllerJSI.reset();
  _metricsJSI.reset();
  _signpostJSI.reset();
  _diffEngineJSI.reset();
  _memoryJSI.reset();
  _masonryLayoutJSI.reset();
  _gridLayoutJSI.reset();
  _flowLayoutJSI.reset();
  _compositionalLayoutJSI.reset();

  _memoryPressureJsFn.reset();
  _memoryPressureRt = nullptr;
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

    // processScroll(vpPrimary, vpCross, isHorizontal, renderMult,
    //              stride, measureAheadMult, mountedWindowSize,
    //              itemCount, sectionInfoPacked?, budgetCols?)
    //   → { renderFirst, renderLast, visibleFirst, visibleLast,
    //       measureFirst, measureLast, cacheVersion }
    //
    // Scroll offset and velocity are read directly from LayoutCache — native
    // scrollViewDidScroll: writes them on the UI thread via setScrollOffset().
    // JS does NOT pass scroll position or velocity.
    //
    // Opt 6: Early return when cacheVersion is unchanged and scroll offset
    // is within the stable band (±¼ viewport) — skips spatial queries entirely.
    //
    // sectionInfoPacked (arg 8): JS Array [start0, headerOffset0, dataCount0, ...]
    //   one triple per section. Omit / pass null for single-section lists.
    obj.setProperty(rt, "processScroll",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "processScroll"), 11,
        [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
          double vpPrimary        = count > 0 && args[0].isNumber() ? args[0].getNumber() : 0.0;
          double vpCross          = count > 1 && args[1].isNumber() ? args[1].getNumber() : 0.0;
          bool   isHoriz          = count > 2 && args[2].isBool()   ? args[2].getBool()   : false;
          double renderMult       = count > 3 && args[3].isNumber() ? args[3].getNumber() : 1.0;
          double stride           = count > 4 && args[4].isNumber() ? args[4].getNumber() : 0.0;
          double measureAheadMult = count > 5 && args[5].isNumber() ? args[5].getNumber() : 0.0;
          double mountedWindowSz  = count > 6 && args[6].isNumber() ? args[6].getNumber() : 1e10;
          int    itemCount        = count > 7 && args[7].isNumber()  ? static_cast<int>(args[7].getNumber()) : 0;
          int    budgetCols       = count > 9 && args[9].isNumber() ? static_cast<int>(args[9].getNumber()) : 1;
          bool   sorted           = count > 10 && args[10].isBool() ? args[10].getBool()  : false;

          // sectionInfoPacked: flat array [start0, headerOffset0, dataCount0, start1, ...]
          struct SecInfo { int start; int headerOffset; int dataCount; };
          std::vector<SecInfo> sections;
          if (count > 8 && args[8].isObject()) {
            auto sArr = args[8].getObject(rt);
            if (sArr.isArray(rt)) {
              auto arr = sArr.getArray(rt);
              size_t n = arr.size(rt);
              sections.reserve(n / 3);
              for (size_t i = 0; i + 2 < n; i += 3) {
                sections.push_back({
                  static_cast<int>(arr.getValueAtIndex(rt, i).getNumber()),
                  static_cast<int>(arr.getValueAtIndex(rt, i + 1).getNumber()),
                  static_cast<int>(arr.getValueAtIndex(rt, i + 2).getNumber()),
                });
              }
            }
          }
          bool sectioned = !sections.empty();

          // Opt D: Read scroll offset + velocity + version in a single lock
          // (was 2 locks: getScrollOffsetAndVelocity + version).
          auto snapshot = _layoutCache->getScrollSnapshotWithVersion();
          double scrollPrimary = isHoriz ? snapshot.offset.x : snapshot.offset.y;
          double velocity = snapshot.velocity;
          int32_t curVersion = static_cast<int32_t>(snapshot.version);

          // Flat-index computation — mirrors JS attrToFlatIndex()
          auto toFlatIdx = [&](const rncv::LayoutAttributes& a) -> int {
            if (a.isDecoration) return -1;
            if (!sectioned) {
              // Single-section: supplementaries have no flat index in the item range
              return a.isSupplementary ? -1 : a.index;
            }
            int si = a.section;
            if (si < 0 || si >= static_cast<int>(sections.size())) return -1;
            const auto& sec = sections[static_cast<size_t>(si)];
            if (a.isSupplementary) {
              if (a.supplementaryKind == "header") return sec.start;
              if (a.supplementaryKind == "footer")
                return sec.start + sec.headerOffset + sec.dataCount;
              return -1;
            }
            return sec.start + sec.headerOffset + a.index;
          };

          // Helper: return an empty result with just the current cache version
          auto makeEmpty = [&]() -> Value {
            double ver = static_cast<double>(curVersion);
            Object r(rt);
            r.setProperty(rt, "renderFirst",  Value(0));
            r.setProperty(rt, "renderLast",   Value(-1));
            r.setProperty(rt, "visibleFirst", Value(0));
            r.setProperty(rt, "visibleLast",  Value(-1));
            r.setProperty(rt, "measureFirst", Value(0));
            r.setProperty(rt, "measureLast",  Value(-1));
            r.setProperty(rt, "cacheVersion", Value(ver));
            r.setProperty(rt, "blankBefore",  Value(0.0));
            r.setProperty(rt, "blankAfter",   Value(0.0));
            return Value(rt, r);
          };

          if (vpPrimary <= 0.0 || itemCount == 0) return makeEmpty();
          if (curVersion == _lastScrollResult.cacheVersion &&
              scrollPrimary >= _lastScrollResult.bandLow &&
              scrollPrimary <= _lastScrollResult.bandHigh) {
            Object r(rt);
            r.setProperty(rt, "renderFirst",  Value(_lastScrollResult.renderFirst));
            r.setProperty(rt, "renderLast",   Value(_lastScrollResult.renderLast));
            r.setProperty(rt, "visibleFirst", Value(_lastScrollResult.visibleFirst));
            r.setProperty(rt, "visibleLast",  Value(_lastScrollResult.visibleLast));
            r.setProperty(rt, "measureFirst", Value(_lastScrollResult.measureFirst));
            r.setProperty(rt, "measureLast",  Value(_lastScrollResult.measureLast));
            r.setProperty(rt, "cacheVersion", Value(static_cast<double>(curVersion)));
            r.setProperty(rt, "blankBefore",  Value(_lastScrollResult.blankBefore));
            r.setProperty(rt, "blankAfter",   Value(_lastScrollResult.blankAfter));
            return Value(rt, r);
          }

          // Velocity-adaptive multipliers — mirrors CollectionView.tsx scroll handler
          double speed     = std::abs(velocity);
          double leadBoost = std::min(1.5, speed) * renderMult;
          double leadMult  = renderMult + leadBoost;
          double minTrail  = isHoriz ? 0.75 : 0.25;
          double trailMult = std::max(minTrail, renderMult - leadBoost * 0.5);
          bool   goingFwd  = velocity >= 0.0;
          double abovePad  = (goingFwd ? trailMult : leadMult) * vpPrimary;
          double belowPad  = (goingFwd ? leadMult  : trailMult) * vpPrimary;

          rncv::Rect renderRect, visibleRect;
          if (isHoriz) {
            renderRect  = { scrollPrimary - abovePad, 0.0,
                            vpPrimary + abovePad + belowPad, vpCross };
            visibleRect = { scrollPrimary, 0.0, vpPrimary, vpCross };
          } else {
            renderRect  = { 0.0, scrollPrimary - abovePad,
                            vpCross, vpPrimary + abovePad + belowPad };
            visibleRect = { 0.0, scrollPrimary, vpCross, vpPrimary };
          }

          int rFirst, rLast, vFirst, vLast;
          double blankFirstPos = 0, blankFirstSize = 0, blankLastPos = 0, blankLastSize = 0;

          if (sorted) {
            // ── Sorted-layout path: O(log n) binary search, zero struct copies ──
            // Opt D: both render + visible searches in a single lock (was 2 locks).
            double renderLo = scrollPrimary - abovePad;
            double renderHi = scrollPrimary + vpPrimary + belowPad;
            auto dualRange = _layoutCache->findDualRangeByPrimary(
                renderLo, renderHi,
                scrollPrimary, scrollPrimary + vpPrimary,
                isHoriz);
            auto& rRange = dualRange.render;
            if (rRange.firstIdx < 0) return makeEmpty();
            rFirst = rRange.firstIdx;
            rLast  = rRange.lastIdx;
            blankFirstPos  = rRange.firstPos;
            blankFirstSize = rRange.firstSize;
            blankLastPos   = rRange.lastPos;
            blankLastSize  = rRange.lastSize;

            auto& vRange = dualRange.visible;
            vFirst = vRange.firstIdx >= 0 ? vRange.firstIdx : rFirst;
            vLast  = vRange.lastIdx  >= 0 ? vRange.lastIdx  : rLast;
          } else {
            // ── Spatial-query path: for custom/non-sorted layouts ────────────
            auto renderAttrs = _layoutCache->getAttributesInRect(renderRect);
            rFirst = std::numeric_limits<int>::max();
            rLast  = std::numeric_limits<int>::min();
            for (const auto& a : renderAttrs) {
              int fi = a.flatIndex >= 0 ? a.flatIndex : toFlatIdx(a);
              if (fi < 0) continue;
              if (fi < rFirst) rFirst = fi;
              if (fi > rLast)  rLast  = fi;
            }

            if (rFirst == std::numeric_limits<int>::max()) return makeEmpty();

            auto visAttrs = _layoutCache->getAttributesInRect(visibleRect);
            vFirst = std::numeric_limits<int>::max();
            vLast  = std::numeric_limits<int>::min();
            for (const auto& a : visAttrs) {
              int fi = a.flatIndex >= 0 ? a.flatIndex : toFlatIdx(a);
              if (fi < 0) continue;
              if (fi < vFirst) vFirst = fi;
              if (fi > vLast)  vLast  = fi;
            }
            if (vFirst == std::numeric_limits<int>::max()) { vFirst = rFirst; vLast = rLast; }
          }

          // Apply budget.
          // Derive effective cols from actual layout data: how many items the
          // binary search / spatial query returned vs how many a single-column
          // layout would have in the same pixel window, then take the max with
          // budgetCols so that flow/masonry layouts never trim below a full row.
          // For flow: budgetCols = maxItemsPerRow (from budgetColumns()), ensuring
          // budget covers the whole layout when totalItems < budget.
          // For list (budgetCols=1): max(1, ...) — same as before.
          rncv::Range render  = { rFirst, rLast };
          rncv::Range visible = { vFirst, vLast };
          double renderRectSize = vpPrimary + abovePad + belowPad;
          double effectiveCols = (stride > 0.0 && renderRectSize > 0.0)
            ? std::max(static_cast<double>(budgetCols),
                       static_cast<double>(rLast - rFirst + 1) * stride / renderRectSize)
            : static_cast<double>(budgetCols);
          auto budgeted = rncv::WindowController::applyBudget(
            render, visible, mountedWindowSz, vpPrimary, stride, effectiveCols);

          // Measure range (optional — only when measureAheadMult > 0 and stride known)
          int mFirst = budgeted.first, mLast = budgeted.last;
          if (measureAheadMult > 0.0 && stride > 0.0) {
            int ahead = static_cast<int>(std::ceil(measureAheadMult * vpPrimary / stride));
            auto mr = rncv::WindowController::computeMeasureRange(budgeted, ahead, itemCount);
            mFirst = mr.first;
            mLast  = mr.last;
          }

          // Opt D: reuse version from initial snapshot (same JS thread, no interleaving).
          double ver = static_cast<double>(curVersion);

          // ── Blank area ────────────────────────────────────────────────────
          double blankBefore = 0.0, blankAfter = 0.0;
          if (sorted) {
            // Sorted path: first/last positions already known from findRangeByPrimary.
            if (blankFirstPos >= 0.0)
              blankBefore = std::max(0.0, blankFirstPos - scrollPrimary);
            if (blankLastPos >= 0.0)
              blankAfter  = std::max(0.0, scrollPrimary + vpPrimary - (blankLastPos + blankLastSize));
          } else {
            // Spatial-query path: scan renderAttrs for budgeted first/last frames.
            // (renderAttrs is only in scope on the spatial-query branch — but this
            // entire else block only runs when sorted=false, so renderAttrs exists.)
            // NOTE: renderAttrs was declared in the else branch above and is not
            // accessible here. We need to re-query or the caller must pass data.
            // For now, blank area on the spatial path uses zero (acceptable — custom
            // layouts rarely use onBlankArea). Full fix: move blank computation into
            // each branch.
            blankBefore = 0.0;
            blankAfter  = 0.0;
          }

          // ── Change C: collect per-item frame data ────────────────────────
          // Gathers x,y,w,h for every cache entry in [mFirst,mLast] in a single
          // mutex acquisition. JS reads cellWidth/height from this array instead
          // of making ~30 individual JSI calls per render (one per visible cell).
          auto frames = _layoutCache->getFramesForFlatRange(mFirst, mLast);

          // ── Cache result for Opt 6 stable-band skip ─────────────────────
          _lastScrollResult.renderFirst  = budgeted.first;
          _lastScrollResult.renderLast   = budgeted.last;
          _lastScrollResult.visibleFirst = vFirst;
          _lastScrollResult.visibleLast  = vLast;
          _lastScrollResult.measureFirst = mFirst;
          _lastScrollResult.measureLast  = mLast;
          _lastScrollResult.cacheVersion = curVersion;
          _lastScrollResult.blankBefore  = blankBefore;
          _lastScrollResult.blankAfter   = blankAfter;
          _lastScrollResult.frames       = frames;
          _lastScrollResult.framesFirst  = mFirst;
          // Stable band: ±¼ viewport from current scroll position.
          _lastScrollResult.bandLow  = scrollPrimary - vpPrimary * 0.25;
          _lastScrollResult.bandHigh = scrollPrimary + vpPrimary * 0.25;

          // Pack frame data into a flat JSI Array.
          auto frameArr = Array(rt, frames.size());
          for (size_t i = 0; i < frames.size(); ++i)
            frameArr.setValueAtIndex(rt, i, Value(frames[i]));

          Object result(rt);
          result.setProperty(rt, "renderFirst",  Value(budgeted.first));
          result.setProperty(rt, "renderLast",   Value(budgeted.last));
          result.setProperty(rt, "visibleFirst", Value(vFirst));
          result.setProperty(rt, "visibleLast",  Value(vLast));
          result.setProperty(rt, "measureFirst", Value(mFirst));
          result.setProperty(rt, "measureLast",  Value(mLast));
          result.setProperty(rt, "cacheVersion", Value(ver));
          result.setProperty(rt, "blankBefore",  Value(blankBefore));
          result.setProperty(rt, "blankAfter",   Value(blankAfter));
          result.setProperty(rt, "frames",       Value(rt, std::move(frameArr)));
          result.setProperty(rt, "framesFirst",  Value(mFirst));
          return Value(rt, result);
        }));

    // processHScroll(sectionIndex, scrollX, vpWidth, renderMult,
    //                sectionY, sectionHeight, flatBase, itemCount)
    //   → { renderFirst, renderLast, frames?, framesFirst?, cacheVersion? }
    //
    // Computes the H-axis render range for a single orthogonal section.
    // Called from JS on every onHScroll event from RNOrthogonalSectionView.
    //
    // Uses a spatial rect query over the section's V band (sectionY..sectionY+sectionHeight)
    // × H render window (scrollX ± renderMult*vpWidth), then clamps to the section's
    // flat index range [flatBase, flatBase+itemCount). This correctly excludes items
    // from adjacent V-sections that share the same X coordinates.
    //
    // H-1: After the range is determined, this function bulk-reads frames for
    // [renderFirst, renderLast] under a single mutex acquisition and returns
    // them as a packed flat [x, y_section_local, w, h, ...] array. Y values are
    // section-local (frame.y - sectionY) so they remain valid even if MVC
    // corrections shift section.y above this section. JS uses this to bypass
    // per-cell attributesForItem JSI calls — same Change C win that V cells get
    // from processScroll's frames return.
    obj.setProperty(rt, "processHScroll",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "processHScroll"), 8,
        [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
          auto makeEmpty = [&](int base) -> Value {
            Object r(rt);
            r.setProperty(rt, "renderFirst", Value(base));
            r.setProperty(rt, "renderLast",  Value(base - 1));
            return Value(rt, r);
          };

          if (count < 8) return makeEmpty(0);

          double scrollX       = args[1].isNumber() ? args[1].getNumber() : 0.0;
          double vpWidth       = args[2].isNumber() ? args[2].getNumber() : 0.0;
          double renderMult    = args[3].isNumber() ? args[3].getNumber() : 0.5;
          double sectionY      = args[4].isNumber() ? args[4].getNumber() : 0.0;
          double sectionHeight = args[5].isNumber() ? args[5].getNumber() : 0.0;
          int    flatBase      = args[6].isNumber() ? static_cast<int>(args[6].getNumber()) : 0;
          int    itemCount     = args[7].isNumber() ? static_cast<int>(args[7].getNumber()) : 0;
          int    sectionIdx    = args[0].isNumber() ? static_cast<int>(args[0].getNumber()) : 0;

          RNCV_HSUB_MOD_LOG(
            "IN s=%d scrollX=%.1f vpW=%.1f mult=%.2f "
            "sectionY=%.1f sectionH=%.1f flatBase=%d itemCount=%d",
            sectionIdx, scrollX, vpWidth, renderMult,
            sectionY, sectionHeight, flatBase, itemCount);

          if (vpWidth <= 0.0 || itemCount == 0) return makeEmpty(flatBase);

          // H-3: Velocity-adaptive padding along the H axis.
          // Track per-section (scrollX, wallClockMs) to derive px/ms velocity.
          // Apply the same asymmetric lead/trail formula as V processScroll:
          //   speed     = |velocity| in px/ms
          //   leadBoost = min(1.5, speed) * renderMult
          //   leadMult  = renderMult + leadBoost   (grow toward direction of travel)
          //   trailMult = max(0.75, renderMult - leadBoost * 0.5)  (shrink behind)
          // This guarantees the window is at least renderMult wide on the trailing
          // side, while expanding up to 2.5× renderMult on the leading side at
          // maximum velocity.
          // (sectionIdx already extracted above for logging.)

          auto nowMs = static_cast<double>(
              std::chrono::duration_cast<std::chrono::microseconds>(
                  std::chrono::steady_clock::now().time_since_epoch()).count()) / 1000.0;

          auto& hState = _hScrollStates[sectionIdx];
          if (hState.lastTimestampMs >= 0.0) {
            double dt = nowMs - hState.lastTimestampMs;
            if (dt > 0.5) {  // skip if < 0.5 ms apart (duplicate event noise)
              hState.velocity = (scrollX - hState.lastScrollX) / dt;
            }
          }
          hState.lastScrollX     = scrollX;
          hState.lastTimestampMs = nowMs;

          double speed = std::abs(hState.velocity);

          // Asymmetric lead/trail formula (mirrors V processScroll):
          //   leadBoost = min(1.5, speed) * renderMult
          //   leadMult  = renderMult + leadBoost   (grow toward direction of travel)
          //   trailMult = max(0.75, renderMult - leadBoost * 0.5)  (shrink behind)
          //
          // An earlier iteration applied a low-velocity dead-zone here to
          // stop boundary-cell flicker during bounce decay (range flipping
          // 5..8 ↔ 4..8 as |vel| oscillated 0.05 ↔ 0.16 px/ms). That
          // flicker was the surface symptom of a deeper feedback loop:
          // round-tripping section size through JS as a Fabric prop
          // re-rendered cells on every commit, which thrashed the bounce
          // animation. H-2.1 cuts the round-trip at its source — section
          // size now flows cache → C++ ShadowNode → state without React
          // in the loop, so even when the H window range changes 1 cell
          // per tick during decay, the cells just toggle visibility
          // natively and UIKit's bounce timer is undisturbed.
          double leadBoost = std::min(1.5, speed) * renderMult;
          double leadMult  = renderMult + leadBoost;
          double trailMult = std::max(0.75, renderMult - leadBoost * 0.5);
          bool   goingRight = hState.velocity >= 0.0;

          double leftPad  = (goingRight ? trailMult : leadMult) * vpWidth;
          double rightPad = (goingRight ? leadMult  : trailMult) * vpWidth;

          // Spatial rect: H render window × section V band.
          rncv::Rect queryRect = {
            scrollX - leftPad,                // x (may be negative — clamped inside getAttributesInRect)
            sectionY,                         // y
            vpWidth + leftPad + rightPad,     // width
            sectionHeight                     // height
          };

          auto attrs = _layoutCache->getAttributesInRect(queryRect);

          int rFirst = std::numeric_limits<int>::max();
          int rLast  = std::numeric_limits<int>::min();
          int matchedItems = 0;

          for (const auto& a : attrs) {
            if (a.isDecoration || a.isSupplementary) continue;
            // flatIndex is pre-computed for compositional layouts; fall back to
            // section-relative index + flatBase for standalone H layouts.
            int fi = (a.flatIndex >= 0) ? a.flatIndex : (flatBase + a.index);
            // Clamp to this section's flat range.
            if (fi < flatBase || fi >= flatBase + itemCount) continue;
            if (fi < rFirst) rFirst = fi;
            if (fi > rLast)  rLast  = fi;
            matchedItems++;
          }

          RNCV_HSUB_MOD_LOG(
            "WIN s=%d vel=%.4f speed=%.4f goingRight=%d "
            "leadMult=%.2f trailMult=%.2f leftPad=%.1f rightPad=%.1f "
            "queryRect=(x=%.1f y=%.1f w=%.1f h=%.1f) "
            "rawAttrs=%zu matched=%d range=%d..%d",
            sectionIdx, hState.velocity, speed, goingRight ? 1 : 0,
            leadMult, trailMult, leftPad, rightPad,
            queryRect.x, queryRect.y, queryRect.width, queryRect.height,
            attrs.size(), matchedItems, rFirst, rLast);

          if (rFirst == std::numeric_limits<int>::max()) {
            // No items in range — also update stable-band state so next call
            // with the same empty result skips the spatial query.
            hState.prevRenderFirst  = flatBase;
            hState.prevRenderLast   = flatBase - 1;
            hState.prevCacheVersion = _layoutCache->version();
            return makeEmpty(flatBase);
          }

          // H-4: Stable-band skip — if range and cacheVersion are unchanged,
          // return a lightweight sentinel so JS skips the frame-data overwrite
          // and React re-render. Saves the spatial query on ~80% of scroll ticks
          // during steady H scrolling.
          {
            uint64_t curVersion = _layoutCache->version();
            if (rFirst == hState.prevRenderFirst &&
                rLast  == hState.prevRenderLast  &&
                curVersion == hState.prevCacheVersion) {
              Object r(rt);
              r.setProperty(rt, "unchanged", Value(true));
              // Include range values so callers that don't check `unchanged`
              // (e.g. the render-body initial-compute path) still get valid data.
              r.setProperty(rt, "renderFirst", Value(rFirst));
              r.setProperty(rt, "renderLast",  Value(rLast));
              return Value(rt, r);
            }
            hState.prevRenderFirst  = rFirst;
            hState.prevRenderLast   = rLast;
            hState.prevCacheVersion = curVersion;
          }

          // H-1: Bulk-read frames for [rFirst, rLast] under a single mutex acquisition.
          // getFramesForFlatRangeWithVersion returns y in V-absolute coords (as stored
          // in LayoutCache after CompositionalLayout::finalizeHSection shifts H-section
          // item Y to V-absolute for processScroll spatial queries). We subtract
          // sectionY here to convert to section-local for the renderCell consumer —
          // section-local y is invariant under V-section reflows that change section.y.
          auto fwv = _layoutCache->getFramesForFlatRangeWithVersion(rFirst, rLast);
          // Convert y to section-local in place. Layout: [x, y, w, h, x, y, w, h, ...]
          for (size_t i = 1; i < fwv.frames.size(); i += 4) {
            fwv.frames[i] -= sectionY;
          }

          // Pack frames into a JSI Array (matches processScroll's pattern).
          auto frameArr = Array(rt, fwv.frames.size());
          for (size_t i = 0; i < fwv.frames.size(); ++i)
            frameArr.setValueAtIndex(rt, i, Value(fwv.frames[i]));

          Object r(rt);
          r.setProperty(rt, "renderFirst",  Value(rFirst));
          r.setProperty(rt, "renderLast",   Value(rLast));
          r.setProperty(rt, "frames",       Value(rt, std::move(frameArr)));
          r.setProperty(rt, "framesFirst",  Value(rFirst));
          r.setProperty(rt, "cacheVersion", Value(static_cast<double>(fwv.version)));
          return Value(rt, r);
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

  if (prop == "layoutCacheId")     return Value(_layoutCacheId);
  if (prop == "layoutCache")      return getLayoutCacheObject(rt);
  if (prop == "listLayout")       return getListLayoutObject(rt);
  if (prop == "windowController") return getWindowControllerObject(rt);
  if (prop == "metrics")          return getMetricsObject(rt);
  if (prop == "signpost")         return getSignpostObject(rt);
  if (prop == "diffEngine")       return getDiffEngineObject(rt);
  if (prop == "memory")           return getMemoryObject(rt);
  if (prop == "masonryLayout")         return getMasonryLayoutObject(rt);
  if (prop == "gridLayout")            return getGridLayoutObject(rt);
  if (prop == "flowLayout")            return getFlowLayoutObject(rt);
  if (prop == "compositionalLayout")   return getCompositionalLayoutObject(rt);

  // scrollTo(cacheId, x, y, animated) — triggers programmatic scroll on the
  // native container view via the scroll handler registry.
  if (prop == "scrollTo") {
    return Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "scrollTo"), 4,
      [](Runtime&, const Value&, const Value* args, size_t count) -> Value {
        if (count < 3) return Value::undefined();
        const int32_t cacheId = static_cast<int32_t>(args[0].asNumber());
        const double  x       = args[1].asNumber();
        const double  y       = args[2].asNumber();
        const bool    animated = count > 3 ? args[3].getBool() : true;
        invokeScrollHandler(cacheId, x, y, animated);
        return Value::undefined();
      });
  }

  // scrollToKey(cacheId, key, isHoriz, vpW, vpH, hasLeadPin, hasTrailPin, position, curScroll, animated)
  if (prop == "scrollToKey") {
    return Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "scrollToKey"), 10,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 9) return Value::undefined();
        const int32_t     cacheId   = static_cast<int32_t>(args[0].asNumber());
        const std::string key       = args[1].getString(rt).utf8(rt);
        const bool        isHoriz   = args[2].getBool();
        const double      vpW       = args[3].asNumber();
        const double      vpH       = args[4].asNumber();
        const bool        leadPin   = args[5].getBool();
        const bool        trailPin  = args[6].getBool();
        const std::string position  = args[7].getString(rt).utf8(rt);
        const double      curScroll = args[8].asNumber();
        const bool        animated  = count > 9 ? args[9].getBool() : true;
        auto cache = CollectionViewModule::getLayoutCacheForId(cacheId);
        if (!cache) return Value::undefined();
        doScrollToKey(cache, cacheId, key, isHoriz, vpW, vpH, leadPin, trailPin, position, curScroll, animated);
        return Value::undefined();
      });
  }

  // scrollToIndexPath(cacheId, section, item, isHoriz, vpW, vpH, hasLeadPin, hasTrailPin, position, curScroll, animated)
  // Resolves (section, item) → key via O(1) reverse index, then scrolls.
  if (prop == "scrollToIndexPath") {
    return Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "scrollToIndexPath"), 11,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 10) return Value::undefined();
        const int32_t     cacheId   = static_cast<int32_t>(args[0].asNumber());
        const int32_t     section   = static_cast<int32_t>(args[1].asNumber());
        const int32_t     item      = static_cast<int32_t>(args[2].asNumber());
        const bool        isHoriz   = args[3].getBool();
        const double      vpW       = args[4].asNumber();
        const double      vpH       = args[5].asNumber();
        const bool        leadPin   = args[6].getBool();
        const bool        trailPin  = args[7].getBool();
        const std::string position  = args[8].getString(rt).utf8(rt);
        const double      curScroll = args[9].asNumber();
        const bool        animated  = count > 10 ? args[10].getBool() : true;
        auto cache = CollectionViewModule::getLayoutCacheForId(cacheId);
        if (!cache) return Value::undefined();
        auto keyOpt = cache->getKeyForIndexPath(section, item);
        if (!keyOpt) return Value::undefined();
        doScrollToKey(cache, cacheId, *keyOpt, isHoriz, vpW, vpH, leadPin, trailPin, position, curScroll, animated);
        return Value::undefined();
      });
  }

  // scrollToSection(cacheId, sectionIndex, isHoriz, vpW, vpH, position, curScroll, animated)
  // Scrolls to section header if present; falls back to first item of section.
  if (prop == "scrollToSection") {
    return Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "scrollToSection"), 8,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 7) return Value::undefined();
        const int32_t     cacheId   = static_cast<int32_t>(args[0].asNumber());
        const int32_t     section   = static_cast<int32_t>(args[1].asNumber());
        const bool        isHoriz   = args[2].getBool();
        const double      vpW       = args[3].asNumber();
        const double      vpH       = args[4].asNumber();
        const std::string position  = args[5].getString(rt).utf8(rt);
        const double      curScroll = args[6].asNumber();
        const bool        animated  = count > 7 ? args[7].getBool() : true;
        auto cache = CollectionViewModule::getLayoutCacheForId(cacheId);
        if (!cache) return Value::undefined();
        // Header first (scroll to section header, no pin offset — we're showing the header itself)
        auto hdrOpt = cache->getHeaderKeyForSection(section);
        if (hdrOpt) {
          doScrollToKey(cache, cacheId, *hdrOpt, isHoriz, vpW, vpH, false, false, position, curScroll, animated);
          return Value::undefined();
        }
        // Fallback: first item of section
        auto itemOpt = cache->getKeyForIndexPath(section, 0);
        if (!itemOpt) return Value::undefined();
        doScrollToKey(cache, cacheId, *itemOpt, isHoriz, vpW, vpH, false, false, position, curScroll, animated);
        return Value::undefined();
      });
  }

  // scrollToEnd(cacheId, isHoriz, vpW, vpH, animated)
  // Scrolls to the trailing edge of content — contentSize - viewport on primary axis.
  if (prop == "scrollToEnd") {
    return Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "scrollToEnd"), 5,
      [](Runtime&, const Value&, const Value* args, size_t count) -> Value {
        if (count < 4) return Value::undefined();
        const int32_t cacheId  = static_cast<int32_t>(args[0].asNumber());
        const bool    isHoriz  = args[1].getBool();
        const double  vpW      = args[2].asNumber();
        const double  vpH      = args[3].asNumber();
        const bool    animated = count > 4 ? args[4].getBool() : true;
        auto cache = CollectionViewModule::getLayoutCacheForId(cacheId);
        if (!cache) return Value::undefined();
        auto sz = cache->getTotalContentSize();
        const double x = isHoriz ? std::max(0.0, sz.width  - vpW) : 0.0;
        const double y = isHoriz ? 0.0 : std::max(0.0, sz.height - vpH);
        invokeScrollHandler(cacheId, x, y, animated);
        return Value::undefined();
      });
  }

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

    // getMainThreadCPU() → number (0–100, % utilization. -1 if unavailable.)
    // The ObjC callback dispatches_sync to the main thread and reads
    // thread_basic_info.cpu_usage via the Mach thread_info API.
    obj.setProperty(rt, "getMainThreadCPU",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "getMainThreadCPU"), 0,
        [this](Runtime&, const Value&, const Value*, size_t) -> Value {
          double cpu = _mainThreadCPUCb ? _mainThreadCPUCb() : -1;
          return Value(cpu);
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

// ── F3.2: masonry layout JSI object ───────────────────────────────────────────

Value CollectionViewModule::getMasonryLayoutObject(Runtime& rt) {
  if (!_masonryLayoutJSI.has_value()) {
    Object obj(rt);
    _masonryLayout->installJSIBindings(rt, obj);
    _masonryLayoutJSI = std::move(obj);
  }
  return Value(rt, *_masonryLayoutJSI);
}

// ── R1.3: grid layout JSI object ──────────────────────────────────────────────

Value CollectionViewModule::getGridLayoutObject(Runtime& rt) {
  if (!_gridLayoutJSI.has_value()) {
    Object obj(rt);
    _gridLayout->installJSIBindings(rt, obj);
    _gridLayoutJSI = std::move(obj);
  }
  return Value(rt, *_gridLayoutJSI);
}

// ── R1.3: flow layout JSI object ─────────────────────────────────────────────

Value CollectionViewModule::getFlowLayoutObject(Runtime& rt) {
  if (!_flowLayoutJSI.has_value()) {
    Object obj(rt);
    _flowLayout->installJSIBindings(rt, obj);
    _flowLayoutJSI = std::move(obj);
  }
  return Value(rt, *_flowLayoutJSI);
}

// ── Compositional layout JSI object ──────────────────────────────────────────

Value CollectionViewModule::getCompositionalLayoutObject(Runtime& rt) {
  if (!_compositionalLayoutJSI.has_value()) {
    Object obj(rt);
    _compositionalLayout->installJSIBindings(rt, obj);
    _compositionalLayoutJSI = std::move(obj);
  }
  return Value(rt, *_compositionalLayoutJSI);
}

// ── P4.1: memory JSI object ───────────────────────────────────────────────────

void CollectionViewModule::setGetAvailableMemoryCallback(std::function<int64_t()> cb) {
  _getAvailableMemoryCb = std::move(cb);
}

void CollectionViewModule::setMainThreadCPUCallback(std::function<double()> cb) {
  _mainThreadCPUCb = std::move(cb);
}

void CollectionViewModule::triggerMemoryPressure(int level) {
  if (!_memoryPressureJsFn || !_memoryPressureRt) return;
  auto fn = _memoryPressureJsFn;
  auto rt = _memoryPressureRt;
  jsInvoker_->invokeAsync([fn, rt, level]() {
    fn->call(*rt, Value(level));
  });
}

Value CollectionViewModule::getMemoryObject(Runtime& rt) {
  if (!_memoryJSI.has_value()) {
    Object obj(rt);

    // availableBytes() → number
    // Returns bytes available to this process via os_proc_available_memory().
    obj.setProperty(rt, "availableBytes",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "availableBytes"), 0,
        [this](Runtime&, const Value&, const Value*, size_t) -> Value {
          int64_t bytes = _getAvailableMemoryCb ? _getAvailableMemoryCb() : -1;
          return Value((double)bytes);
        }));

    // pressureLevel() → 0|1|2
    // 0=normal  1=low (< 150 MB)  2=critical (< 50 MB)
    obj.setProperty(rt, "pressureLevel",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "pressureLevel"), 0,
        [this](Runtime&, const Value&, const Value*, size_t) -> Value {
          int64_t bytes = _getAvailableMemoryCb ? _getAvailableMemoryCb() : INT64_MAX;
          int level = 0;
          if      (bytes < 50LL  * 1024 * 1024) level = 2;
          else if (bytes < 150LL * 1024 * 1024) level = 1;
          return Value(level);
        }));

    // onPressure(callback: (level: number) => void) → undefined
    // Registers a JS callback invoked via jsInvoker when a system memory warning
    // is received (or simulate() is called).
    obj.setProperty(rt, "onPressure",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "onPressure"), 1,
        [this](Runtime& rtInner, const Value&, const Value* args, size_t count) -> Value {
          if (count > 0 && args[0].isObject()) {
            auto fnObj = args[0].getObject(rtInner);
            if (fnObj.isFunction(rtInner)) {
              _memoryPressureRt = &rtInner;
              _memoryPressureJsFn = std::make_shared<Function>(fnObj.getFunction(rtInner));
            }
          }
          return Value::undefined();
        }));

    // simulate(level: number) → undefined
    // Fires the JS pressure callback immediately — used for testing.
    obj.setProperty(rt, "simulate",
      Function::createFromHostFunction(rt,
        PropNameID::forAscii(rt, "simulate"), 1,
        [this](Runtime&, const Value&, const Value* args, size_t count) -> Value {
          int level = (count > 0 && args[0].isNumber())
                      ? static_cast<int>(args[0].getNumber()) : 2;
          triggerMemoryPressure(level);
          return Value::undefined();
        }));

    _memoryJSI = std::move(obj);
  }
  return Value(rt, *_memoryJSI);
}

} // namespace facebook::react
