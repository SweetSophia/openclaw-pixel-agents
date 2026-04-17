# Agent Guide — OpenClaw Pixel Agents

## Project Overview

A pixel art office dashboard for [OpenClaw](https://github.com/openclaw/openclaw). Agents appear as animated characters that walk to desks, sit down, and animate based on real agent state (typing, reading, thinking, etc.).

- **Frontend**: React 19, TypeScript, Vite, Canvas 2D game engine
- **Backend**: Node.js, Express, Socket.IO
- **Assets**: MetroCity pixel art character pack (JIK-A-4 on itch.io)
- **Data**: OpenClaw Gateway session polling (CLI or ingest API)

## Commands

```bash
npm run dev        # Start dev (Vite on :3000 + backend on :3001, via concurrently)
npm run dev:client # Vite only (port 3000, proxies /api → :3001)
npm run dev:server # Backend only (tsx watch on :3001)
npm run build      # Vite build + tsc -p tsconfig.server.json → dist/
npm run start      # Run production build (node dist/server/index.js)
npm run typecheck  # tsc --noEmit
```

## Architecture

### Directory Structure

```
server/index.ts         # Express + Socket.IO backend (all API routes here)
shared/types.ts         # Shared TypeScript types (server ↔ client)
src/
  App.tsx               # Root component, wires all panels
  components/           # React UI components
    PixelOffice.tsx     # Canvas wrapper, initializes GameEngine
    AgentSidebar.tsx    # Agent list with toggles
    LayoutEditor.tsx    # Furniture palette, layout manager
    AgentDetailPanel.tsx# Agent detail/edit panel
    MessageTicker.tsx   # Scrolling message ticker
    RoomSwitcher.tsx    # Room navigation tabs
    CharacterCustomizer.tsx  # Paperdoll body/hair/outfit picker
    TagEditor.tsx       # Tag management
    SoundControls.tsx    # Mute/volume UI
  game/
    GameEngine.ts       # Canvas 2D rendering loop, animation, pathfinding, editor mode
    SpriteLoader.ts     # Sprite sheet loading, frame extraction
    CharacterComposer.ts # Paperdoll compositor (body+hair+outfit layering)
    Pathfinder.ts        # BFS pathfinding
  hooks/
    useAgentStore.ts    # Agent state: polling + Socket.IO events
    useLayoutStore.ts   # Layout CRUD, auto-layout loading
  audio/
    SoundFX.ts          # Web Audio API synthesizer (no audio files)
collector/              # Runs on OpenClaw host, pushes to ingest API
  push-pixel-agents.mjs # Node script invoked by systemd timer
```

### Data Flow

```
OpenClaw Gateway
    ↓ CLI poll (every 3s, configurable via POLL_INTERVAL)
server/index.ts
    ↓ Socket.IO broadcast "agents:update"
    ↓ REST /api/agents (polled every 2s by frontend)
useAgentStore (React hook)
    ↓
PixelOffice → GameEngine (Canvas 2D render loop @ 60fps)
```

### Server Architecture

The backend runs in a **single process**: Express serves the built frontend (from project root after build) and handles API routes. In development, Vite proxies `/api` and `/socket.io` to `localhost:3001`.

The `server/index.ts` is the **only** server file. All routes, polling logic, layout persistence, message ticker, and Socket.IO handling live there.

### Key Ports

| Context | Port | Notes |
|---------|------|-------|
| Vite dev | 3000 | Proxies `/api` and `/socket.io` to 3001 |
| Backend dev | 3001 | `npm run dev:server` |
| Backend prod | 3001 | `PORT` env var (defaults to 3001, production uses 3000 via reverse proxy) |

## Key Patterns

### Agent Activity → Animation State

Activity states from OpenClaw map to engine animation states:

```
typing / running_command → 'typing' anim
thinking / reading       → 'reading' anim
idle / sleeping / error → 'idle' anim
waiting_input           → speech bubble rendered, no special anim
```

When an agent enters `typing` or `reading`, the engine **auto-routes them to their assigned seat** (seats are defined per-layout, resolved via `engine.assignSeat()` or explicit `seats` map).

### Layout Persistence

Layouts are JSON files stored in `data/layouts/`. Each layout is a separate `.json` file named `{id}.json`. The `default` layout is protected from deletion.

**Layout IDs are validated** with a strict regex (`/^[a-zA-Z0-9_-]+$/`, max 64 chars) to prevent path traversal. This was a recent security fix.

### Agent Registry

The server maintains a `AGENT_REGISTRY` (Map of KnownAgent objects) initialized from hardcoded defaults in `defaultRegistry()`. Preferences (pixelEnabled, spriteId, tags, recipe) are persisted to `data/agent-prefs.json` and merged on startup.

The **8 default agents**: main/Shodan, miku, chi, sysauxilia, descartes, cyberlogis, cylena, cybera.

### Message Ticker (Transcript Polling)

The server tails transcript JSONL files from `~/.openclaw/agents/{agentId}/sessions/` using **byte-offset seeking** — each poll cycle only reads newly-appended lines. The offset advances only past complete lines (those ending in newline), so partial lines at EOF are re-read on the next cycle. This avoids data loss on fast writes.

Transcript content filtering skips `thinking`, `tool_use`, `tool_result` blocks, heartbeats, and messages shorter than 5 chars.

### Paperdoll Character Compositor

`CharacterComposer.ts` layers MetroCity source sprites (body + outfit + hair) into per-agent character sheets. Source path: `/assets/source/MetroCity/`. It reads:
- `CharacterModel/Character Model.png` (6 rows × 24 cols, 32×32px)
- `Hair/Hairs.png` (9 rows × 24 cols)
- `Outfits/Outfit{1-6}.png` (1 row × 24 cols each)

Output is in the same 3×7 format as legacy sprites (16×32 frames). If source sheets fail to load, falls back to pre-composited `char_0..5.png`.

### Sound Effects

`SoundFX.ts` is a **Web Audio API synthesizer** — no audio files. All sounds (typing clicks, footsteps, spawn/despawn chimes, etc.) are generated procedurally via oscillators and gain envelopes. Muted state and volume persist in the singleton.

### Editor Mode (GameEngine)

Editor mode is a mode on `GameEngine` (not a separate component). When active:
- Canvas cursor changes to indicate placement/drag/delete modes
- Right-click rotates furniture 90°
- Touch: single tap = place/select, double-tap = rotate, drag = move
- Clicking furniture in delete mode immediately deletes it

The engine fires `EditorCallbacks` (`onPlaceFurniture`, `onSelectFurniture`, `onMoveFurniture`) back to React, which updates the layout store.

## Non-Obvious Gotchas

1. **Auto-save was intentionally removed.** The `useLayoutStore` comment explains: furniture is persisted only via explicit **Save button** to avoid race conditions on initial load and React StrictMode double-mounts that caused furniture to reset. The `updateFurniture` function accepts a functional updater form specifically for rapid delete-mode clicks.

2. **`furnitureKey` detection.** `PixelOffice` uses `JSON.stringify` of furniture positions/rotations as a React effect dependency to detect layout changes. If you add new fields to `PlacedFurniture` that the engine reads but don't include them in this string, the engine won't re-sync.

3. **Transcript byte-offset tailing.** The `tailTranscript` function in `server/index.ts` uses `start: offset, end: fileSize - 1` to read only new bytes. The critical invariant: the offset only advances past complete lines (those terminated by `\n`), so a partial last line is re-read on the next poll. Don't "simplify" this to just seek to `fileSize`.

4. **`furniture.get(f.type)` footprint reading.** Furniture obstacle footprint uses `sprite.footprintW` and `sprite.footprintH` from the cached furniture map. If a furniture type has no sprite loaded, footprint defaults to 2×1 (treating it as a desk-like obstacle).

5. **`isPolling` guard.** The poll loop guards against overlapping cycles: if a previous poll is still running (awaiting CLI or transcript reads), the next tick is skipped entirely. This prevents concurrent access to shared state (`agentStates`, `tickerMessages`).

6. **Socket.IO `changeOrigin: true`.** The Vite proxy config sets `changeOrigin: true` for both `/api` and `/socket.io`. Without it, WebSocket upgrades fail because the `Host` header doesn't match what the backend expects.

7. **`screenToGrid` has overloads.** `screenToGrid(e: MouseEvent)` and `screenToGrid(clientX: number, clientY: number)` — used by both mouse and touch handlers. Don't merge them naively.

8. **`stateJustChanged` is one-frame-only.** Set to `true` in `updateCharacter` when state changes, consumed once in `update()` to trigger sounds/VFX, then reset. If you add more state-change side effects, add them before the reset.

9. **Day/night cycle and monitor glow.** The cycle runs continuously (120-second full cycle). Monitor glow only renders when `phase.light < 0.5` (night phases). Sparkle ambient particles also only spawn at night near typing agents.

10. **Demo mode.** If no agents are active (no CLI and no ingest data), `spawnDemoAgents()` creates 8 hardcoded demo characters. The backend always initializes these in the engine, so the office is never empty.

11. **Sub-agent lifecycle.** Sub-agents spawn near their parent, live for 15 seconds (`SUBAGENT_LIFETIME`), then enter a 2-second fade-out. The `subAgents` array on `AgentState` drives spawn/kill via `engine.spawnSubAgent()` / `engine.killSubAgent()`. Session completion/abort sets sub-agent status, which triggers the kill.

12. **Duplicate type definition.** `CharacterRecipe` is defined in both `shared/types.ts` (line ~64) and `CharacterComposer.ts` (line ~54). They are identical. The one in `shared/types.ts` is used by the network layer; `CharacterComposer.ts` exports its own for the compositor.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Backend server port |
| `DATA_SOURCE` | `auto` | `auto`, `cli`, or `ingest` |
| `OPENCLAW_BIN` | `openclaw` | Path to OpenClaw CLI |
| `POLL_INTERVAL` | `3000` | Agent poll interval (ms) |
| `ACTIVE_MINUTES` | `30` | Session staleness threshold |
| `INGEST_API_TOKEN` | *(none)* | Shared secret for ingest API |
| `OPENCLAW_AGENTS_DIR` | `~/.openclaw/agents` | Transcript directory |
| `DATA_DIR` | `./data` | Persistence directory |

## Adding New Furniture

1. Add sprites to `public/assets/furniture/<TYPE>/`
2. Create `manifest.json` with `id`, `name`, `category`, `type`, and `members` array
3. Add type name to the furniture catalog array in `server/index.ts` (line ~932)
4. It appears in the editor palette automatically via `/api/furniture-catalog`

## Socket.IO Events

**Server → Client:**
- `agents:update` — full agent list (on connect + every poll cycle)
- `ticker:messages` — rolling ticker message buffer
- `layout:update` — layout changed
- `recipe-update` — agent paperdoll changed

**Client → Server:** (none in current implementation)
