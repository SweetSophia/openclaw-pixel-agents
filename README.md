# OpenClaw Pixel Agents

A pixel art office dashboard for OpenClaw — where your AI agents walk around, sit at desks, and visually reflect what they're doing.

![Pixel Agents](docs/screenshot.png)

## What It Does

Turns your OpenClaw multi-agent system into something you can actually see. Each agent becomes a character in a pixel art office. They walk around, sit at their desk, and visually reflect what they are doing — typing when writing code, reading when searching files, waiting when they need your attention.

## Features

- **One agent, one character** — every active OpenClaw agent gets its own animated pixel character
- **Live activity tracking** — characters animate based on real agent state (typing, reading, thinking, waiting)
- **Office layout editor** — design your office with floors, walls, and furniture
- **Agent enable/disable** — choose which agents get pixel characters
- **Pixel model selector** — choose how each agent is represented
- **Speech bubbles** — visual indicators when an agent is waiting for input
- **Sound notifications** — optional chime when an agent finishes its turn
- **Sub-agent visualization** — spawned sub-agents appear as separate characters
- **Persistent layouts** — your office design is saved and restored

## Architecture

- **Data source**: OpenClaw Gateway API (WebSocket/SSE) for real-time agent state
- **Rendering**: React 19 + Canvas 2D (pixel art game engine)
- **Backend**: Node.js/Express gateway proxy
- **Platform**: Web-based dashboard (not VS Code)

## Getting Started

```bash
git clone https://github.com/SweetSophia/openclaw-pixel-agents.git
cd openclaw-pixel-agents
npm install
npm run dev
```

## Development

Built with:
- React 19 + TypeScript + Vite
- Canvas 2D rendering engine
- BFS pathfinding
- Character state machines (idle → walk → type/read → wait)

## Assets

Default pixel art characters based on the amazing work by [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack).

Custom pixel models can be added via the pixel model selector.

## License

MIT
