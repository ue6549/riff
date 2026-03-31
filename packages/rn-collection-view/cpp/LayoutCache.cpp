#include "LayoutCache.h"

#include <algorithm>
#include <limits>
#include <stdexcept>

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
  _map.clear();
  _insertionOrder.clear();
  _index.clear();
  ++_version;
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
    if (attrs.isSupplementary) continue;
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

void LayoutCache::setScrollOffset(double x, double y) {
  std::lock_guard<std::mutex> lock(_mutex);
  _scrollOffset = {x, y};
}

Point LayoutCache::getScrollOffset() const {
  std::lock_guard<std::mutex> lock(_mutex);
  return _scrollOffset;
}

// ─── MVC correction ──────────────────────────────────────────────────────────

void LayoutCache::snapshotAnchor() {
  std::lock_guard<std::mutex> lock(_mutex);
  const double scrollY = _scrollOffset.y;
  // Find item with smallest Y that starts at or below scrollY.
  // If none, fall back to item whose bottom exceeds scrollY (partially visible).
  std::string bestKey;
  double bestY = std::numeric_limits<double>::max();
  bool found = false;
  for (const auto& [key, attrs] : _map) {
    const double y = attrs.frame.y;
    if (y >= scrollY && y < bestY) {
      bestKey = key; bestY = y; found = true;
    }
  }
  if (!found) {
    // Fallback: topmost item partially visible (bottom > scrollY)
    for (const auto& [key, attrs] : _map) {
      const double y = attrs.frame.y;
      const double bottom = y + attrs.frame.height;
      if (bottom > scrollY && y < bestY) {
        bestKey = key; bestY = y; found = true;
      }
    }
  }
  if (found) {
    _anchorKey = std::move(bestKey);
    _anchorY   = bestY;
    _hasAnchor = true;
  } else {
    _hasAnchor = false;
  }
}

double LayoutCache::computeCorrection() {
  std::lock_guard<std::mutex> lock(_mutex);
  if (!_hasAnchor) return 0;
  _hasAnchor = false; // one-shot
  auto it = _map.find(_anchorKey);
  if (it == _map.end()) {
    // Anchor was deleted — no correction
    return 0;
  }
  const double correction = it->second.frame.y - _anchorY;
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

  // clear() → undefined
  target.setProperty(rt, "clear",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "clear"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        clear();
        return Value::undefined();
      }));

  // version() → number
  target.setProperty(rt, "version",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "version"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        return Value(static_cast<double>(version()));
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
