# Riff — Claude Code Instructions

## Start of every session: read these files

1. **`ethereal-seeking-willow.md`** — current working plan, recent decisions, next steps. Most up-to-date.
2. **`PLAN.md`** — full milestone plan with execution order and completion status.
3. **`docs/ARCHITECTURE.md`** — architecture overview, key decisions, RN Fabric learnings. Directionally correct but may lag behind latest code.
4. **`docs/COLLECTIONVIEW_INTERNALS.md`** — CollectionView.tsx implementation reference: section rendering pipeline, sticky mechanics, per-section insets, mutation API, codegen setup. Read when working on CollectionView or LayoutsTab.
5. **Latest file(s) in `docs/ContextExchange/`** — session handoff notes. Read the most recent one(s) for root cause analyses and status.

## Workflow

- **Always plan first.** Before any non-trivial implementation, present the plan and get explicit sign-off before writing code.
- **Ask before proceeding to next milestone.** Keep milestones small and atomic.
- **At end of session:** update `ethereal-seeking-willow.md` and write a new handoff file in `docs/ContextExchange/` with timestamp.

## Import Rules — ENFORCE STRICTLY

### `@riff/*` for library source

Use `@riff/*` for all imports of types, layouts, and pure-TS library code from `src/`:

```typescript
import { list } from '@riff/layouts/list';                    // ✅
import type { CollectionViewLayout } from '@riff/types/protocol'; // ✅
```

`@riff` maps to `packages/rn-collection-view/src/` via tsconfig `paths` and Metro `extraNodeModules`. No symlink, no package dependency.

### Native spec imports MUST use wrappers in `example/components/`

The library has its own `node_modules/react-native`. Importing specs directly from `src/specs/`
(even via `@riff/specs/...`) runs `codegenNativeComponent`/`TurboModuleRegistry` against the
library's react-native instance — components register in the wrong registry, silent failure.

Wrappers in `example/components/` re-declare the spec so resolution happens from the correct instance:

```
example/components/NativeCollectionViewModule.ts
example/components/RNMeasuredCellNativeComponent.ts
example/components/RNScrollCoordinatedViewNativeComponent.ts
example/components/RNCollectionViewContainerNativeComponent.ts
```

**NEVER write these in example/ code:**
```typescript
import NativeCollectionViewModule from '@riff/specs/NativeCollectionViewModule';     // ❌
import RNMeasuredCell from '../../src/specs/RNMeasuredCellNativeComponent';           // ❌
```

**Always write:**
```typescript
import NativeCollectionViewModule from '../components/NativeCollectionViewModule';    // ✅
import RNMeasuredCell from './RNMeasuredCellNativeComponent';                         // ✅
```

### When adding a new native spec

Create the spec in `src/specs/` AND a wrapper in `example/components/` in the same change.
Copy the pattern from `example/components/RNCollectionViewContainerNativeComponent.ts`.

## After any native change

1. If new `.cpp` file: `pod install` — CMake only picks up new files on pod install
2. Clean build in Xcode (`Cmd+Shift+K`)
3. Reset Metro cache if behavior is unexpected: `--port 8082 --reset-cache`

Metro MUST run on port 8082. The Xcode scheme sets `RCT_METRO_PORT=8082`. Default port 8081 is used by other apps on this machine and will cause them to hijack the bundle.

## Debug logging

All logging is silenced in normal operation. To enable:
- JS: set `RNCV_DEBUG_LOGS = true` / `RNCV_LAYOUT_DEBUG_LOGS = true` in `CollectionView.tsx`
- Native: set `RNCV_ENABLE_NATIVE_LOGS = 1` / `RNCV_ENABLE_STICKY_TRACE = 1`
- Re-silence after verification.

## Project memory

Session-persistent memory is in `/Users/rajatgupta/.claude/projects/-Users-rajatgupta-Dev-rn-new-arch-pocs-collection-view/memory/`. Check `MEMORY.md` there for cross-session context.
