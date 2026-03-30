# Native Sanity Checklist (Riff Example)

Run this after any change to:
- `cpp/*`
- `ios/*`
- `src/specs/*`
- `example/components/*NativeComponent.ts`

## 1) Verify local package link

From `packages/rn-collection-view/example`:

```sh
yarn check:riff-link
```

Expected:

```sh
[riff-link-check] OK: node_modules/riff -> /Users/red/Development/riff/packages/rn-collection-view
```

Also verify the linked native source contains latest debug fields:

```sh
grep -E "component=%s|propCacheKey|finalKey" "node_modules/riff/cpp/CollectionViewContainerShadowNode.cpp"
```

Expected: at least one `RNCV_SN_LOG` line including `component=`, `propCacheKey`, and `finalKey`.

## 2) Refresh iOS pods and codegen

From `packages/rn-collection-view/example`:

```sh
yarn pods
```

Expected in output:
- `Found riff`
- `Processing RNCollectionViewSpec`
- `Generating Native Code for RNCollectionViewSpec`
- `Pod installation complete!`

## 3) Clean and run from Xcode

- Open `packages/rn-collection-view/example/ios/CollectionViewExample.xcworkspace`
- `Product > Clean Build Folder`
- Run (`Cmd+R`)

## 4) Start Metro with clean cache

From `packages/rn-collection-view/example`:

```sh
yarn start --reset-cache
```

## 5) Runtime log sanity gates

### JS console (Metro)

Must include:
- `RNCV-JS-FLAT` with `cacheKey":"item-0-header"`
- `RNCV-JS-CELL` with `index":0` and `cacheKey":"item-0-header"`
- `RNCV-JS-CELL` with `branch":"RNScrollCoordinatedView"` for header

### Xcode console

Must include at least one line like:

```txt
[RNCV-SN]   child[...] component=... type=... kind=... propCacheKey=... fallbackKey=... finalKey=...
```

If you only see old lines like:

```txt
[RNCV-SN]   child[0] key=item-0-0 cache=(...) yoga=(...)
```

then native build is stale. Stop and rerun steps 1-3.

## 6) Quick repro capture format

Collect and share:
- First 30 `RNCV-JS-CELL` lines for `index:0`
- First 30 `RNCV-SN` lines after opening the sticky screen
- Any `WARNING` lines

## 7) One-command recovery if drift is suspected

From `packages/rn-collection-view/example`:

```sh
yarn sync:riff
yarn pods
```

Then Xcode clean + run.
