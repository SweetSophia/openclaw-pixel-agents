*Development picked up again at 19th of April 2026. Expect many updates and improvements every week now!*

# 🖥️ OpenClaw Pixel Agents

A pixel art office dashboard for [OpenClaw](https://github.com/openclaw/openclaw) — where your AI agents walk around, sit at desks, and visually reflect what they're doing in real time.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![React 19](https://img.shields.io/badge/React-19-61dafb.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6.svg)
![Vite](https://img.shields.io/badge/Vite-6-646cff.svg)
[![CI](https://github.com/SweetSophia/openclaw-pixel-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/SweetSophia/openclaw-pixel-agents/actions/workflows/ci.yml)
[![CodeQL](https://github.com/SweetSophia/openclaw-pixel-agents/actions/workflows/codeql.yml/badge.svg)](https://github.com/SweetSophia/openclaw-pixel-agents/actions/workflows/codeql.yml)

<img width="797" height="656" alt="screenshot-office" src="https://github.com/user-attachments/assets/6b485484-26ff-4739-bfdd-d7a0f90fbec6" />
<img width="797" height="660" alt="screenshot-furniture" src="https://github.com/user-attachments/assets/506f3ec8-4c7c-4fa0-9db5-e5274eb4390d" />
<img width="578" height="321" alt="character-customization" src="https://github.com/user-attachments/assets/9a0a0315-a7a5-4907-adf5-a68dd8010ed3" />


## What It Does

Turns your OpenClaw multi-agent system into a live pixel art office. Each agent becomes a character that walks to their desk, sits down, and animates based on real agent state — typing when writing code, reading when analyzing, thinking when reasoning, waiting when they need your attention.


## Features

- **Live agent visualization** — characters animate based on real OpenClaw Gateway state (typing, reading, thinking, waiting, error)
- **Drag-and-drop layout editor** — place, move, rotate, and delete furniture on a grid
- **Persistent layouts** — save and load office designs; create multiple layouts
- **25 furniture types** — desks, PCs, chairs, plants, bookshelves, whiteboards, coffee machines, paintings, and more
- **Agent toggle** — choose which agents appear in the pixel office
- **Character sprites** — animated pixel characters with walk, typing, and reading states
- **Fallback rendering** — works even without sprite assets (colored rectangles)
- **Real-time sync** — polls OpenClaw Gateway for agent state every 3 seconds

## Quick Start

```bash
git clone https://github.com/SweetSophia/openclaw-pixel-agents.git
cd openclaw-pixel-agents
npm install
npm run dev
```

The app runs at `http://localhost:3000` with the backend API on port 3001.

### Requirements

- **Node.js** `^22.22.2`, `^24.15.0`, or `>=26.0.0` (the binding range comes from `jsdom@30`). Declared in `package.json#engines` and enforced via `.npmrc` (`engine-strict=true`).
- **One of:**
  - **OpenClaw** running locally with CLI in PATH (for `cli`/`auto` data mode)
  - **Ingest API** — set `DATA_SOURCE=ingest` + `INGEST_API_TOKEN` and push data from a collector script on the OpenClaw host

### Demo Mode

Without a running OpenClaw Gateway, the app starts with 8 demo agents (Cybera, Shodan, Cyberlogis, Descartes, Chi, Cylena, Sysauxilia, Miku) in various activity states. This is enough to test the layout editor and rendering.

## Usage

### Agent Sidebar

The right sidebar shows all configured agents with:
- Activity state badge (color-coded)
- Model name
- Token usage bar
- Toggle button to show/hide in the pixel office
- Bulk Show All / Hide All controls

### Layout Editor

Click **✏️ Edit** in the header to enter editor mode:

| Action | How |
|--------|-----|
| Place furniture | Click a type in the 📦 palette, then click on the grid |
| Select furniture | Click on placed furniture (green dashed border) |
| Move furniture | Click and drag |
| Rotate furniture | Right-click, or use 🔄 button in the info bar |
| Delete furniture | Use 🗑️ button in the info bar, or press Delete |
| Save layout | Click 💾 Save |

Layouts auto-save 2 seconds after the last furniture change; the explicit Save button remains available.

### Layout Manager

Click **📐 Layouts** to manage saved layouts:
- Create new layouts with custom names
- Switch between layouts
- Delete layouts (default layout is protected)

## Architecture

### Data Source Modes

The server supports three modes for getting agent data, controlled by the `DATA_SOURCE` env var:

| Mode | `DATA_SOURCE` | How it works |
|------|--------------|--------------|
| **Auto** (default) | `auto` | Tries CLI polling; if `openclaw` is not found and `INGEST_API_TOKEN` is set, switches to ingest-only |
| **CLI Poll** | `cli` | Polls `openclaw sessions` locally every 3 seconds (requires OpenClaw on the same machine) |
| **Ingest** | `ingest` | Accepts pushed data via `POST /api/ingest/agents` — no local OpenClaw needed |

#### Mode 1: Same machine as OpenClaw (CLI Poll)

```
Browser                          Server                     OpenClaw
┌──────────────┐   HTTP/WS   ┌──────────────┐   CLI poll   ┌──────────────┐
│ React 19     │◄───────────►│ Express      │◄────────────►│ Gateway      │
│ Canvas 2D    │             │ Socket.IO    │   (3s)       │ Sessions API │
│ GameEngine   │             │ Layout API   │              └──────────────┘
└──────────────┘             └──────────────┘
```

Just run it on the same machine as OpenClaw. No extra configuration needed.

#### Mode 2: Separate server (Ingest via Collector)

```
┌─────────────────────┐         every 15s          ┌──────────────────┐
│  OpenClaw Server     │ ──── collector script ───→ │  Your Server     │
│  (has openclaw CLI)  │    token-authenticated     │  (pixel-agents)  │
│                      │    POST /api/ingest/agents │                  │
└─────────────────────┘                            └──────────────────┘
```

1. Set `DATA_SOURCE=ingest` and `INGEST_API_TOKEN=<secret>` on the pixel-agents server
2. On the OpenClaw host, copy `collector/.env.collector.example` to `.env.collector` and configure:
   - `PIXEL_AGENTS_URL` — HTTPS URL of the pixel-agents server (loopback HTTP is allowed for local development)
   - `PIXEL_INGEST_TOKEN` — same secret as `INGEST_API_TOKEN`
   - `OPENCLAW_BIN` — absolute path returned by `command -v openclaw`
3. Install the systemd timer from `collector/systemd/`:
   ```bash
   # Edit User and all installation paths in the .service file first
   sudo cp collector/systemd/openclaw-pixel-collector.* /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now openclaw-pixel-collector.timer
   ```

The ingest endpoint accepts additive fields from OpenClaw's evolving session output,
then sanitizes each entry into the small session shape used by this server. Registered
agent IDs, retained field types and sizes, and opaque session IDs are validated before
an update is applied; invalid retained fields return HTTP 400.

See [collector/README.md](collector/README.md) for full setup instructions.

### Key Components

| Component | Purpose |
|-----------|---------|
| `GameEngine` | Canvas 2D rendering loop, sprite animation, pathfinding, and host façade |
| `EditorController` | Mouse/touch editor state and canvas listener lifecycle |
| `SpriteLoader` | Loads and slices sprite sheets into individual frame canvases |
| `LayoutEditor` | Toolbar, furniture palette, layout manager UI |
| `PixelOffice` | Canvas wrapper, wires agent/layout data to GameEngine |
| `AgentSidebar` | Agent list with toggles and activity badges |
| `useAgentStore` | Fetches agent state from backend API |
| `useLayoutStore` | CRUD operations for layouts with auto-save |

### Sprite Format

Character sprite sheets are 112×96px PNGs:
- **7 frames per row** (16×32px each)
- **3 rows**: down (row 0), up (row 1), right (row 2)
- **Frame mapping**: 0-2 walk, 3-4 typing, 5-6 reading
- Left direction is auto-generated by flipping the right row

Furniture uses per-type directories with `manifest.json` for dimensions and rotation schemes.

## Adding Custom Assets

### New Furniture Type

1. Add sprites to `public/assets/furniture/<TYPE>/`
2. Create `manifest.json`:
   ```json
   {
     "id": "MY_FURNITURE",
     "name": "My Furniture",
     "category": "decor",
     "type": "single",
     "members": [{
       "type": "asset",
       "id": "MY_FURNITURE",
       "file": "MY_FURNITURE.png",
       "width": 32,
       "height": 32,
       "footprintW": 2,
       "footprintH": 2
     }]
   }
   ```
3. Add the type name to the furniture catalog in `server/index.ts`
4. It appears in the editor palette automatically

### New Character Sprite

1. Create a 112×96px sprite sheet following the format above
2. Place in `public/assets/characters/`
3. The `SpriteLoader` picks it up automatically

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Canvas 2D
- **Backend**: Node.js, Express, Socket.IO
- **Assets**: [MetroCity](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack) character pack by JIK-A-4
- **Agent Data**: [OpenClaw](https://github.com/openclaw/openclaw) Gateway

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `3001` | Backend server port (`3000` in production) |
| `NODE_ENV` | *(set to `production` by `npm start`)* | Runtime mode; production requires `CORS_ORIGIN` for WebSocket origin checks |
| `CORS_ORIGIN` | *(none)* | Comma-separated browser origins allowed to open Socket.IO connections and to send state-mutating REST requests in production |
| `DATA_SOURCE` | `auto` | Data mode: `auto`, `cli` (local polling), or `ingest` (push-based); invalid values fail safe to `auto` |
| `OPENCLAW_BIN` | `openclaw` | Path to OpenClaw CLI binary (CLI polling modes only) |
| `POLL_INTERVAL` | `3000` | Agent state poll interval in ms (cli mode only) |
| `ACTIVE_MINUTES` | `30` | Session staleness threshold |
| `INGEST_API_TOKEN` | *(none)* | Shared secret for ingest API auth (required for ingest mode) |
| `OPENCLAW_AGENTS_DIR` | `~/.openclaw/agents` | Path to agent session transcripts |
| `DATA_DIR` | `./data` | Persistence directory for preferences and layouts |

### Agent data-source modes

The server follows a finite-state machine and the single-writer principle: CLI polling and ingest writes are never active at the same time. `cli` always keeps CLI polling active, and `ingest` starts ingest-only without polling. Ingest mode requires `INGEST_API_TOKEN`. Configuring a token does not enable pushes in explicit `cli` mode; use `ingest` or `auto` when collector delivery should own agent state.

`auto` starts with CLI polling. When an ingest token is configured and CLI execution fails specifically because `OPENCLAW_BIN` is missing (`ENOENT` or `ENOTDIR`), the server makes an at-most-once, sticky transition to ingest-only. This hysteresis prevents later polling from taking ownership back; returning to CLI ownership after fallback requires restarting the server once the executable is available. Transient failures—including non-zero exits, timeouts, permission errors, malformed output, and unknown errors—preserve the previous snapshot and do not switch modes. Without an ingest token, `auto` remains in CLI mode even when the executable is missing.

While CLI polling owns agent state, authenticated ingest requests are rejected with `409 Conflict` before rate limiting or payload validation. `/api/status` reports `dataSourceConfig`, `dataSourceEffective`, `dataSourceTransitioned`, `cliPolling`, and `lastIngestAt`.

The legacy `dataSource` field remains a compatibility alias for **effective ownership**: `cli-poll` while polling owns state, and `ingest` while ingest-only owns state. It no longer means that an ingest push happened at any point in the process lifetime; use `lastIngestAt` for accepted-push history and migrate mode checks to `dataSourceEffective`.

### Reverse-proxy deployments

If you terminate TLS or rewrite requests in a reverse proxy in front of the Node server, make sure the `Origin` header from the browser is forwarded unchanged. State-mutating REST routes (`POST/PUT/PATCH/DELETE /api/*`) require an allowed `Origin` in production; stripping or rewriting it will cause legitimate browser mutations to fail with `403 Forbidden origin`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server (Vite + backend) |
| `npm run build` | Production build to `dist/` |
| `npm start` | Run production build |

## License

[MIT](LICENSE) — free for personal and commercial use.

Pixel art assets by [JIK-A-4](https://jik-a-4.itch.io/) (MetroCity pack) — free for personal and commercial use per itch.io terms.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and how to add custom assets.
