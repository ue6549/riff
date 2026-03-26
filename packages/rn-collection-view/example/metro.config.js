const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');

const root = path.resolve(__dirname, '../');

/**
 * Metro configuration for the example app.
 *
 * watchFolders includes the library root so Metro can resolve
 * 'rn-collection-view' from source during development.
 *
 * When published to npm the example is excluded — consumers use the
 * built lib/ output instead.
 */
const config = {
  watchFolders: [root],
  resolver: {
    // Force all react/react-native imports (including those from the library
    // source) to resolve to the example app's single copy.  Without this,
    // files inside packages/rn-collection-view/src/ pick up the package's own
    // node_modules/react, producing a second React instance that breaks hooks.
    extraNodeModules: {
      react:          path.resolve(__dirname, 'node_modules/react'),
      'react-native': path.resolve(__dirname, 'node_modules/react-native'),
    },
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(root, 'node_modules'),
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
