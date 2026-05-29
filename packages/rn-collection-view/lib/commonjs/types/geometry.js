"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.ZERO_SIZE = exports.ZERO_RECT = exports.ZERO_POINT = exports.ZERO_INSETS = void 0;
exports.rectContainsPoint = rectContainsPoint;
exports.rectInsetBy = rectInsetBy;
exports.rectOffset = rectOffset;
exports.rectUnion = rectUnion;
exports.rectsIntersect = rectsIntersect;
/**
 * Core geometry primitives.
 * Matches UIKit/CoreGraphics conventions (origin top-left, y increases downward).
 */

// Helpers — pure functions, no mutation

function rectContainsPoint(rect, point) {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}
function rectsIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
function rectUnion(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return {
    x,
    y,
    width: maxX - x,
    height: maxY - y
  };
}
function rectInsetBy(rect, insets) {
  return {
    x: rect.x + insets.left,
    y: rect.y + insets.top,
    width: rect.width - insets.left - insets.right,
    height: rect.height - insets.top - insets.bottom
  };
}
function rectOffset(rect, dx, dy) {
  return {
    ...rect,
    x: rect.x + dx,
    y: rect.y + dy
  };
}
const ZERO_POINT = exports.ZERO_POINT = {
  x: 0,
  y: 0
};
const ZERO_SIZE = exports.ZERO_SIZE = {
  width: 0,
  height: 0
};
const ZERO_RECT = exports.ZERO_RECT = {
  x: 0,
  y: 0,
  width: 0,
  height: 0
};
const ZERO_INSETS = exports.ZERO_INSETS = {
  top: 0,
  bottom: 0,
  left: 0,
  right: 0
};
//# sourceMappingURL=geometry.js.map