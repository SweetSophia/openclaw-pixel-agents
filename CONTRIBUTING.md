# Contributing to OpenClaw Pixel Agents

Thanks for your interest in contributing! This project is a pixel art office dashboard for [OpenClaw](https://github.com/openclaw/openclaw) agents.

## Quick Start

```bash
git clone https://github.com/SweetSophia/openclaw-pixel-agents.git
cd openclaw-pixel-agents
npm ci
npm run dev
```

The dev server runs on `http://localhost:3000` and proxies API requests to the backend on port 3001.

## Project Structure

```
├── server/              # Express + Socket.IO backend
│   └── index.ts         # API routes, session polling, layout persistence
├── src/
│   ├── components/      # React components (PixelOffice, AgentSidebar, LayoutEditor)
│   ├── game/            # Canvas 2D game engine
│   │   ├── GameEngine.ts       # Rendering loop, pathfinding, host façade
│   │   ├── EditorController.ts # Mouse/touch editor input and listener lifecycle
│   │   ├── Schedule.ts         # Day/night interpolation
│   │   ├── SubAgentFSM.ts      # Sub-agent lifetime/fade planner
│   │   └── SpriteLoader.ts     # Asset loading, sprite slicing, frame extraction
│   ├── hooks/           # React hooks (useAgentStore, useLayoutStore)
│   └── App.tsx          # Root component
├── public/assets/       # Pixel art sprites and tilesets
│   ├── characters/      # Character sprite sheets
│   ├── furniture/       # Furniture sprites + manifest.json per type
│   ├── floors/          # Floor tile sprites
│   └── source/          # Original asset packs (MetroCity by JIK-A-4)
├── shared/types.ts      # Shared TypeScript types (server ↔ client)
└── server/data/         # Default dev data; set persistent DATA_DIR for production
```

## Development Workflow

1. **Create a branch** for your feature or fix
2. **Make your changes** with clear, commented code
3. **Test locally** — `npm run dev` and verify behavior in the browser when the change affects the UI
4. **Run the automated gate**:
   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run test:coverage
   npm run build
   npm run test:package
   npm audit --omit=dev --audit-level=high
   npm audit --audit-level=moderate   # mirrors the CI full-tree audit gate (issue #168); without this, locally-passing PRs can still land red CI
   ```
5. **Open a PR** with a description of what changed and why

Pull requests and updates to `main` run that gate plus a separate Docker build/startup job in GitHub Actions. The Docker dependency policy is covered by `server/dockerfile.test.ts`, including the requirement that production packages do not need install hooks. With Docker available and port 3001 free, reproduce the container check from a clean checkout:

```sh
(
  set -eu
  docker build --tag openclaw-pixel-agents:ci .
  container_id=$(docker run --detach --publish 127.0.0.1:3001:3001 \
    --env CORS_ORIGIN=http://127.0.0.1:3001 \
    --env DATA_SOURCE=ingest --env INGEST_API_TOKEN=ci-synthetic-ingest-only \
    openclaw-pixel-agents:ci)
  cleanup() {
    docker logs "$container_id" || true
    docker rm --force "$container_id" > /dev/null || true
  }
  trap cleanup EXIT
  curl --fail --silent --show-error --retry 30 --retry-all-errors \
    --retry-delay 1 --connect-timeout 2 --max-time 2 \
    http://127.0.0.1:3001/api/status
  curl --fail --silent --show-error --output /dev/null http://127.0.0.1:3001/
)
```

This uses synthetic configuration and no host data volumes or Gateway credentials; the subshell removes its container on success or failure. See [.github/workflows/ci.yml](.github/workflows/ci.yml) for the CI equivalent.

Repository-wide coverage includes production TypeScript under `src/`, `server/`,
and `shared/`; the baseline floors are 39% statements, 36% branches, 37%
functions, and 41% lines. Pull requests also receive a dependency review that
blocks newly introduced high- or critical-severity vulnerabilities. CodeQL
scans JavaScript and TypeScript changes and runs weekly on the default branch.

For asset-loading changes, also check a local production build (`npm run build`,
then `npm start` with the required `CORS_ORIGIN`). Leave the browser cache enabled
and reload several times within a minute: the console should report 8 characters,
9 floors, and 25 furniture types, with no asset 429s. Sprite, manifest, and
background URLs include a build revision and are cached for a year; rebuild and
restart the local server to verify that the revision changes and fresh assets load. Development
URLs intentionally remain unversioned so edits appear immediately. HTML stays
revalidatable, and asset requests that reach the server still consume the public
GET/HEAD rate limit.

For canvas view changes, test at 320, 768, 1024 and 1440px widths. Fit must keep
the full office clear of the header, desktop sidebar, collapsed activity summary
and editor chrome. Check both an armed furniture type and a selected item, since
their hint/info rows change that chrome's height. Also test 640×320 and 320×480:
keep narrow-screen palette/layout panels open and scroll the workspace to reach
the panels, view controls and office. The stage must stay at least 120px tall;
verify the visible canvas receives native pointer hits between header and dock.
Zoom and pan, then select an agent and place, drag
and rotate furniture on the intended cells. Verify two-finger zoom with a moving
midpoint, one-finger Pan, arrow keys, Escape, Fit, resize and room changes. Panning
must not edit the layout; cancelling a gesture or leaving the window must end
the drag. Browser geometry and hit testing are not exercised by jsdom.

For task-detail changes, configure a dedicated read-only task device or use a
synthetic Gateway fixture. Check 320/390/768/1024/1440px widths and short landscape:
unlock, choose a conversation, refresh, load earlier records and more conversations,
switch Task/Agent tabs with arrows/Home/End, then close with Escape and verify focus
returns to the office trigger. All controls must have reachable 44px targets, long
text must wrap, and the drawer must have one vertical scrolling area. Verify initial
unavailable, pairing, empty, unknown-run, limited-history and stale states. Lock must
remove private content and abort reads; closing, hiding the page or leaving Task
must stop its refresh. Inspect browser errors/network traffic and confirm no private
payload appears on the public socket or in browser storage. Use synthetic text in
screenshots and committed fixtures. Never send a real task as an automated check.

## npm package and releases

`npm run test:package` installs the actual tarball with production dependencies in a disposable directory and checks setup instructions with lifecycle scripts disabled, a separately enabled foreground install notice, configured startup, assets, key generation and restart persistence. Both setup and the notice must leave office data/configuration untouched. It does not contact a real Gateway or publish anything. Run it after building whenever package files, startup or deployment setup changes.

See [the release guide](docs/releases.md) for the `NPM_TOKEN` secret and stable GitHub Release publication. A pull request never publishes to npm.

## Code Style

- **TypeScript** throughout (strict mode)
- **React functional components** with hooks
- **Canvas 2D** for all game rendering (no DOM-based sprites)
- **Comments**: Explain the *why*, not the *what*
- **Naming**: camelCase for variables/functions, PascalCase for components/types

## Adding Furniture

1. Add sprite PNG(s) to `public/assets/furniture/<TYPE>/`
2. Create a `manifest.json` describing dimensions and orientations
3. Add the canonical uppercase ID to `FURNITURE_TYPES` in `shared/furniture.ts`.
   The catalog API, editor palette, and sprite loader use this list.

Layout validation resolves known IDs regardless of case, plus the legacy names
`chair` (cushioned chair) and `monitor` (PC). Unknown safe IDs keep their placeholder.
Existing layout files are normalized when read without being rewritten; saving
an edit stores canonical IDs.

## Adding Character Sprites

1. Sprite sheets must be 112×96px (7 frames × 3 rows, each frame 16×32)
2. Row layout: down (0), up (1), right (2) — left is auto-generated by flipping right
3. Frame mapping: 0-2 walk, 3-4 typing, 5-6 reading
4. Place in `public/assets/characters/` — the loader picks them up automatically

## Reporting Issues

- Include browser, OS, and console errors
- Screenshots or screen recordings help a lot
- If it's a rendering bug, note whether it happens with or without assets loaded

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
