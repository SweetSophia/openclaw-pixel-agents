# 🖥️ OpenClaw Pixel Agents

A pixel art office dashboard for [OpenClaw](https://github.com/openclaw/openclaw) — where your AI agents walk around, sit at desks, and visually reflect what they're doing in real time.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![React 19](https://img.shields.io/badge/React-19-61dafb.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6.svg)
![Vite](https://img.shields.io/badge/Vite-6-646cff.svg)

## What It Does

Turns your OpenClaw multi-agent system into a live pixel art office. Each agent becomes a character that walks to their desk, sits down, and animates based on real agent state — typing when writing code, reading when analyzing, thinking when reasoning, waiting when they need your attention.

![Pixel Office](docs/screenshot.png)

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

The app runs at `http://localhost:5173` with the backend API on port 3001.

### Requirements

- **Node.js** 20+
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

Layouts auto-save 1 second after any change.

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
   - `PIXEL_AGENTS_URL` — URL of the pixel-agents server
   - `PIXEL_INGEST_TOKEN` — same secret as `INGEST_API_TOKEN`
3. Install the systemd timer from `collector/systemd/`:
   ```bash
   # Edit the .service file to match your install path
   sudo cp collector/systemd/openclaw-pixel-collector.* /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now openclaw-pixel-collector.timer
   ```

See [collector/README.md](collector/README.md) for full setup instructions.

### Key Components

| Component | Purpose |
|-----------|---------|
| `GameEngine` | Canvas 2D rendering loop, sprite animation, editor mode, mouse handling |
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
| `DATA_SOURCE` | `auto` | Data mode: `auto`, `cli` (local polling), or `ingest` (push-based) |
| `OPENCLAW_CLI` | `openclaw` | Path to OpenClaw CLI binary (cli mode only) |
| `POLL_INTERVAL` | `3000` | Agent state poll interval in ms (cli mode only) |
| `ACTIVE_MINUTES` | `30` | Session staleness threshold |
| `INGEST_API_TOKEN` | *(none)* | Shared secret for ingest API auth (required for ingest mode) |
| `OPENCLAW_AGENTS_DIR` | `~/.openclaw/agents` | Path to agent session transcripts |
| `DATA_DIR` | `./data` | Persistence directory for preferences and layouts |

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
