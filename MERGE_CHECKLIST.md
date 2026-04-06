# PR Merge Checklist

## Step 1: Merge new PRs into target branches

| New PR | Target | Contains |
|--------|--------|----------|
| #16 | → #11 (`fix/p0-1-canvas-memory-leak`) | SpriteLoader memory leak + CodeRabbit defensive fix |
| #17 | → #14 (`fix/p0-2-debounce-obstacle-rebuild`) | Deferred obstacle rebuild |
| #18 | → #13 (`fix/p0-3-state-race-condition`) | Snapshot + atomic update + `mapToAgentStates` pure + TS18047 fix |
| #19 | → #9 (`fix/character-customizer-null-check`) | TS18047 fix + removed aliases |
| #20 | → #15 (`fix/p0-4-prune-read-offsets`) | Prune offsets + snapshot + pure `mapToAgentStates` + aliases |

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

- New PRs (16-20) add review fixes on top of original PRs
- After merging #16→#11, PR #11 includes the memory leak fix + defensive null checks
- After merging #18→#13, PR #13 includes the snapshot fix + CodeRabbit `mapToAgentStates` pure fix
- Merging order within each step doesn't matter
