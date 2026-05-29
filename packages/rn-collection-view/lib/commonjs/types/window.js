"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.DEFAULT_WINDOW_CONFIG = void 0;
/**
 * Window configuration — the full public API for tuning the C++ window controller.
 *
 * Matches §11.5 in REQUIREMENTS.md.
 * "Logic native, configuration JS" — all values here are passed to C++ at runtime
 * via the configure(config) JSI method. Nothing is hardcoded in C++.
 */

/** Default window config — mirrors C++ defaults, confirmed to be safe on mid-range devices. */
const DEFAULT_WINDOW_CONFIG = exports.DEFAULT_WINDOW_CONFIG = {
  renderMultiplier: 3,
  trailingMultiplier: 1,
  layoutMultiplier: 8,
  dataMultiplier: 12,
  velocityScaleFactor: 0.5,
  maxWindowMultiplier: 8,
  mountedCellBudget: 40,
  supplementaryBudget: 20,
  memoryPressure: {
    low: {
      renderMultiplier: 2,
      mountedCellBudget: 30
    },
    moderate: {
      renderMultiplier: 1.5,
      mountedCellBudget: 20
    },
    critical: {
      renderMultiplier: 1,
      mountedCellBudget: 10
    },
    backgrounded: {
      renderMultiplier: 0.5,
      mountedCellBudget: 5
    }
  },
  correctionMinDelta: 1
};
//# sourceMappingURL=window.js.map