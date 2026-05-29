const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');

const libraryRoot = path.resolve(__dirname, '../');

/**
 * Metro configuration for the example app.
 *
 * watchFolders: includes the library root so Metro sees changes to src/ files
 * imported via the @riff/* alias. Required because the example is a workspace
 * member inside the library root — Metro only watches the example directory by
 * default, but library source files live one level up.
 *
 * resolveRequest: maps @riff/<subpath> → <libraryRoot>/src/<subpath> so Metro
 * and TypeScript agree on module resolution. No react/react-native override
 * needed — Yarn workspace hoisting ensures a single copy of both.
 */
const config = {
  watchFolders: [libraryRoot],
  resolver: {
    resolveRequest: (context, moduleName, platform) => {
      if (moduleName.startsWith('@riff/')) {
        // Map @riff/<subpath> → <libraryRoot>/src/<subpath>
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
