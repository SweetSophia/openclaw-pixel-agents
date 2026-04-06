# PR Merge Checklist

## Step 1a: Merge follow-up fix PRs into their targets

| Fix PR | Target | Contains |
|--------|--------|----------|
| **#21** | → `main` | `useLayoutStore` DELETE response.ok + CharacterCustomizer TS18047 fix |
| **#22** | → PR #17 (`fix/p0-2-debounce-obstacle-rebuild`) | `previewCtx.imageSmoothingEnabled` + `useLayoutStore` response.ok |
| **#23** | → PR #19 (`fix/character-customizer-null-check`) | `previewCtx.imageSmoothingEnabled` consistency |

## Step 1b: Merge new PRs into target branches

| New PR | Target | Contains |
|--------|--------|----------|
| #16 | → PR #11 (`fix/p0-1-canvas-memory-leak`) | SpriteLoader memory leak + CodeRabbit defensive fix |
| #17 | → PR #14 (`fix/p0-2-debounce-obstacle-rebuild`) | Deferred obstacle rebuild |
| #18 | → PR #13 (`fix/p0-3-state-race-condition`) | Snapshot + atomic update + `mapToAgentStates` pure + TS18047 fix |
| #19 | → PR #9 (`fix/character-customizer-null-check`) | TS18047 fix + aliases |
| #20 | → PR #15 (`fix/p0-4-prune-read-offsets`) | Prune offsets + snapshot + pure `mapToAgentStates` + aliases |

## Step 2: Merge original PRs into main

| PR | Title |
|----|-------|
| #9 | CharacterCustomizer TS18047 fix |
| #11 | Canvas memory leak |
| #13 | Race condition fix |
| #14 | Deferred obstacle rebuild |
| #15 | Prune read offsets |

## Rejected PRs

- **#12** — Broken: deletes all server imports/config. Do NOT merge.

## Notes

- Step 1a fix PRs (21-23) should be merged first so their fixes are included when Step 1b PRs are reviewed
- New PRs (16-20) add review fixes on top of original PRs
- PR #18 already has `mapToAgentStates` pure fix (CodeRabbit comment is stale)
- PR #20 already removed aliases (CodeRabbit comment is stale)
