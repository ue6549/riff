# Riff — Claude Code Instructions

## Start of every session: read these files

1. **`ethereal-seeking-willow.md`** — current working plan, recent decisions, next steps. Most up-to-date.
2. **`PLAN.md`** — full milestone plan with execution order and completion status.
3. **`docs/ARCHITECTURE.md`** — architecture overview, key decisions, RN Fabric learnings. Directionally correct but may lag behind latest code.
4. **`docs/COLLECTIONVIEW_INTERNALS.md`** — CollectionView.tsx implementation reference: section rendering pipeline, sticky mechanics, per-section insets, mutation API, codegen setup, two-layer identity design (cacheKey + Fabric tag). **Read before modifying any layout engine, decoration rendering, or native position application.**
5. **Latest file(s) in `docs/ContextExchange/`** — session handoff notes. Read the most recent one(s) for root cause analyses and status.

## Workflow

- **Always start from `main`.** At the start of every session, check out `main` and pull latest before doing anything.
- **Always use a feature branch.** Create a new branch from `main` for every change (`git checkout -b <branch-name>`). Never commit directly to `main`.
- **Merge back to `main` when done.** Once a change is complete and verified, merge the feature branch back to `main` and push. Delete the feature branch after merge.
- **Always plan first.** Before any non-trivial implementation, present the plan and get explicit sign-off before writing code.
- **Ask before proceeding to next milestone.** Keep milestones small and atomic.
- **At end of session:** update `ethereal-seeking-willow.md` and write a new handoff file in `docs/ContextExchange/` with timestamp.

## Import Rules — ENFORCE STRICTLY

### `@riff/*` for all library source

Use `@riff/*` for all imports from `src/` — components, types, layouts, specs:

```typescript
import { Riff } from '@riff/components/CollectionView';           // ✅
import { list } from '@riff/layouts/list';                        // ✅
import type { RiffLayout } from '@riff/types/protocol';           // ✅
import NativeCollectionViewModule from '@riff/specs/NativeCollectionViewModule'; // ✅
```

`@riff` maps to `packages/rn-collection-view/src/` via tsconfig `paths` and Metro `resolveRequest`.

**No wrappers.** The old `example/components/RNMeasuredCellNativeComponent.ts` etc. were
dual-React-instance workarounds. Yarn workspace hoisting (single copy of react-native) eliminated
the need. Import specs directly from `@riff/specs/`.

### When adding a new native spec

Create the spec in `src/specs/` only. No wrapper needed.
Copy the pattern from `src/specs/RNCollectionViewContainerNativeComponent.ts`.

## After any native change

1. If new `.cpp` file: `pod install` — CMake only picks up new files on pod install
2. Clean build in Xcode (`Cmd+Shift+K`)
3. Reset Metro cache if behavior is unexpected: `--port 8082 --reset-cache`

Metro MUST run on port 8082. The Xcode scheme sets `RCT_METRO_PORT=8082`. Default port 8081 is used by other apps on this machine and will cause them to hijack the bundle.

## Debug logging

All logging is silenced in normal operation. To enable:
- JS: set `RNCV_DEBUG_LOGS = true` / `RNCV_LAYOUT_DEBUG_LOGS = true` in `src/components/CollectionView.tsx`
- Native: set `RNCV_ENABLE_NATIVE_LOGS = 1` / `RNCV_ENABLE_STICKY_TRACE = 1`
- Re-silence after verification.

## Project memory

Session-persistent memory is in `/Users/rajatgupta/.claude/projects/-Users-rajatgupta-Dev-rn-new-arch-pocs-collection-view/memory/`. Check `MEMORY.md` there for cross-session context.
