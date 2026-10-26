# Canvas Controls Implementation Plan

Status (2026-10-26): source and native browser qualification merged in [PR #293](https://github.com/SweetSophia/openclaw-pixel-agents/pull/293). The controls were included in subsequent backed-up, verified Task and Workspace runtimes. Current rollout qualification is tracked separately in [revamp status](../../revamp-status.md).

> **For agentic workers:** Use superpowers:executing-plans to implement and verify each slice.

**Goal:** Fit, zoom and pan the office on desktop and touch screens without changing game coordinates or saved layouts.

**Architecture:** A React CanvasViewport sizes and clips the existing canvas, preserving its intrinsic resolution. Its bounded view state owns zoom and pan; EditorController forwards pinch gestures to it. Native canvas selection/editing continues through the existing bounding-rectangle coordinate conversion.

**Tech Stack:** Existing React, TypeScript, CSS, ResizeObserver, Pointer Events and Vitest; no new dependencies.

**Spec:** The approved Fit/zoom/pan follow-up in this conversation: accessible toolbar, explicit Pan mode, touch support, and correct selection/editing at every zoom.

## Global Constraints

- Node `^22.22.2 || ^24.15.0 || >=26.0.0`; use `npm ci`.
- Preserve EditorController ownership of canvas mouse/touch listeners and both screenToGrid overloads.
- Keep view state local; do not write layout or agent preferences when navigating.
- Fit respects rendered header/editor toolbar, collapsed activity summary, and desktop sidebar lanes.
- Zoom is 1–4 times fitted size; pan is clamped to reachable canvas edges; Fit recenters and exits Pan mode.

## Review Focus

- Resize and HUD wrapping: recompute fit and clamp pan without invalid dimensions.
- Pinching after button zoom: share view state; no second canvas transform.
- Pointer cancellation and mode switching: terminate pan and preserve later selection.
- Same canvas under zoom: real editor callbacks receive the intended grid cells.
- Keyboard and narrow screens: controls remain reachable, labelled and at least 44px tall.

## Tasks

### 1. View geometry and controls

Files: `src/game/viewportGeometry.ts`, its tests; `src/components/CanvasViewport.tsx`, `.css`, and tests.

- [x] Write failing tests for fitting, bounded pan, zoom anchoring, resize, controls, pointer cancellation and keyboard navigation.
- [x] Run focused tests and record RED.
- [x] Implement pure geometry and the accessible toolbar/viewport; explicit Pan overlay owns its own pointer gestures.
- [x] Run focused tests and confirm GREEN.

### 2. Adapter and pinch integration

Files: `PixelOffice.tsx`, `PixelOffice.css`, `GameEngine.ts`, `EditorController.ts`, adapter/controller tests.

- [x] Write failing tests for delegated pinch and real editor/selection coordinates on an offset, scaled canvas.
- [x] Connect PixelOffice and delegate pinch zoom without changing standalone engine behavior.
- [x] Confirm all focused tests pass; update README and agent invariants.

### 3. Evidence and review

- [x] Run `npm run typecheck`, `npm run test:coverage`, `npm run build`, and dependency audits.
- [x] Use a copied-data preview in Chromium at 320, 768, 1024 and 1440px; check HUD bounds, Fit/zoom/pan, touch pinch, keyboard, selection, furniture placement/drag/rotation and resize. Twelve room switches retain zoom, resolved seats and valid floor positions without changing saved layout data.
- [x] Review the complete diff and open PR #293 with precise verification evidence.
- [x] Address valid bot findings: scrollable workspace and minimum stage for short windows, Safari Pan styles, scoped Escape/context-menu handling, guarded CSS writes, and stronger gesture/lifecycle tests. Verify native scrolling and hit-testing at 640×320 and 320×480 with the palette expanded.
- [x] Follow the existing merge/deployment authorization after current checks and reviews finish, backing up current live data first. Source merged in PR #293; subsequent Task/Workspace rollout records establish preserved-state runtime delivery.
