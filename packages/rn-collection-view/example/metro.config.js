const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');

const libraryRoot = path.resolve(__dirname, '../');
const exampleOrigin = path.resolve(__dirname, 'index.js');

const config = {
  watchFolders: [libraryRoot],
  transformer: {
    babelTransformerPath: path.resolve(__dirname, 'metro-transformer.js'),
  },
  resolver: {
    unstable_enableSymlinks: true,
    resolveRequest: (context, moduleName, platform) => {
      // ── Deduplicate react-native across the monorepo ──────────────────
      // Files in libraryRoot/src/ resolve node_modules from libraryRoot/,
      // while example files resolve from example/. This creates two copies
      // of every react-native internal module. Fix: when a library source
      // file imports react-native or @react-native, change the resolution
      // origin to the example dir so it finds the same copy as the example.
      // Redirect from ANYWHERE in libraryRoot/ EXCEPT example/node_modules/.
      // This covers both libraryRoot/src/ and libraryRoot/node_modules/ — the
      // latter is crucial because libraryRoot/node_modules/react-native/'s own
      // transitive imports also need to resolve to the example's single copy.
      const exampleNM = path.resolve(__dirname, 'node_modules') + path.sep;
      const isFromLibrarySource =
        context.originModulePath.startsWith(libraryRoot + path.sep) &&
        !context.originModulePath.startsWith(exampleNM);
      const isRNPackage =
        moduleName === 'react-native' ||
        moduleName === 'react' ||
        moduleName.startsWith('react-native/') ||
        moduleName.startsWith('@react-native/') ||
        moduleName === 'react/jsx-runtime' ||
        moduleName === 'react/jsx-dev-runtime';

      if (isFromLibrarySource && isRNPackage) {
        return context.resolveRequest(
          { ...context, originModulePath: exampleOrigin },
          moduleName,
          platform,
        );
      }

      // ── @riff/* alias ─────────────────────────────────────────────────
      if (moduleName.startsWith('@riff/')) {
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
