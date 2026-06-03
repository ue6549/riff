# Riff — High-Performance Collection View for React Native New Architecture

POC and active development workspace. iOS-first. RN 0.83.4 (React 19.2), Fabric + JSI.

---

## Key Documents

Read these before making changes. Order matters.

| Document | Purpose | Currency |
|---|---|---|
| [`PLAN.md`](./PLAN.md) | Full milestone plan — what's done, what's next, execution order | Updated each session |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Architecture, key decisions, RN Fabric learnings | Directionally correct; may lag behind latest code |
| [`ethereal-seeking-willow.md`](./ethereal-seeking-willow.md) | Current working plan — recent decisions, next steps, active phase | Most up-to-date |
| [`docs/ContextExchange/`](./docs/ContextExchange/) | Session handoff notes — root cause analyses, fixes, status at end of each session | Read the latest file(s) for recent history |
| [`REQUIREMENTS.md`](./REQUIREMENTS.md) | Product requirements and acceptance criteria | Stable |

> **ARCHITECTURE.md caveat:** It captures the general direction and approach and is a good orientation
> document, but it may not reflect the most recent implementation details. For current state, read
> `ethereal-seeking-willow.md` and the latest `docs/ContextExchange/` file.

---

## Project Structure

```
collection-view/
  packages/
    rn-collection-view/          ← library root
      src/                       ← library source: types, specs, layouts, LayoutCache
        specs/                   ← TurboModule + NativeComponent specs (codegen input)
        layouts/                 ← layout factory functions (list, grid, masonry, flow)
        types/                   ← TypeScript types and protocol interfaces
      cpp/                       ← C++ JSI module: LayoutCache, ListLayout, WindowController, ShadowNode
      ios/                       ← iOS native views: RNCollectionViewContainerView, sticky views
      example/                   ← RN example app (the development environment)
        components/              ← CollectionView.tsx + native spec re-export wrappers (see below)
        screens/                 ← demo and comparison screens
        tests/                   ← milestone test screens
        ios/                     ← Xcode project (app shell + Podfile)
  docs/
    ARCHITECTURE.md              ← architecture reference
    ContextExchange/             ← session handoff notes
    native-sanity-checklist.md   ← pre-build checklist for native changes
```

---

## Setup

```bash
# 1. Install dependencies
cd packages/rn-collection-view/example
nvm use          # requires Node 20 (see .nvmrc)
yarn install

# 2. Install pods (iOS)
yarn pods        # cd ios && bundle exec pod install

# 3. Start Metro — MUST use port 8082
# The Xcode scheme sets RCT_METRO_PORT=8082. Port 8081 (default) is used by
# other apps on this machine and will cause them to load this bundle instead.
nvm use && npx react-native start --port 8082

# 4. Build in Xcode
# Open: packages/rn-collection-view/example/ios/CollectionViewExample.xcworkspace
```

### When to run pod install

- Any time a new `.cpp` file is added to `cpp/`
- Any time `RNCollectionView.podspec` changes
- Any time native iOS files are added to `ios/`

---

## Import Rules for Example App Code

### `@riff/*` — library source alias

The `@riff/*` path alias maps to `packages/rn-collection-view/src/`. Use it for all
imports of types, layouts, and other pure-TypeScript library code:

```typescript
import { list } from '@riff/layouts/list';
import type { CollectionViewLayout } from '@riff/types/protocol';
import type { LayoutAttributes } from '@riff/types';
```

This is configured in `tsconfig.json` (`paths`) and `metro.config.js` (`extraNodeModules`).
No symlink or package dependency needed — `@riff` resolves directly to `../src/` on disk.

### Native spec imports — always use wrappers in `example/components/`

The library has its own `node_modules/react-native`. If native spec files are imported
directly from `src/specs/`, the `codegenNativeComponent` / `TurboModuleRegistry` calls
inside them resolve to the library's `react-native` instance — a different registry than
the app's. Components register silently in the wrong place and fail with:

```
"View config getter callback must be a function (received undefined)"
```

Re-export wrappers in `example/components/` re-declare the spec so that `react-native`
resolves from the correct location (the example app's `node_modules/`):

```
example/components/
  NativeCollectionViewModule.ts           ← TurboModule
  RNMeasuredCellNativeComponent.ts        ← Fabric component
  RNScrollCoordinatedViewNativeComponent.ts
  RNCollectionViewContainerNativeComponent.ts
```

```typescript
// ✅ Correct — from example/components/
import NativeCollectionViewModule from './NativeCollectionViewModule';

// ✅ Correct — from example/tests/ or example/screens/
import NativeCollectionViewModule from '../components/NativeCollectionViewModule';

// ❌ Never — bypasses wrapper, wrong registry
import NativeCollectionViewModule from '@riff/specs/NativeCollectionViewModule';
import RNMeasuredCell from '../../src/specs/RNMeasuredCellNativeComponent';
```

**When adding a new native spec:** create the spec in `src/specs/` AND a wrapper in
`example/components/`. Copy the pattern from an existing wrapper.

---

## Debugging Checklist

When something mysteriously breaks after adding native code:

1. **New `.cpp` file?** Run `pod install` — CMake picks up new files only on pod install
2. **Codegen stale?** Clean build in Xcode (`Cmd+Shift+K`), then rebuild
3. **Metro cache?** `npx react-native start --reset-cache`
4. **Spec import wrong?** Check the import rules above — wrong registry is a silent failure
5. **Check native logs:** See `docs/native-sanity-checklist.md`

Toggle debug logging (all silenced in normal operation):

```typescript
// JS side (CollectionView.tsx)
RNCV_DEBUG_LOGS = true
RNCV_LAYOUT_DEBUG_LOGS = true

// Native side (build flags)
RNCV_ENABLE_NATIVE_LOGS = 1
RNCV_ENABLE_STICKY_TRACE = 1
kRNCVEnableSignposts = YES
```

---

## Development Workflow

1. Read `ethereal-seeking-willow.md` for what's active
2. Read the latest file in `docs/ContextExchange/` for recent decisions
3. Plan before coding — present approach, get sign-off, then implement
4. After any native change: pod install → clean build → test
5. At end of session: update `ethereal-seeking-willow.md` and write a new `docs/ContextExchange/` handoff file
