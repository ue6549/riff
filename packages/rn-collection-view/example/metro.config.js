const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');

const libraryRoot = path.resolve(__dirname, '../');

/**
 * Metro configuration for the example app.
 *
 * watchFolders: includes the library root so Metro sees changes to src/ files
 * imported via the @riff/* alias.
 *
 * extraNodeModules:
 *   react / react-native — forced to example's single copy so that library
 *   source files (reached via @riff/*) never pick up the library's own
 *   node_modules/react-native and cause a dual-registry instance.
 *   @riff — maps the path alias to the library's src/ directory. Mirrors the
 *   tsconfig paths entry so Metro and TypeScript agree on resolution.
 */
const config = {
  watchFolders: [libraryRoot],
  resolver: {
    extraNodeModules: {
      react:          path.resolve(__dirname, 'node_modules/react'),
      'react-native': path.resolve(__dirname, 'node_modules/react-native'),
    },
    resolveRequest: (context, moduleName, platform) => {
      if (moduleName.startsWith('@riff/')) {
        // Map @riff/<subpath> → <libraryRoot>/src/<subpath>
        // Metro applies its normal extension + index resolution from there.
        const subpath = moduleName.slice('@riff/'.length);
        return context.resolveRequest(
          context,
          path.resolve(libraryRoot, 'src', subpath),
          platform,
        );
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
