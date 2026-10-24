# Set up private task access

This guide is for the person running an OpenClaw Pixel Agents office. Each installation chooses its own access key. If you are visiting somebody else's office, ask its operator for the key; generating a different key will not unlock that installation.

The office access key is the value of `PIXEL_CONTROL_TOKEN`. It protects task details and conversation controls in Pixel Agents. OpenClaw Gateway authentication and the office's paired device grant are configured separately below. The collector's ingest token has a separate purpose too.

## 1. Generate your office key

From the repository directory, run:

```sh
npm run --silent control:key
```

With an npm installation, run `openclaw-pixel-agents --generate-key` instead. The installed launcher uses the same generator; no source checkout is needed.

The command prints one new 64-character hexadecimal key using 32 cryptographically secure random bytes from Node's `crypto.randomBytes`. It works wherever the project's supported Node.js version runs, including Windows, macOS and Linux. It does not read an existing key, write a configuration file, or rotate a running server's credentials.

Save the output in your private server configuration as `PIXEL_CONTROL_TOKEN`. Keep the same value to paste into **Unlock task details**. Share it only with people authorized to read private conversations and, when enabled, send messages. The current office uses one shared operator key rather than individual user accounts.

Keep keys out of commits, browser URLs and `VITE_*` variables. This repository does not use a universal key or a developer-specific key file location.

## 2. Configure the office server

You can use your service manager's environment or the supplied [.env.example](../.env.example). For a local installation, copy that file to `.env`, generate the key above, and fill in its empty `PIXEL_CONTROL_TOKEN` value. Restrict the file to the account running the server; on POSIX hosts, `chmod 600 .env` does that. `.env` is ignored by Git.

The example starts with:

```dotenv
NODE_ENV=production
PORT=3001
DATA_DIR=./data
CORS_ORIGIN=http://localhost:3001
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
PIXEL_CONTROL_TOKEN=
CONTROL_SEND_ENABLED=false
CONTROL_ALLOW_TAILNET_HTTP=false
```

Set `OPENCLAW_GATEWAY_URL` to your own Gateway. The loopback example assumes both processes run on the same host; a remote Gateway requires an encrypted `wss://` endpoint. Use a stable, private `DATA_DIR` so device credentials survive application builds and restarts. With the example above, run the server from the repository directory so `./data` keeps the same location.

The server does **not** automatically load `.env`. Existing process environment variables take precedence over values in an env file, so update or unset an older exported key when changing it. After installing dependencies and building, explicitly load the file with Node:

```sh
npm ci
npm run build
node --env-file=.env dist/server/server/index.js
```

For a global npm installation, create a private env file with the values above and start with `openclaw-pixel-agents --env-file /absolute/path/to/.env`. The bundled server is already built. Set a stable absolute `DATA_DIR`, or omit it to use the launcher's `~/.openclaw-pixel-agents` default. The launcher always runs in production mode.

Open `http://localhost:3001` for this local example. For a remotely accessed office, use HTTPS and replace `CORS_ORIGIN` with its exact browser origin, such as `https://office.example.com`. Follow the [reverse-proxy instructions](configuration.md#reverse-proxy-deployments) when TLS terminates at a proxy.

### Development

For the Vite client, set `NODE_ENV=development` and `CORS_ORIGIN=http://localhost:3000` in your private `.env`. Start the backend with explicit environment loading:

```sh
node --env-file=.env --import tsx server/index.ts
```

In another terminal, run `npm run dev:client` and open `http://localhost:3000`. This backend command does not watch for source changes; restart it after editing. `npm run dev` remains available when you supply the variables through the parent process environment instead.

## 3. Pair the office with OpenClaw

On first use, temporarily supply the server-only credential matching your Gateway's authentication mode: `OPENCLAW_GATEWAY_TOKEN` or `OPENCLAW_GATEWAY_PASSWORD`. Obtain it from your own Gateway's operator configuration. The office key generated in step 1 is not the credential for this step.

Start the office with those variables. It creates its own Ed25519 identity under `DATA_DIR/control/` and requests `operator.read`. If OpenClaw requires pairing, inspect the pending request in the Gateway device administration UI, or run these commands on the Gateway host:

```sh
openclaw devices list
openclaw devices approve <request-id>
```

Confirm the request belongs to this Pixel Agents office and has the intended scopes before approving it. Restart the office to retry the connection. Once it has connected successfully and saved its scoped device grant, remove the temporary Gateway bootstrap credential and restart again. It then uses its own stored grant. Do not delete or copy another client's identity to bypass pairing.

For sending messages, set `CONTROL_SEND_ENABLED=true` and pair/approve the same office device with `operator.read` plus `operator.write`. A cached read-only grant keeps reads working while sending remains disabled; temporarily supply the bootstrap credential again to request the upgrade, then remove it after the updated grant is stored.

## 4. Unlock task details

Open an agent's **Task** tab and paste the **office key from step 1** into **Unlock task details**. It is retained only in that browser tab. Lock or reload clears it.

If the office URL uses HTTP, private access is normally available only from loopback. An operator using a direct encrypted Tailscale connection can explicitly enable `CONTROL_ALLOW_TAILNET_HTTP=true`; this requires actual direct Tailnet endpoints and does not allow ordinary LAN/public HTTP. HTTPS remains the normal remote setup.

## Docker

The runtime image includes the key generator. From the repository root, build your image with an explicit tag, then generate a key without needing Node on the host:

```sh
docker build -t openclaw-pixel-agents .
docker run --rm openclaw-pixel-agents npm run --silent control:key
```

Pass `PIXEL_CONTROL_TOKEN`, your Gateway URL, the exact office `CORS_ORIGIN` and optional control settings through the container's environment or a private `--env-file`. Persist `/app/data` as a volume, including its `control/` device files. Inside a container, `127.0.0.1` refers to that container; use a reachable Gateway endpoint satisfying the same TLS/loopback policy rather than copying the host-only URL blindly. Keep the existing ingest/collector configuration for the office roster.

Docker's `--env-file` supplies process variables; it does not depend on the server reading a `.env` file. Use `DATA_DIR=/app/data` in the container even if your host example uses `./data`.

## Rotate or troubleshoot

- **Rotate the office key:** generate a new value, replace `PIXEL_CONTROL_TOKEN`, restart the office, and share the new value with authorized users. Existing tabs must unlock again. Keep the device identity and grant; rotating this office key does not require deleting them.
- **Task access is not connected:** check that both `OPENCLAW_GATEWAY_URL` and `PIXEL_CONTROL_TOKEN` reached the actual server process.
- **Unlock failed:** paste the value configured on that server. Generating another value alone does not change the server's key.
- **Pairing/scope error:** inspect the Gateway's pending device request and bootstrap authentication, and verify that the granted scopes match read-only or sending access.
- **Secure connection required:** use HTTPS, loopback development, or the explicitly configured direct-Tailnet exception.
- **Forbidden origin:** set the exact browser origin in `CORS_ORIGIN` and preserve the browser's `Origin` header through any reverse proxy.
- **Connected roster but unavailable tasks:** the collector feed and private Gateway connection are independent. Check the task connection and device grant separately.
