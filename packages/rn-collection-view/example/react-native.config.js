const path = require('path');

/**
 * Explicitly declare the RNCollectionView library so that:
 *  1. use_native_modules! (Podfile) picks it up and installs the pod
 *  2. The RN codegen runner finds its codegenConfig and generates
 *     RNCollectionViewSpec headers (ComponentDescriptors.h, etc.)
 *
 * This replaces the old "riff": "link:../" yarn symlink approach.
 * The library is NOT in node_modules — it lives at ../../ relative to here.
 */
module.exports = {
  dependencies: {
    riff: {
      root: path.resolve(__dirname, '../'),
    },
  },
};
