# OpenClaw Pixel Agents — Staff Engineering Audit (2026-04-10)

## Critical

1. **[REMEDIATED]** Sub-agent cleanup logic in `PixelOffice` can kill other parents' sub-agents because cleanup is scoped per parent loop but scans all engine characters each iteration.
2. **[REMEDIATED]** `GameEngine.init()` calls `spawnDemoAgents()` unconditionally, causing duplicate transient entities and unnecessary work in production.
3. **[REMEDIATED]** Ingest endpoint accepts unbounded session arrays and has no request throttling; a valid token can still trigger high CPU/memory load.

## Performance

1. **[REMEDIATED]** `GameEngine.renderFloor()` repaints full static background every frame.
2. **[REMEDIATED]** `PixelOffice` uses array `includes` inside loops and repeatedly calls `engine.getCharacterIds()`, creating avoidable O(n²) behavior.
3. **[REMEDIATED]** `renderCharacter()` and VFX paths call `performance.now()` repeatedly per character/frame.

## Architecture

1. **[REMEDIATED]** Frontend agent state is poll-only (`/api/agents` every 2s) while backend emits `agents:update` events over Socket.IO that are unused by the UI.
2. **[REMEDIATED]** Layout autosave race was mitigated, but save operations still lack request cancellation / latest-write-wins semantics.

## Quick wins

- **[REMEDIATED]** Add body size limits + schema validation for ingest payloads.
- **[REMEDIATED]** Memoize ID sets in `PixelOffice` and diff with `Set` membership checks.
- **[REMEDIATED]** Remove demo spawns behind explicit debug flag.
- **[REMEDIATED]** Use a pre-rendered offscreen canvas for immutable tiles/walls.
