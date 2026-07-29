# OpenClaw Pixel Agents — Agent Notes

## Runtime and Commands

- Use Node.js 22.12+ and `npm ci`; the floor is declared in `package.json#engines` and enforced via `.npmrc` (`engine-strict=true`). This is one package, not a workspace/monorepo.
- `npm run dev` starts Vite on `:3000` and the Express/Socket.IO server on `:3001`; Vite proxies `/api` and `/socket.io` with `changeOrigin: true`.

```bash
npm run dev                              # client + server
npm run dev:client                       # Vite only
npm run dev:server                       # tsx watch server/index.ts
npm test -- src/game/Schedule.test.ts    # one test file
npm run test:watch                       # interactive Vitest
npm run build                            # dist/client + compiled server
npm test                                 # all tests once
npm run test:coverage                    # V8 coverage
npm run typecheck                        # client tsc --noEmit
npm start                                # production build; build first
```

- Vitest runs in jsdom, loads `src/test/setup.ts`, and excludes `dist/**` plus `.worktrees/**`.
- CI runs CodeQL, Socket, Sourcery, dependency review, build, test, and typecheck on every push via `.github/workflows/`. Browser-level geometry and hit-testing are not yet covered there; for those, follow the manual browser-testing steps in `CONTRIBUTING.md` (run `npm run dev` and verify in the browser).
- `npm start` sets `NODE_ENV=production` and runs the non-obvious path `dist/server/server/index.js`.

## Real Boundaries

- `server/index.ts` wires Express, Socket.IO, polling, ingest, persistence, and routes; keep reusable policy in `server/{validation,cors,correlation,errors,logger,layouts,agentSnapshots}.ts` instead of growing the entrypoint.
- `shared/types.ts` is the network contract. `@shared` maps to `shared/` in Vite; server code uses relative imports.
- `src/components/PixelOffice.tsx` is the React↔canvas adapter. `GameEngine` owns rendering and side effects; `EditorController`, `Schedule`, `SubAgentFSM`, `inputGeometry`, and `Pathfinder` hold extracted behavior.
- `collector/push-pixel-agents.mjs` runs on the OpenClaw host and pushes into the ingest API; it is not part of the dashboard server process.

## Server Invariants

- Treat persisted JSON and mutating request bodies as untrusted. Route them through `server/validation.ts`; its allowlists, bounds, reserved-key rejection, and layout validation are security boundaries.
- Every agent preference mutation must update both `AGENT_REGISTRY` and `agentStates` before persistence/broadcast. Toggle, sprite, recipe, and tag routes follow this rule.
- `applyAgentSnapshot()` preserves the last non-empty snapshot on CLI execution/JSON errors, but a successful empty session list replaces it. Keep `AgentState` deeply cloneable.
- `isPolling` prevents overlapping poll cycles. Transcript offsets advance only through complete newline-terminated JSONL records; partial EOF records must be reread next cycle.
- Production startup requires a comma-separated `CORS_ORIGIN`. Reverse proxies must preserve the browser `Origin` header or mutating REST requests and Socket.IO upgrades are rejected.
- Ingest auth hashes both configured and supplied bearer tokens to fixed-size SHA-256 digests before `timingSafeEqual`. Timing regression tests must compare equal-length tokens; use separate functional assertions for length sweeps.
- Keep the actual WebSocket scheme-sources in the CSP string, but do not spell the standalone scheme token in TypeScript comments: Sourcery's opengrep rule false-positively flags it.

## Persistence and Layouts

- `DATA_DIR` defaults to `join(__dirname, "data")`, so dev writes under `server/data/` and standalone compiled startup writes under `dist/server/server/data/`; do not assume repo-root `data/`. Docker sets `DATA_DIR=/app/data`.
- Use `OPENCLAW_BIN` for the CLI path. The `OPENCLAW_CLI` name still shown in README is stale.
- Layout IDs must pass `/^[a-zA-Z0-9_-]+$/`, max 64 chars; `default` cannot be deleted.
- Layout writes use optimistic concurrency via `baseUpdatedAt`. The client refreshes revisions and retries `409`/server failures with bounded backoff; do not replace newer local edits with stale save responses.
- Programmatic load/create/save-response changes must go through `setActiveLayoutProgrammatic()` so `skipAutoSaveRef` suppresses stale auto-saves. Saves are serialized through `savePromiseRef`; dirty furniture changes debounce for 2 seconds.
- `PixelOffice` re-syncs `GameEngine` through serialized `furnitureKey` and `seatsKey` dependencies. If the engine starts reading another `PlacedFurniture` field, include it in `furnitureKey`.
- Furniture discovery is not fully automatic: add assets and `manifest.json` under `public/assets/furniture/<TYPE>/`, then add the type to the static `/api/furniture-catalog` list in `server/index.ts`.

## Game and Client Invariants

- Adapter characterization in `src/game/GameEngine.integration.test.ts` must execute the real `EditorController`, `SubAgentFSM`, `Schedule`, and `inputGeometry` paths. Mock browser boundaries only; do not add production-only test seams.
- `EditorController` owns canvas mouse/touch listeners. Rotation callbacks carry the exact post-rotation angle so React does not double-increment the shared furniture object.
- Keep both `GameEngine.screenToGrid` overloads; `EditorController` uses the numeric form and `inputGeometry.ts` owns letterbox/pillarbox edge semantics.
- `stateJustChanged` is consumed once in `GameEngine.update()` for sound/VFX and then reset; add transition effects before that reset.
- Typing, reading, running-command, and thinking agents route to assigned seats. Animation rendering groups running-command with typing and thinking with reading.
- Demo agents are client-side development data only: `PixelOffice` passes `import.meta.env.DEV` to `GameEngine.init`. Production may intentionally render an empty office until real agents arrive.
- Missing furniture sprites use a 2×1 obstacle footprint. Preserve this conservative pathfinding fallback.
- Use `newEntityId()` from `src/util/id.ts` instead of calling `crypto.randomUUID()` directly; non-secure contexts require its `getRandomValues`/`Math.random` fallbacks.
- `CharacterRecipe` intentionally exists in both `shared/types.ts` and `CharacterComposer.ts`; keep their index ranges synchronized.

## Asset Contracts

- Legacy character sheets are 112×96: seven 16×32 frames across three rows (`down`, `up`, `right`); left is generated by flipping right. Frames 0–2 walk, 3–4 type, and 5–6 read.
- `CharacterComposer.ts` reads the combined MetroCity body/hair/outfit sheets under `public/assets/source/MetroCity/` and emits the same 3×7 layout. Preserve fallback to pre-composited `char_0..5.png` when source sheets fail.
