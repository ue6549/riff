#include "LayoutCache.h"

#include <algorithm>
#include <limits>
#include <stdexcept>

#ifndef RNCV_ENABLE_NATIVE_LOGS
#define RNCV_ENABLE_NATIVE_LOGS 0
#endif

// Set RNCV_ENABLE_MVC_TRACE=1 to enable verbose MVC lifecycle tracing.
// Covers: stashHeights, cache.clear, snapshotAnchor, snapshotAnchorIfNeeded,
// computeCorrection, and height source in computeSectionFromCache.
// Keep 0 in normal development; enable only to debug insert/delete/correction bugs.
#ifndef RNCV_ENABLE_MVC_TRACE
#define RNCV_ENABLE_MVC_TRACE 0
#endif

#if DEBUG && RNCV_ENABLE_NATIVE_LOGS
  #ifdef __APPLE__
    #include <os/log.h>
    #define RNCV_MVC_LOG(fmt, ...) os_log_info(os_log_create("com.rncv", "mvc"), "[RNCV-MVC] " fmt, ##__VA_ARGS__)
  #else
    #include <android/log.h>
    #define RNCV_MVC_LOG(fmt, ...) __android_log_print(ANDROID_LOG_INFO, "RNCV-MVC", fmt, ##__VA_ARGS__)
  #endif
#else
  #define RNCV_MVC_LOG(fmt, ...) ((void)0)
#endif

#if DEBUG && RNCV_ENABLE_MVC_TRACE
  #ifdef __APPLE__
    #ifndef RNCV_MVC_LOG_HEADER_INCLUDED
    #define RNCV_MVC_LOG_HEADER_INCLUDED
    #include <os/log.h>
    #endif
    #define RNCV_MVC_TRACE(fmt, ...) os_log_info(os_log_create("com.rncv", "mvc-trace"), "[MVC-TRACE] " fmt, ##__VA_ARGS__)
  #else
    #include <android/log.h>
    #define RNCV_MVC_TRACE(fmt, ...) __android_log_print(ANDROID_LOG_INFO, "MVC-TRACE", fmt, ##__VA_ARGS__)
  #endif
#else
  #define RNCV_MVC_TRACE(fmt, ...) ((void)0)
#endif

