# User-first installation documentation

## Approved direction

The user approved a README/configuration quickstart first, with the guided installer and configurable roster reserved for a separate follow-up. This is a documentation-only change for people who want to use the office, not develop it.

## Approach

Lead with the existing prebuilt npm package, a complete minimal configuration, the production startup command and browser URL. Keep detailed configuration in `docs/configuration.md`; put cloning, development and source builds near the bottom of the README. This improves the existing supported path without introducing an installer or changing runtime behavior. The alternatives—an interactive configuration writer or configurable roster—require separate code, security review and release qualification and are not part of this delivery.

## Required reader outcome

- Find the recommended installation path immediately after the introduction/screenshots, before the long feature list.
- Know the supported Node.js range: `^22.22.2 || ^24.15.0 || >=26.0.0`.
- Install with `npm install --global openclaw-pixel-agents@latest`, then check the installed version.
- Manually save a private `pixel-agents.env` containing `PORT=3001`, `CORS_ORIGIN=http://localhost:3001` and `DATA_SOURCE=cli`.
- Start from that file's directory with `openclaw-pixel-agents --env-file ./pixel-agents.env`, then open `http://localhost:3001`. Explain changing directory or supplying a quoted path if the file is elsewhere, environment precedence and stopping with Ctrl+C.
- Understand that OpenClaw must be on the same host/in PATH for this example, with `OPENCLAW_BIN` available for an alternate executable path. Link remote users to the collector path instead of implying local polling discovers a remote host.
- Understand that the launcher defaults storage to `~/.openclaw-pixel-agents`; service accounts need a stable absolute `DATA_DIR`. Do not copy the relative `DATA_DIR=./data` example into the minimal user path.
- Know that `setup` prints instructions only, private Task access/pairing is optional and separate, and no key or permission is automatically provisioned.
- See the existing fixed-roster limitation and its source-customization link; do not promise automatic discovery or a usable arbitrary roster.

## Compatibility and safety

Preserve existing public section anchors, including `start-from-source`, `run-a-production-build`, `npm-installation`, `setup-instructions` and `create-your-task-access-key`. Preserve developer commands, existing security warnings, collector/private-access boundaries and the environment reference table. Keep source-only features distinct from npm releases: registry `latest` was verified as 1.7.0 on 2026-11-02; that is an observation, not a permanent latest-version promise. Do not install globally, write real configuration/credentials, contact the real Gateway, deploy or publish during verification. Do not modify runtime code, package/version/dependencies, the launcher, roster implementation, agent instructions or unrelated user changes.

## Validation

Check README ordering, complete minimal examples, retained anchors, relative links and both document surfaces against the actual launcher/configuration contract. Run launcher help/setup checks and the repository's normal local gate before any proposed PR. Use disposable synthetic package-startup checks only; passing those is not live OpenClaw acceptance. English-only docs are in scope; there are no parallel translated root READMEs to synchronize.
