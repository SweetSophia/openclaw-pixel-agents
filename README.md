# OpenClaw Pixel Agents

A live pixel-art office for [OpenClaw](https://github.com/openclaw/openclaw): see who is working, inspect a task, and send a message without leaving the office.

[![CI](https://github.com/SweetSophia/openclaw-pixel-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/SweetSophia/openclaw-pixel-agents/actions/workflows/ci.yml)
[![CodeQL](https://github.com/SweetSophia/openclaw-pixel-agents/actions/workflows/codeql.yml/badge.svg)](https://github.com/SweetSophia/openclaw-pixel-agents/actions/workflows/codeql.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<img width="482" height="315" alt="Pixel office with agents" src="https://raw.githubusercontent.com/SweetSophia/openclaw-pixel-agents/refs/heads/main/docs/pixel-agents-1.png" /> <img width="482" height="315"  alt="Pixel office with agents - Tasks" src="https://raw.githubusercontent.com/SweetSophia/openclaw-pixel-agents/refs/heads/main/docs/pixel-agents-2.png" />


## What you can do

- **Follow live activity.** Animated agents, room counts and a filterable activity dock show working, attention-needed, idle and inactive states. Freshness indicators distinguish an old collector snapshot from a lost browser connection.
- **Inspect real tasks.** Open an agent's Task tab to choose a conversation, inspect verified run state, read the recorded request and response, and review recent tool outcomes. Load earlier records when the first history window is incomplete.
- **Have a conversation.** Read text history, send a message, queue a follow-up while an agent is busy, or start a new conversation. Sending is optional and requires a separately approved write grant.
- **Collect results and files.** The Results tab shows a verified result or clearly labels the latest response when completion is unconfirmed. Preview delivered text and still PNG/JPEG/WebP images, download other supported files, or explicitly open an external link after checking its host. It follows the selected conversation and task; it is not a workspace file browser.
- **Browse agent workspaces.** The read-only Workspace tab offers folders, breadcrumbs, paginated file lists, text/image previews and supported downloads for the selected agent. It works without a conversation and uses the existing office key. This panel is available from source; npm 1.5.0 contains Results/Files but does not yet include Workspace.
- **Build your office.** Search 25 furniture types, place, drag, rotate and delete items, and save multiple layouts. Footprint previews show overlap and boundaries; layouts auto-save after edits.
- **Move around comfortably.** Fit, zoom, pan, keyboard navigation and pinch gestures work with the responsive office view and mobile drawers.
- **Make agents recognizable.** Choose body, hair and outfit, edit tags, and show or hide agents. Customizations live on the server, sync between browsers and survive restarts when the data directory is retained.
- **Choose your deployment.** Run beside OpenClaw with local CLI polling, or run the dashboard elsewhere and push roster snapshots from the supplied collector. Private task access connects separately to the Gateway.

Task, Conversation and Results share the same conversation selection. Workspace follows the selected agent and can include files from any conversation; Agent retains the office roster summary. Private file access uses the existing office key and `operator.read` grant. Gateways without assistant-filtered artifact APIs still provide task text; Results explains when file discovery is unsupported. See [results and file access](docs/task-access-setup.md#results-and-delivered-files) and [workspace browsing](docs/task-access-setup.md#read-only-workspace-browsing) for limits and compatibility.

## Start from source

Use Node.js **22.22.2+ within 22.x**, **24.15.0+ within 24.x**, or **26+**; the exact supported range is enforced by the repository. For live agents, you also need OpenClaw locally or a configured collector.

```sh
git clone https://github.com/SweetSophia/openclaw-pixel-agents.git
cd openclaw-pixel-agents
npm ci
npm run dev
```

Open **http://localhost:3000**. Vite serves the client and proxies the API and socket to the backend on port **3001**. When OpenClaw is installed elsewhere, set `OPENCLAW_BIN` in the backend environment or follow the [collector guide](collector/README.md).

Development builds can show demo characters before live data arrives. **Production does not insert demo agents**; an empty office may simply be waiting for its data source.

### Run a production build

```sh
npm run build
cp .env.example .env
```

Edit `.env`: set your exact `CORS_ORIGIN`, choose a stable absolute `DATA_DIR`, and configure the roster source. Keep it private (`chmod 600 .env` on POSIX). Then explicitly load it:

```sh
node --env-file=.env dist/server/server/index.js
```

The example uses **http://localhost:3001**. The server does not load `.env` automatically. `npm start` is available when your service manager or shell already supplies the environment. Existing process variables take precedence over an env file.

### npm installation

The package is available on npm with a launcher and release workflow. Results/Files requires **1.5.0 or newer**; see the [1.5.0 release notes](https://github.com/SweetSophia/openclaw-pixel-agents/blob/main/docs/releases/1.5.0.md) for features and upgrade details.

```sh
npm install --global "openclaw-pixel-agents@^1.5.0"
openclaw-pixel-agents --help
openclaw-pixel-agents --env-file /absolute/path/to/.env
```

Alternatively, use `npx --yes "openclaw-pixel-agents@^1.5.0" --env-file /absolute/path/to/.env`. Both examples select version 1.5.0 or a newer compatible 1.x release. The package contains the compiled client, server, sprites and key generator; users do not need to build it or install development dependencies.

The launcher runs in production mode. Its default data directory is **`~/.openclaw-pixel-agents`**, outside the installation, so package upgrades do not replace saved layouts or appearances. Set `DATA_DIR` explicitly for a service account or multiple offices. Obtain an [example configuration](https://github.com/SweetSophia/openclaw-pixel-agents/blob/main/.env.example) and follow the [configuration reference](docs/configuration.md).

## Create your task-access key

**Each installation creates its own key.** There is no project-wide key, and no developer-specific file path is required.

1. Generate a fresh key from a source checkout:

   ```sh
   npm run --silent control:key
   ```

   With the npm launcher, use `openclaw-pixel-agents --generate-key` instead. Both use Node's cryptographic random generator and print a new 64-character hexadecimal key. They do not change a running server.

2. Put that value in the office server's private configuration:

   ```dotenv
   OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
   PIXEL_CONTROL_TOKEN=PASTE_THE_GENERATED_KEY_HERE
   CONTROL_SEND_ENABLED=false
   ```

   The loopback URL assumes the Gateway runs on the same host. Use an encrypted `wss://` endpoint for a remote Gateway. Restart the office after updating its configuration.

3. Pair the office's own device with OpenClaw. First-time pairing may need a temporary server-only Gateway credential and approval of `operator.read`. Follow the [task-access setup guide](docs/task-access-setup.md#3-pair-the-office-with-openclaw), then remove the bootstrap credential once the scoped device grant is saved.

4. Open an agent's **Task** tab and paste the **same `PIXEL_CONTROL_TOKEN` value** into **Unlock task details**. Visitors get this key from their office operator. Generating a different key will not unlock somebody else's installation.

The office key, collector ingest token and Gateway bootstrap credential serve different purposes. Never paste a Gateway master credential into the task window or put any key in a browser URL, commit or `VITE_*` variable. Unlock lasts only in the current tab; Lock and reload clear it.

To enable sending, set `CONTROL_SEND_ENABLED=true` and approve this office device for **`operator.read` plus `operator.write`**. Read-only access remains useful without sending. Remote private access normally requires HTTPS; loopback development and an explicitly configured direct-Tailscale exception are covered in the [setup guide](docs/task-access-setup.md).

## Connect your agents

| Where OpenClaw runs | Roster source | Setup |
| --- | --- | --- |
| On the dashboard host | `DATA_SOURCE=cli` | Put `openclaw` in PATH or set `OPENCLAW_BIN`; polling defaults to 3 seconds. |
| On another host | `DATA_SOURCE=ingest` | Set `INGEST_API_TOKEN` and run the [collector](collector/README.md) on the OpenClaw host. |
| Automatic local fallback | `DATA_SOURCE=auto` | Starts with CLI polling; an ingest token permits a sticky fallback on permanent CLI failures. |

The collector supplies roster/session status. It does **not** enable private task details or conversation controls; those use the separately paired Gateway connection above. `/api/status` reports roster ownership and freshness.

### Use your own roster

The current server ships with eight predefined agent IDs: `main`, `miku`, `chi`, `sysauxilia`, `descartes`, `cyberlogis`, `cylena` and `cybera`. Display names, default tags and enabled state are defined in `defaultRegistry()` in [server/index.ts](https://github.com/SweetSophia/openclaw-pixel-agents/blob/main/server/index.ts); default appearance recipes live in [shared/characterRecipes.ts](https://github.com/SweetSophia/openclaw-pixel-agents/blob/main/shared/characterRecipes.ts).

If your OpenClaw installation uses different IDs, adapt the registry in a source checkout and rebuild. The current release does not automatically discover an arbitrary agent roster. Tags determine room mapping and can be edited in the office.

## Using the office

**Activity:** expand the bottom dock to filter agents across rooms, including hidden ones. Activity estimates come from session recency and token counts; they do not prove which tool an agent is using. Observed changes contains this tab's recent status transitions and clears on reload. Task details provide the separately verified task facts.

**Navigation:** Fit recenters the whole office. Use −/+ to zoom from 100% to 400% of the fitted view. Pan enables mouse or one-finger dragging; arrow keys pan while it is active, and Escape exits. Two-finger gestures zoom and move together. Navigation does not edit saved layouts.

**Layouts:** enter Editor, search Furniture, choose an item and place it on the grid. Drag to move; right-click or use Rotate to turn an item. Delete removes it. Furniture changes auto-save after two seconds, and Save remains available. Layouts lets you create, switch and delete designs; the default is protected. See the [editor guide](docs/editor.md) for controls and preview limits.

**Appearances:** use the agent's palette button and Apply. Portraits, the editor and map share the same recipe. A failed save is reported; keep the same `DATA_DIR` across rebuilds and restarts. The default source-runtime paths differ between development and compiled startup, so set the directory explicitly for production.

**Tasks and conversations:** select an agent and switch between Task, Conversation and Agent. The selected conversation stays selected as new work arrives. Load earlier records when needed; unknown run state and stale facts are labelled explicitly. Enter adds a line; Send or Ctrl/Cmd+Enter submits. Send follow-up queues without interrupting work. New conversation creates a session only when sent. If a send reports Outcome unknown, retry the original submission to reconcile its existing identity. Drafts stay in tab memory and clear on Lock or reload. Sending from the office does not post to the conversation's external channel.

## Docker

```sh
docker build -t openclaw-pixel-agents .
docker run --rm openclaw-pixel-agents npm run --silent control:key
```

Prepare a private, Git-ignored `.env` with your exact `CORS_ORIGIN`, `DATA_SOURCE=ingest` and `INGEST_API_TOKEN`, plus optional task settings. Run with persistent data:

```sh
docker run -d --name pixel-office \
  -p 3001:3001 --env-file .env \
  -e DATA_DIR=/app/data \
  -v pixel-office-data:/app/data \
  openclaw-pixel-agents
```

The image runs as a non-root user. The collector still runs on the OpenClaw host. Inside a container, `127.0.0.1` means the container itself; use a reachable Gateway endpoint satisfying the same transport rules. See [task access in Docker](docs/task-access-setup.md#docker).

## Configuration and troubleshooting

See the [configuration reference](docs/configuration.md) for environment variables, data-source fallback, persistent storage and reverse proxies.

| Symptom | Check |
| --- | --- |
| Roster updates but tasks are unavailable | Configure the separate Gateway connection, office key and scoped device grant. |
| Unlock fails | Use the key configured on this server; key generation alone does not rotate it. |
| Forbidden origin or changes fail | Include the exact browser scheme, hostname and port in `CORS_ORIGIN`; preserve the browser Origin header through your proxy. |
| Appearances/layouts differ after restart | Keep one persistent `DATA_DIR`; retain the Docker volume or service directory. |
| Empty production office | Check `/api/status`, the CLI path or collector delivery, and the configured agent IDs. Production has no demo fallback. |
| Asset requests return 429 | Check public request limits and proxy client-IP trust. The default allows 512 static/SPA requests per minute per IP. |

The roster/editor is not an individual-user login system. The separate task key protects private task and conversation access. Deploy the office on a trusted network or behind appropriate access controls.

## Development and releases

Built with React, TypeScript, Vite, Canvas 2D, Express and Socket.IO.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite client and backend with source watching |
| `npm run typecheck` | Browser and test TypeScript checks |
| `npm test` | Test suite |
| `npm run test:coverage` | Tests with coverage floors |
| `npm run build` | Compiled client and server |
| `npm start` | Built server; supply production configuration |
| `npm run --silent control:key` | Generate a fresh task-access key |
| `npm run test:package` | After building, pack/install/start the app in a disposable directory |

[CONTRIBUTING.md](https://github.com/SweetSophia/openclaw-pixel-agents/blob/main/CONTRIBUTING.md) covers local checks, browser testing and custom assets. [Release instructions](docs/releases.md) explain the `NPM_TOKEN` secret and GitHub Release workflow. Pull requests test the package without publishing; only publishing a stable GitHub Release triggers npm publication.

## License and assets

Code is [MIT licensed](LICENSE). Character art is from the [MetroCity pack by JIK-A-4](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack); the asset author's terms apply to the artwork.