namespace rncv {

using namespace facebook;
using namespace facebook::jsi;

// ─── Core CRUD ───────────────────────────────────────────────────────────────

void LayoutCache::setAttributes(const LayoutAttributes& attrs) {
  std::lock_guard<std::mutex> lock(_mutex);
  _setAttributesLocked(attrs);
}

void LayoutCache::_setAttributesLocked(const LayoutAttributes& attrs) {
  auto it = _map.find(attrs.key);
  if (it == _map.end()) {
    _insertionOrder.push_back(attrs.key);
    _index.insert(attrs.key, attrs.frame);
  } else {
    _index.update(attrs.key, it->second.frame, attrs.frame);
  }
  _map[attrs.key] = attrs;
  ++_version;
}

std::optional<LayoutAttributes> LayoutCache::getAttributes(
    const std::string& key) const {
  std::lock_guard<std::mutex> lock(_mutex);
  auto it = _map.find(key);
  if (it == _map.end()) return std::nullopt;
  return it->second;
}

void LayoutCache::removeAttributes(const std::string& key) {
  std::lock_guard<std::mutex> lock(_mutex);
  auto it = _map.find(key);
  if (it != _map.end()) {
    _index.remove(key, it->second.frame);
    _map.erase(it);
    _insertionOrder.erase(
        std::remove(_insertionOrder.begin(), _insertionOrder.end(), key),
        _insertionOrder.end());
    ++_version;
  }
}

void LayoutCache::clear() {
  std::lock_guard<std::mutex> lock(_mutex);
  RNCV_MVC_TRACE("cache.clear: removing %zu entries", _map.size());
  _map.clear();
  _insertionOrder.clear();
  _index.clear();
  ++_version;
}

// ── Height stash ──────────────────────────────────────────────────────────────

void LayoutCache::stashHeights() {
  // No mutex needed: stash is only accessed from the JS thread, sequentially
  // with clear() and computeSections(). Never accessed from native threads.
  std::lock_guard<std::mutex> lock(_mutex);
  _heightStash.clear();
  for (const auto& kv : _map) {
    if (kv.second.sizingState == SizingState::Measured) {
      const double sz = _horizontal ? kv.second.frame.width : kv.second.frame.height;
      _heightStash[kv.first] = sz;
    }
  }
  RNCV_MVC_TRACE("stashHeights: %zu entries stashed (of %zu total)",
                  _heightStash.size(), _map.size());
}

double LayoutCache::getStashedHeight(const std::string& key) const {
  auto it = _heightStash.find(key);
  return it != _heightStash.end() ? it->second : -1.0;
}

void LayoutCache::clearStash() {
  _heightStash.clear();
}

// ─── Bulk access ─────────────────────────────────────────────────────────────

std::vector<LayoutAttributes> LayoutCache::getAll() const {
  std::lock_guard<std::mutex> lock(_mutex);
  std::vector<LayoutAttributes> result;
  result.reserve(_insertionOrder.size());
  for (const auto& key : _insertionOrder) {
    auto it = _map.find(key);
    if (it != _map.end()) result.push_back(it->second);
  }
  return result;
}

std::vector<LayoutAttributes> LayoutCache::getAttributesInRect(
    const Rect& rect) const {
  std::lock_guard<std::mutex> lock(_mutex);
  // M1.4: use spatial index — O(buckets_spanned + k) instead of O(n).
  auto candidates = _index.candidatesInRect(rect);
  std::vector<LayoutAttributes> result;
  result.reserve(candidates.size());
  for (const auto& key : candidates) {
    auto it = _map.find(key);
    if (it != _map.end() && rectsIntersect(it->second.frame, rect)) {
      result.push_back(it->second);
    }
  }
  return result;
}

// ─── Item heights (bulk read) ────────────────────────────────────────────────

std::vector<double> LayoutCache::getItemHeights(int section, int count) const {
  std::lock_guard<std::mutex> lock(_mutex);
  std::vector<double> heights(count, 0.0);
  for (int i = 0; i < count; ++i) {
    auto key = "item-" + std::to_string(section) + "-" + std::to_string(i);
    auto it = _map.find(key);
    if (it != _map.end()) {
      heights[i] = it->second.frame.height;
    }
  }
  return heights;
}

std::vector<double> LayoutCache::getItemHeightsByKeys(const std::vector<std::string>& keys) const {
  std::lock_guard<std::mutex> lock(_mutex);
  const int count = static_cast<int>(keys.size());
  std::vector<double> heights(count, 0.0);
  for (int i = 0; i < count; ++i) {
    auto it = _map.find(keys[i]);
    if (it != _map.end()) {
      heights[i] = it->second.frame.height;
    }
  }
  return heights;
}

// ─── Aggregate queries ────────────────────────────────────────────────────────

Size LayoutCache::getTotalContentSize() const {
  std::lock_guard<std::mutex> lock(_mutex);
  double maxX = 0;
  double maxY = 0;
  for (const auto& [key, attrs] : _map) {
    maxX = std::max(maxX, attrs.frame.x + attrs.frame.width);
    maxY = std::max(maxY, attrs.frame.y + attrs.frame.height);
  }
  return { maxX, maxY };
}

std::vector<double> LayoutCache::getSectionOffsets() const {
  std::lock_guard<std::mutex> lock(_mutex);
  std::vector<double> offsets;
  int currentSection = -1;
  // _insertionOrder is in layout order. Skip supplementary views (headers/
  // footers) so the offset reflects the first regular item's Y, not the
  // header's Y.
  for (const auto& key : _insertionOrder) {
    auto it = _map.find(key);
    if (it == _map.end()) continue;
    const auto& attrs = it->second;
    if (attrs.isSupplementary || attrs.isDecoration) continue;
    if (attrs.section != currentSection) {
      currentSection = attrs.section;
      // Fill any gaps (sparse sections)
      while (static_cast<int>(offsets.size()) <= currentSection) {
        offsets.push_back(attrs.frame.y);
      }
    }
  }
  return offsets;
}

uint64_t LayoutCache::version() const {
  std::lock_guard<std::mutex> lock(_mutex);
  return _version;
}

void LayoutCache::setScrollOffset(double x, double y, double timestampMs) {
  std::lock_guard<std::mutex> lock(_mutex);
  // Derive velocity from consecutive offset/timestamp pairs.
  // timestampMs comes from CACurrentMediaTime() * 1000 on iOS (native scroll handler).
  if (timestampMs > 0) {
    const double primary = _horizontal ? x : y;
    const double dt = timestampMs - _prevScrollTimestamp;
    if (dt > 0 && dt <= 100.0) {
      // Within 100ms gap — reasonable consecutive scroll events.
      _currentVelocity = (primary - _prevScrollPrimary) / dt;
    } else if (dt > 100.0) {
      // Too long between events — user stopped scrolling or new gesture.
      _currentVelocity = 0.0;
    }
    _prevScrollPrimary = primary;
    _prevScrollTimestamp = timestampMs;
  }
  _scrollOffset = {x, y};
}

Point LayoutCache::getScrollOffset() const {
  std::lock_guard<std::mutex> lock(_mutex);
  return _scrollOffset;
}

double LayoutCache::getVelocity() const {
  std::lock_guard<std::mutex> lock(_mutex);
  return _currentVelocity;
}

LayoutCache::ScrollSnapshot LayoutCache::getScrollOffsetAndVelocity() const {
  std::lock_guard<std::mutex> lock(_mutex);
  return {_scrollOffset, _currentVelocity};
}

// ─── MVC correction ──────────────────────────────────────────────────────────

void LayoutCache::_snapshotAnchorLocked() {
  // Caller must already hold _mutex.
  // For vertical: anchor = smallest Y at-or-below scrollOffset.y.
  // For horizontal: anchor = smallest X at-or-below scrollOffset.x.
  const double scrollPrimary = _horizontal ? _scrollOffset.x : _scrollOffset.y;
  std::string bestKey;
  double bestPrimary = std::numeric_limits<double>::max();
  bool found = false;
  for (const auto& [key, attrs] : _map) {
    if (attrs.isDecoration) continue;
    const double pos = _horizontal ? attrs.frame.x : attrs.frame.y;
    if (pos >= scrollPrimary && pos < bestPrimary) {
      bestKey = key; bestPrimary = pos; found = true;
    }
  }
  if (!found) {
    // Fallback: first item partially visible (trailing edge > scroll position)
    for (const auto& [key, attrs] : _map) {
      if (attrs.isDecoration) continue;
      const double pos = _horizontal ? attrs.frame.x : attrs.frame.y;
      const double trailing = pos + (_horizontal ? attrs.frame.width : attrs.frame.height);
      if (trailing > scrollPrimary && pos < bestPrimary) {
        bestKey = key; bestPrimary = pos; found = true;
      }
    }
  }
  if (found) {
    _anchorKey = std::move(bestKey);
    _anchorY   = bestPrimary;  // always stored in _anchorY for simplicity
    _anchorX   = bestPrimary;  // same value; caller uses _horizontal to pick
    _hasAnchor = true;
    RNCV_MVC_LOG("snapshotAnchor: key=%s oldY=%.1f scrollOffset=%.1f",
                 _anchorKey.c_str(), bestPrimary, scrollPrimary);
    RNCV_MVC_TRACE("snapshotAnchor: FOUND key=%s pos=%.1f scrollOffset=%.1f",
                   _anchorKey.c_str(), bestPrimary, scrollPrimary);
  } else {
    _hasAnchor = false;
    RNCV_MVC_LOG("snapshotAnchor: no anchor found (scrollOffset=%.1f mapSize=%zu)",
                 scrollPrimary, _map.size());
    RNCV_MVC_TRACE("snapshotAnchor: NOT FOUND scrollOffset=%.1f mapSize=%zu",
                   scrollPrimary, _map.size());
  }
}

void LayoutCache::snapshotAnchor() {
  std::lock_guard<std::mutex> lock(_mutex);
  _correctionConsumed = false;  // new transaction — re-arm allowed
  RNCV_MVC_TRACE("snapshotAnchor: correctionConsumed reset, hasAnchor was=%s mvcEnabled=%s",
                  _hasAnchor ? "YES" : "NO", _mvcEnabled ? "YES" : "NO");
  _snapshotAnchorLocked();
}

void LayoutCache::setMVCEnabled(bool enabled) {
  std::lock_guard<std::mutex> lock(_mutex);
  _mvcEnabled = enabled;
}

void LayoutCache::setHorizontal(bool horizontal) {
  std::lock_guard<std::mutex> lock(_mutex);
  _horizontal = horizontal;
}

void LayoutCache::snapshotAnchorIfNeeded() {
  std::lock_guard<std::mutex> lock(_mutex);
  if (_hasAnchor) {
    RNCV_MVC_TRACE("snapshotAnchorIfNeeded: SKIP hasAnchor=YES");
    return;   // JS already snapshotted before prepare()
  }
  if (!_mvcEnabled) {
    RNCV_MVC_TRACE("snapshotAnchorIfNeeded: SKIP mvcEnabled=NO");
    return;   // MVC disabled — don't auto-snapshot
  }
  if (_correctionConsumed) {
    RNCV_MVC_TRACE("snapshotAnchorIfNeeded: SKIP correctionConsumed=YES (prevents re-arm during scrollTo)");
    return;   // already corrected this transaction — don't re-arm
  }
  RNCV_MVC_TRACE("snapshotAnchorIfNeeded: SNAPSHOTTING (size-change path)");
  _snapshotAnchorLocked();
}

double LayoutCache::computeCorrection() {
  std::lock_guard<std::mutex> lock(_mutex);
  if (!_hasAnchor) return 0;
  _hasAnchor = false;          // one-shot
  _correctionConsumed = true;  // prevent snapshotAnchorIfNeeded re-arming this transaction
  auto it = _map.find(_anchorKey);
  if (it == _map.end()) {
    // Anchor was deleted — no correction
    return 0;
  }
  const double newPos = _horizontal ? it->second.frame.x : it->second.frame.y;
  const double oldPos = _horizontal ? _anchorX : _anchorY;
  const double correction = newPos - oldPos;
  RNCV_MVC_LOG("computeCorrection: key=%s oldY=%.1f newY=%.1f correction=%.1f consumed=true",
               _anchorKey.c_str(), oldPos, newPos, correction);
  RNCV_MVC_TRACE("computeCorrection: key=%s oldPos=%.1f newPos=%.1f correction=%.1f → correctionConsumed=YES",
                  _anchorKey.c_str(), oldPos, newPos, correction);
  _pendingCorrectionY   = correction;
  _hasPendingCorrection = true;
  return correction;
}

double LayoutCache::consumePendingCorrection() {
  std::lock_guard<std::mutex> lock(_mutex);
  if (!_hasPendingCorrection) return 0;
  const double correction = _pendingCorrectionY;
  _pendingCorrectionY   = 0;
  _hasPendingCorrection = false;
  return correction;
}

// ─── JSI conversion helpers ───────────────────────────────────────────────────

static std::string stringFromJSI(Runtime& rt, const Value& val) {
  return val.getString(rt).utf8(rt);
}

static double doubleFromObj(Runtime& rt, const Object& obj, const char* key, double def = 0.0) {
  Value v = obj.getProperty(rt, key);
  if (v.isNumber()) return v.getNumber();
  return def;
}

static bool boolFromObj(Runtime& rt, const Object& obj, const char* key, bool def = false) {
  Value v = obj.getProperty(rt, key);
  if (v.isBool()) return v.getBool();
  return def;
}

static std::string stringFromObj(Runtime& rt, const Object& obj, const char* key, const std::string& def = "") {
  Value v = obj.getProperty(rt, key);
  if (v.isString()) return v.getString(rt).utf8(rt);
  return def;
}

Rect LayoutCache::rectFromJSI(Runtime& rt, const Object& obj) {
  return {
    doubleFromObj(rt, obj, "x"),
    doubleFromObj(rt, obj, "y"),
    doubleFromObj(rt, obj, "width"),
    doubleFromObj(rt, obj, "height")
  };
}

static SizingState sizingStateFromString(const std::string& s) {
  if (s == "measured") return SizingState::Measured;
  if (s == "dirty")    return SizingState::Dirty;
  return SizingState::Placeholder;
}

static WindowTier tierFromString(const std::string& s) {
  if (s == "visible")  return WindowTier::Visible;
  if (s == "render")   return WindowTier::Render;
  if (s == "layout")   return WindowTier::Layout;
  if (s == "data")     return WindowTier::Data;
  return WindowTier::Outside;
}

static const char* sizingStateToString(SizingState s) {
  switch (s) {
    case SizingState::Measured:    return "measured";
    case SizingState::Dirty:       return "dirty";
    default:                       return "placeholder";
  }
}

static const char* tierToString(WindowTier t) {
  switch (t) {
    case WindowTier::Visible:  return "visible";
    case WindowTier::Render:   return "render";
    case WindowTier::Layout:   return "layout";
    case WindowTier::Data:     return "data";
    default:                   return "outside";
  }
}

LayoutAttributes LayoutCache::attrsFromJSI(Runtime& rt, const Object& obj) {
  LayoutAttributes a;
  a.key    = stringFromObj(rt, obj, "key");
  a.section = static_cast<int>(doubleFromObj(rt, obj, "section"));
  a.index   = static_cast<int>(doubleFromObj(rt, obj, "index", -1));

  Value frameVal = obj.getProperty(rt, "frame");
  if (frameVal.isObject()) {
    a.frame = rectFromJSI(rt, frameVal.getObject(rt));
  }

  a.zIndex          = static_cast<int>(doubleFromObj(rt, obj, "zIndex"));
  a.alpha           = doubleFromObj(rt, obj, "alpha", 1.0);
  a.isHidden        = boolFromObj(rt, obj, "isHidden");

  // transform3D: 16-element array (column-major 4x4 matrix), optional
  Value t3dVal = obj.getProperty(rt, "transform3D");
  if (t3dVal.isObject()) {
    auto t3dArr = t3dVal.getObject(rt).getArray(rt);
    size_t len = std::min(static_cast<size_t>(t3dArr.size(rt)), size_t(16));
    for (size_t i = 0; i < len; ++i) {
      a.transform3D[i] = t3dArr.getValueAtIndex(rt, i).getNumber();
    }
  }

  a.isSupplementary = boolFromObj(rt, obj, "isSupplementary");
  a.supplementaryKind = stringFromObj(rt, obj, "supplementaryKind");
  a.sizingState     = sizingStateFromString(stringFromObj(rt, obj, "sizingState", "placeholder"));
  a.isDirty         = boolFromObj(rt, obj, "isDirty");
  a.tier            = tierFromString(stringFromObj(rt, obj, "tier", "outside"));
  a.isSticky        = boolFromObj(rt, obj, "isSticky");
  a.isAnimating     = boolFromObj(rt, obj, "isAnimating");
  a.isDecoration    = boolFromObj(rt, obj, "isDecoration");
  a.decorationKind  = stringFromObj(rt, obj, "decorationKind");

  // extras: arbitrary key-value pairs
  Value extrasVal = obj.getProperty(rt, "extras");
  if (extrasVal.isObject()) {
    auto extrasObj = extrasVal.getObject(rt);
    auto names = extrasObj.getPropertyNames(rt);
    size_t count = names.size(rt);
    for (size_t i = 0; i < count; ++i) {
      auto name = names.getValueAtIndex(rt, i).getString(rt).utf8(rt);
      Value v = extrasObj.getProperty(rt, name.c_str());
      if (v.isNumber()) {
        a.extras[name] = v.getNumber();
      }
    }
  }

  return a;
}

Object LayoutCache::attrsToJSI(Runtime& rt, const LayoutAttributes& a) {
  Object obj(rt);

  obj.setProperty(rt, "key", String::createFromUtf8(rt, a.key));
  obj.setProperty(rt, "section", Value(a.section));
  obj.setProperty(rt, "index", Value(a.index));

  Object frame(rt);
  frame.setProperty(rt, "x",      Value(a.frame.x));
  frame.setProperty(rt, "y",      Value(a.frame.y));
  frame.setProperty(rt, "width",  Value(a.frame.width));
  frame.setProperty(rt, "height", Value(a.frame.height));
  obj.setProperty(rt, "frame", std::move(frame));

  obj.setProperty(rt, "zIndex",           Value(a.zIndex));
  obj.setProperty(rt, "alpha",            Value(a.alpha));
  obj.setProperty(rt, "isHidden",         Value(a.isHidden));

  // Only serialize transform3D if non-identity (avoid overhead for common case).
  if (a.transform3D != kIdentityTransform3D) {
    auto t3dArr = Array(rt, 16);
    for (size_t i = 0; i < 16; ++i) {
      t3dArr.setValueAtIndex(rt, i, Value(a.transform3D[i]));
    }
    obj.setProperty(rt, "transform3D", std::move(t3dArr));
  }

  obj.setProperty(rt, "isSupplementary",  Value(a.isSupplementary));
  obj.setProperty(rt, "supplementaryKind",
      String::createFromUtf8(rt, a.supplementaryKind));
  obj.setProperty(rt, "sizingState",
      String::createFromAscii(rt, sizingStateToString(a.sizingState)));
  obj.setProperty(rt, "isDirty",      Value(a.isDirty));
  obj.setProperty(rt, "tier",
      String::createFromAscii(rt, tierToString(a.tier)));
  obj.setProperty(rt, "isSticky",     Value(a.isSticky));
  obj.setProperty(rt, "isAnimating",  Value(a.isAnimating));
  obj.setProperty(rt, "isDecoration",  Value(a.isDecoration));
  obj.setProperty(rt, "decorationKind",
      String::createFromUtf8(rt, a.decorationKind));

  // Only serialize extras if non-empty.
  if (!a.extras.empty()) {
    Object extrasObj(rt);
    for (const auto& [k, v] : a.extras) {
      extrasObj.setProperty(rt, k.c_str(), Value(v));
    }
    obj.setProperty(rt, "extras", std::move(extrasObj));
  }

  return obj;
}

// ─── JSI bindings ─────────────────────────────────────────────────────────────

void LayoutCache::installJSIBindings(Runtime& rt, Object& target) {
  // setAttributes(attrsObject) → undefined
  target.setProperty(rt, "setAttributes",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "setAttributes"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1 || !args[0].isObject()) return Value::undefined();
        setAttributes(attrsFromJSI(rt, args[0].getObject(rt)));
        return Value::undefined();
      }));

  // getAttributes(key) → attrsObject | null
  target.setProperty(rt, "getAttributes",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "getAttributes"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1 || !args[0].isString()) return Value::null();
        auto result = getAttributes(args[0].getString(rt).utf8(rt));
        if (!result) return Value::null();
        return Value(rt, attrsToJSI(rt, *result));
      }));

  // removeAttributes(key) → undefined
  target.setProperty(rt, "removeAttributes",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "removeAttributes"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count >= 1 && args[0].isString()) {
          removeAttributes(args[0].getString(rt).utf8(rt));
        }
        return Value::undefined();
      }));

  // getAll() → attrsObject[]
  target.setProperty(rt, "getAll",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "getAll"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        auto all = getAll();
        auto arr = Array(rt, all.size());
        for (size_t i = 0; i < all.size(); ++i) {
          arr.setValueAtIndex(rt, i, attrsToJSI(rt, all[i]));
        }
        return Value(rt, arr);
      }));

  // getAttributesInRect(rect) → attrsObject[]
  target.setProperty(rt, "getAttributesInRect",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "getAttributesInRect"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1 || !args[0].isObject()) return Value(rt, Array(rt, 0));
        Rect rect = rectFromJSI(rt, args[0].getObject(rt));
        auto items = getAttributesInRect(rect);
        auto arr = Array(rt, items.size());
        for (size_t i = 0; i < items.size(); ++i) {
          arr.setValueAtIndex(rt, i, attrsToJSI(rt, items[i]));
        }
        return Value(rt, arr);
      }));

  // getTotalContentSize() → { width, height }
  target.setProperty(rt, "getTotalContentSize",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "getTotalContentSize"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        auto s = getTotalContentSize();
        Object obj(rt);
        obj.setProperty(rt, "width",  Value(s.width));
        obj.setProperty(rt, "height", Value(s.height));
        return Value(rt, obj);
      }));

  // getSectionOffsets() → number[]
  target.setProperty(rt, "getSectionOffsets",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "getSectionOffsets"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        auto offsets = getSectionOffsets();
        auto arr = Array(rt, offsets.size());
        for (size_t i = 0; i < offsets.size(); ++i) {
          arr.setValueAtIndex(rt, i, Value(offsets[i]));
        }
        return Value(rt, arr);
      }));

  // getItemHeights(section, count) → number[]
  target.setProperty(rt, "getItemHeights",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "getItemHeights"), 2,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        int section = count >= 1 ? static_cast<int>(args[0].getNumber()) : 0;
        int itemCount = count >= 2 ? static_cast<int>(args[1].getNumber()) : 0;
        auto heights = getItemHeights(section, itemCount);
        auto arr = Array(rt, heights.size());
        for (size_t i = 0; i < heights.size(); ++i) {
          arr.setValueAtIndex(rt, i, Value(heights[i]));
        }
        return Value(rt, arr);
      }));

  // getItemHeightsByKeys(keys: string[]) → number[]
  target.setProperty(rt, "getItemHeightsByKeys",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "getItemHeightsByKeys"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1 || !args[0].isObject()) return Value(rt, Array(rt, 0));
        auto keysArr = args[0].getObject(rt).asArray(rt);
        size_t len = keysArr.size(rt);
        std::vector<std::string> keys;
        keys.reserve(len);
        for (size_t i = 0; i < len; ++i) {
          keys.push_back(keysArr.getValueAtIndex(rt, i).getString(rt).utf8(rt));
        }
        auto heights = getItemHeightsByKeys(keys);
        auto arr = Array(rt, heights.size());
        for (size_t i = 0; i < heights.size(); ++i) {
          arr.setValueAtIndex(rt, i, Value(heights[i]));
        }
        return Value(rt, arr);
      }));

  // clear() → undefined
  target.setProperty(rt, "clear",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "clear"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        clear();
        return Value::undefined();
      }));

  // stashHeights() → undefined
  // Call BEFORE clear() to preserve Yoga-measured heights across fingerprint clears.
  target.setProperty(rt, "stashHeights",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "stashHeights"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        stashHeights();
        return Value::undefined();
      }));

  // clearStash() → undefined
  // Call AFTER computeSections() to release stash memory.
  target.setProperty(rt, "clearStash",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "clearStash"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        clearStash();
        return Value::undefined();
      }));

  // version() → number
  target.setProperty(rt, "version",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "version"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        return Value(static_cast<double>(version()));
      }));

  // setMVCEnabled(bool) → undefined
  target.setProperty(rt, "setMVCEnabled",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "setMVCEnabled"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count > 0) {
          setMVCEnabled(args[0].getBool());
        }
        return Value::undefined();
      }));

  // setHorizontal(bool) → undefined
  target.setProperty(rt, "setHorizontal",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "setHorizontal"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count > 0) {
          setHorizontal(args[0].isBool() ? args[0].getBool() : false);
        }
        return Value::undefined();
      }));

  // snapshotAnchor() → undefined
  target.setProperty(rt, "snapshotAnchor",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "snapshotAnchor"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        snapshotAnchor();
        return Value::undefined();
      }));

  // computeCorrection() → number
  target.setProperty(rt, "computeCorrection",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "computeCorrection"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        return Value(computeCorrection());
      }));

  // consumePendingCorrection() → number
  target.setProperty(rt, "consumePendingCorrection",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "consumePendingCorrection"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        return Value(consumePendingCorrection());
      }));
}

} // namespace rncv
