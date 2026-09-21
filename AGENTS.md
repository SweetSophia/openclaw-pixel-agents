# OpenClaw Pixel Agents — Agent Notes

## Runtime and Commands

- Use a Node.js version satisfying `^22.22.2 || ^24.15.0 || >=26.0.0` and run `npm ci`; the range is declared in `package.json#engines` and enforced via `.npmrc` (`engine-strict=true`). This is one package, not a workspace/monorepo.
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
npm run typecheck                        # `tsc --noEmit` (browser) && `tsc --noEmit -p tsconfig.test.json` (test config adds Node + DOM types)
npm start                                # production build; build first
```

- Vitest runs in jsdom, loads `src/test/setup.ts`, and excludes `dist/**` plus `.worktrees/**`. Coverage floors (repository-wide, all four evaluated together): branches 36, functions 37, lines 41, statements 39.
- CI: `codeql.yml` scans JS/TS on every push/PR plus weekly on `main`; `ci.yml` runs typecheck → test → test:coverage → build → `npm audit --omit=dev --audit-level=high` (gate) + `npm audit --audit-level=moderate` (full-tree moderate-or-higher advisory blocker, issue #168); `dependency-review-action` runs on PRs only and fails on high/critical additions. Browser-level geometry and hit-testing are not covered in CI; follow the manual browser-testing steps in `CONTRIBUTING.md` (run `npm run dev` and verify in the browser).
- `npm start` sets `NODE_ENV=production` and runs the non-obvious path `dist/server/server/index.js`.

## Real Boundaries

- `server/index.ts` wires Express, Socket.IO, polling, ingest, persistence, and routes; keep reusable policy in `server/{validation,cors,correlation,errors,logger,layouts,agentSnapshots,ingestSessions}.ts` instead of growing the entrypoint. Rate limiters (`ingestPreAuthRateLimiter`, `apiMutationGuard`, `publicGetRateLimiter`) currently live inline in `index.ts` — move to a dedicated module once they grow beyond their single-page definitions.
- `shared/types.ts` is the network contract. `@shared` maps to `shared/` in Vite; server code uses relative imports.
- `src/components/PixelOffice.tsx` is the React↔canvas adapter. `GameEngine` owns rendering and side effects; `EditorController`, `Schedule`, `SubAgentFSM`, `inputGeometry`, and `Pathfinder` hold extracted behavior.
- `collector/push-pixel-agents.mjs` runs on the OpenClaw host and pushes into the ingest API; it is not part of the dashboard server process.

## Server Invariants

- Treat persisted JSON and mutating request bodies as untrusted. Route them through `server/validation.ts`; its allowlists, bounds, reserved-key rejection, and layout validation are security boundaries.
- Every agent preference mutation must update both `AGENT_REGISTRY` and `agentStates` before persistence/broadcast. Toggle, sprite, recipe, and tag routes follow this rule.
- `applyAgentSnapshot()` preserves the last non-empty snapshot on CLI execution/JSON errors, but a successful empty session list replaces it. Keep `AgentState` deeply cloneable.
- `isPolling` prevents overlapping poll cycles. Transcript offsets advance only through complete newline-terminated JSONL records; partial EOF records must be reread next cycle.
- Production startup requires a comma-separated `CORS_ORIGIN`. Reverse proxies must preserve the browser `Origin` header or mutating REST requests and Socket.IO upgrades are rejected.
- Ingest auth derives both configured and supplied bearer tokens into fixed 32-byte digests before `timingSafeEqual` — implemented as `HMAC-SHA-256(token, INGEST_TOKEN_DIGEST_CONTEXT)` so both buffers are always 32 bytes regardless of token length. Timing regression tests must compare equal-length tokens; use separate functional assertions for length sweeps.
- Keep the actual WebSocket scheme-sources in the CSP string, but do not spell the standalone scheme token in TypeScript comments: Sourcery's opengrep rule false-positively flags it.
- Helmet sets CSP (`connect-src 'self' ws: wss:`), HSTS (production only, 2y), `X-Frame-Options: DENY`, and `Referrer-Policy: strict-origin-when-cross-origin`; `Permissions-Policy` disables camera/microphone/geolocation. Three rate limiters with distinct scopes: `ingestPreAuthRateLimiter` is mounted on `/api/ingest/agents` (path-scoped — only ingest POSTs count); `apiMutationGuard` is mounted on `/api` for mutating methods only; `publicGetRateLimiter` is mounted on every request but self-skips `/api/*` and `/socket.io/*` (so the SPA fallback and Engine.IO polling still consume budget). All three are pinned in `server/spa.test.ts` / `server/rateLimit.test.ts`.
- Data-source mode (`DATA_SOURCE=auto|cli|ingest` plus `POLL_INTERVAL`, `ACTIVE_MINUTES`, `OPENCLAW_AGENTS_DIR`, `INGEST_API_TOKEN` — the other five env vars (`LOG_LEVEL`, `FRONTEND_DIR`, etc.) drive unrelated subsystems) drives sticky CLI→ingest fallback on permanent CLI failures (ENOENT/ENOTDIR/EISDIR, EACCES/EPERM, ENOEXEC/EFTYPE, ELOOP/ENAMETOOLONG, or the 10 MiB stdout cap); transient failures preserve the snapshot without mode change. Without `INGEST_API_TOKEN`, `auto` stays in CLI even on permanent failure. CLI polling and ingest writes are never active at the same time — see `dataSourceState` in `server/index.ts`.

## Persistence and Layouts

- `DATA_DIR` defaults to `join(__dirname, "data")`, so dev writes under `server/data/` and standalone compiled startup writes under `dist/server/server/data/`; do not assume repo-root `data/`. Docker sets `DATA_DIR=/app/data`.
- Use `OPENCLAW_BIN` for the CLI path; the collector requires it to be absolute (`collector/README.md`).
- Layout IDs must pass `/^[a-zA-Z0-9_-]+$/` and pass `isSafePersistedFilename` (so `${id}.json` is not a Windows reserved device basename like `con`/`nul`/`com1`/`aux`); max 64 chars; `default` cannot be deleted.
- Layout writes use optimistic concurrency via `baseUpdatedAt`. The client refreshes revisions and retries `409`/server failures with bounded backoff; do not replace newer local edits with stale save responses.
- **REST contract for layouts**: `PUT /api/layouts/:id` is **update-only** — returns `404` for unknown IDs to prevent a stale client from resurrecting a layout another client just deleted. `POST /api/layouts` is the agent-facing creation path (server-assigned `layout-${uuid}` id); the only server-internal creation paths are `GET /api/layouts` and `GET /api/layouts/default` which seed/repair the built-in `default` layout. Capacity enforcement (100 entries, `507 Layout limit reached`) applies at create time, on the `default` GET, and counts every directory entry (JSON layout files and stray non-JSON files alike). `loadLayout` returns `null` for malformed JSON files, so PUT cannot repair a corrupted layout via the API — operators must delete the file and recreate it.
- Programmatic load/create/save-response changes must go through `setActiveLayoutProgrammatic()` so `skipAutoSaveRef` suppresses stale auto-saves. Saves are serialized through `savePromiseRef`; dirty furniture changes debounce for 2 seconds.
- `PixelOffice` re-syncs `GameEngine` through serialized `furnitureKey` (currently `id:type:x,y,rotation` — `type` is required so a furniture type swap at the same coordinates is detected) and `seatsKey` (full seats object) dependencies. If the engine starts reading another `PlacedFurniture` field (`state`), include it in `furnitureKey`.
- Furniture discovery is not fully automatic: add assets and `manifest.json` under `public/assets/furniture/<TYPE>/`, then add the type to the static `/api/furniture-catalog` list in `server/index.ts`.

## Game and Client Invariants

- Adapter characterization in `src/game/GameEngine.integration.test.ts` must execute the real `EditorController`, `SubAgentFSM`, `Schedule`, and `inputGeometry` paths. Mock browser boundaries only; do not add production-only test seams.
- `EditorController` owns canvas mouse/touch listeners. Rotation callbacks carry the exact post-rotation angle so React does not double-increment the shared furniture object.
- Keep both `GameEngine.screenToGrid` overloads; `EditorController` uses the numeric form and `inputGeometry.ts` owns letterbox/pillarbox edge semantics.
- `stateJustChanged` is consumed once in `GameEngine.update()` for sound/VFX and then reset; add transition effects before that reset.
- Typing, reading, running-command, and thinking agents route to assigned seats (`GameEngine.updateCharacter`). Animation rendering groups running-command with typing and thinking with reading in `activityToAnimState`.
- Demo agents are client-side development data only: `PixelOffice` passes `import.meta.env.DEV` to `GameEngine.init`. Production may intentionally render an empty office until real agents arrive.
- Missing furniture sprites use a 2×1 obstacle footprint (`GameEngine.rebuildObstacles` + `findFurnitureAt`). Preserve this conservative pathfinding fallback.
- Use `newEntityId()` from `src/util/id.ts` instead of calling `crypto.randomUUID()` directly; non-secure contexts require its `getRandomValues`/`Math.random` fallbacks.
- `CharacterRecipe` intentionally exists in both `shared/types.ts` and `CharacterComposer.ts`; keep their index ranges synchronized (`bodyIndex` 0–5, `hairIndex` 0–8, `outfitIndex` 0–5).
- **Live-sync events**: `useLiveSync` (in `src/hooks/useLiveSync.ts`) owns the `layout:update` socket subscription; `useAgentStore` owns `recipe-update`. Both validate payloads (`/^[a-zA-Z0-9_-]+$/` ≤ 64 chars for IDs, integer indices within the documented sprite ranges) before any state mutation — invalid events are dropped silently. The hooks must funnel mutations through `updateAgents`/`reconcileRemoteLayout`, not raw `setAgents`/`setActiveLayout`, so the revision counters stay consistent.

## Asset Contracts

- Legacy character sheets are 112×96: seven 16×32 frames across three rows (`down`, `up`, `right`); left is generated by flipping right. Frames 0–2 walk, 3–4 type, and 5–6 read.
- `CharacterComposer.ts` reads the combined MetroCity body/hair/outfit sheets under `public/assets/source/MetroCity/` and emits the same 3×7 layout. Preserve fallback to pre-composited `char_0..5.png` when source sheets fail.
