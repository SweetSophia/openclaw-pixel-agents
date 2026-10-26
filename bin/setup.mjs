export const setupInstructions = `OpenClaw Pixel Agents setup
Run this guide again: openclaw-pixel-agents setup
From a source checkout's root: node bin/openclaw-pixel-agents.mjs setup

1. Create a private configuration file, for example pixel-agents.env:

   PORT=3001
   CORS_ORIGIN=http://localhost:3001
   DATA_SOURCE=cli

   CORS_ORIGIN must match your browser's exact scheme, hostname and port.
   Keep the file private (chmod 600 on POSIX). Do not commit credentials.
   DATA_DIR defaults to ~/.openclaw-pixel-agents and survives package updates.
   For a service or custom directory, set DATA_DIR to a stable absolute path.

2. Connect the office roster:
   Local OpenClaw: put openclaw in PATH or set OPENCLAW_BIN to its full path.
   Remote OpenClaw: use DATA_SOURCE=ingest, configure a separate INGEST_API_TOKEN,
   and run the collector on the OpenClaw host. Roster updates do not enable tasks.

3. Optional Task, Results, Workspace and Conversation access:
   Generate an office key explicitly:
     openclaw-pixel-agents --generate-key
   From a source checkout's root:
     node bin/openclaw-pixel-agents.mjs --generate-key
   Add these settings to your private configuration:
     OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
     PIXEL_CONTROL_TOKEN=PASTE_THE_GENERATED_OFFICE_KEY
     CONTROL_SEND_ENABLED=false
   The loopback URL assumes OpenClaw is on this host; use wss:// for a remote Gateway.
   Follow the pairing guide to approve the office device for operator.read.
   Paste the office key into Unlock task details in the agent's Task tab.
   Keep Gateway bootstrap credentials on the server; never paste them in the browser.
   Sending is optional and additionally requires operator.write and explicit enabling.

4. Start the office with your configuration:
     openclaw-pixel-agents --env-file /absolute/path/to/pixel-agents.env
   From a source checkout's root:
     node bin/openclaw-pixel-agents.mjs --env-file /absolute/path/to/pixel-agents.env
   Open http://localhost:3001 for the example above; adjust the URL if configured differently.

This guide does not create files, generate keys, pair devices or start the office.
Installation and collector: https://github.com/SweetSophia/openclaw-pixel-agents#readme
Pairing and private access: https://github.com/SweetSophia/openclaw-pixel-agents/blob/main/docs/task-access-setup.md`;
