#pragma once

namespace rncv {

// ─── Geometry primitives ──────────────────────────────────────────────────────

struct Point  { double x = 0; double y = 0; };
struct Size   { double width = 0; double height = 0; };
struct Rect   { double x = 0; double y = 0; double width = 0; double height = 0; };
struct Insets { double top = 0; double bottom = 0; double left = 0; double right = 0; };

inline bool rectsIntersect(const Rect& a, const Rect& b) {
  // Inclusive boundary: items whose edges exactly touch the query rect are included.
  // Strict comparison excluded items at scroll boundaries, causing missing cells.
  return a.x <= b.x + b.width  && a.x + a.width  >= b.x
      && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

} // namespace rncv
