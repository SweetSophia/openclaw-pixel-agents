# Guided configuration design

## Intent and scope

Make first installation usable without hand-authoring environment files. The user
approved both local OpenClaw and remote collector setups, optional private
Task/Gateway guidance, preview before saving, preservation of existing settings,
and no automatic device approval or write controls. The user accepted proceeding
with recommended defaults rather than further design questions.

This is configuration generation, not an OS installer. It does not install Node,
OpenClaw, services, reverse proxies, certificates or a configurable roster. It
does not start the office, execute OpenClaw, contact a Gateway, read existing
credentials, pair devices, send requests or publish a package.

## Approach and ownership of decisions

Use a new `openclaw-pixel-agents configure` terminal command, implemented with
Node built-ins in the existing JavaScript CLI. Keep `setup` read-only and keep
manual configuration supported. This is the implementer's recommendation, not a
user-specified command name. A browser wizard would need an additional
unconfigured server/security boundary; changing `setup` into a writer would break
its explicit contract. Neither is needed for this delivery.

The implementer chooses create-only bundles rather than editing existing dotenv
files: a new directory containing `office.env`, and in remote mode `collector.env`.
This avoids ambiguous dotenv merges and unintended credential rotation. Existing
files/directories/symlinks cause refusal, never replacement. Users reconfiguring
an office can generate a separate bundle and deliberately migrate values manually.

## Flow

1. Require an interactive terminal for input and output. Help remains usable in
   scripts. Explain scope and that no existing configuration will be loaded.
2. Ask for local or remote mode, listener port (default `3001`), exact browser
   origin (canonical `http://localhost:<port>`, omitting the default port 80), and new
   output directory (default `.openclaw-pixel-agents-config` under the user's home,
   outside an ordinary source checkout; changed after independent security review).
   Relative directory answers resolve under home. Reject occupied destinations
   at this prompt, retaining exclusive mkdir as the real save-time guard. Then
   ask for stable absolute `DATA_DIR`, defaulting to `<bundle>/data` to isolate
   independent offices. Existing state is reused only by explicit path selection.
3. Local: allow the default `openclaw` resolved through runtime PATH or a supplied
   absolute `OPENCLAW_BIN`. Native Windows requires an explicit directly executable
   binary, not batch shims or the implicit PATH command. Remote: accept fully absolute POSIX, Windows drive and
   UNC executable paths independently of the dashboard OS; actual host execution
   remains unverified; reject Windows batch shims rather than enabling a shell.
   Ask for the dashboard's collector-accessible
   base URL and the absolute OpenClaw executable path on the remote host. Do not
   claim to verify a remote path. Validate collector URL with the collector's
   existing `getIngestEndpoint` policy. Generate an independent cryptographically
   random 32-byte ingest token and use it in both files.
4. Offer private access (default no). If chosen, ask for a Gateway URL, defaulting
   to `ws://127.0.0.1:18789` only in local mode; require an explicit remote URL.
   Match the runtime endpoint policy: encrypted remote connection, loopback-only
   unencrypted connection, no embedded credentials/query/fragment. Generate a
   separate 32-byte office key. Do not ask for Gateway bootstrap credentials.
   Set send, approvals and Tailnet HTTP exceptions explicitly false.
5. Preview absolute output paths and non-secret settings, with tokens redacted
   and collector/Gateway URL paths omitted. URL entry itself is visible; warn
   users not to enter secrets in URL paths.
   Say remote collector settings belong on the OpenClaw host and that local
   validation does not establish connectivity. Ask explicit save confirmation,
   default no. EOF, Ctrl+C, refusal or validation failure before confirmation must
   create nothing. Re-prompt invalid input without echoing unsafe control text.
6. After confirmation, exclusively create the bundle directory with POSIX mode
   `0700` and its files with `0600`; no recursive parent creation. Refuse existing
   destinations, including dangling symlinks, and never truncate existing files.
   On a save-time collision, ask for another directory/data path and require a
   fresh preview/confirmation without losing the other answers.
   On an ordinary write failure remove only this operation's created files and
   directory; retain the original failure. Warn that sudden process/machine loss
   can leave a partial new bundle; never overwrite it on retry. On Windows explain
   that POSIX modes do not establish ACL privacy and the user must secure access.
7. Print startup and collector dry-run commands with shell-safe paths. Use Node's
   `--env-file` for collector loading, not shell `source`. Print where to retrieve
   the office key privately, not its value. Explain explicit environment variables
   override env-file values, public roster does not enable tasks, and configuration
   does not establish a successful connection. Link existing pairing guidance;
   bootstrap credentials remain a separate manual server-only step.

## Boundaries and constraints

- No new dependencies or server/browser APIs; Node `^22.22.2 || ^24.15.0 || >=26.0.0`.
- `setup`, `--help`, `--version`, `--generate-key`, existing startup and read-only
  install notice keep their behavior. Reject configure mixed with startup/key/
  version options rather than accidentally starting the server.
- Do not read ambient configuration or secrets as wizard defaults. Ambient
  variables still override files at subsequent normal startup; explain this.
- Validate port as an integer in `1..65535`, exact HTTP(S) origin without path,
  credentials/query/fragment, and platform-absolute paths. Do not imply an origin
  setting binds the listener to loopback or provides network authentication.
- Reject newline, NUL, Unicode line/paragraph separators and terminal control characters in entered values. Dotenv
  encoding must round-trip with `node:util.parseEnv`; never use JSON backslash
  escaping as dotenv escaping. Quote values with a delimiter absent from the
  value; reject dotenv values containing both quote kinds at their field prompts.
  Output directory names are not dotenv values and may contain both quote kinds.
- Keep new files explicitly included in the npm allowlist and package smoke
  assertions; do not broaden the package to all `bin/**` or include private data.
- Fixed roster remains a separate follow-up. No npm publication or live deployment.

## Architecture

`bin/configure-values.mjs` validates answers, builds environment maps and serializes
dotenv/preview output. `bin/configure-files.mjs` owns exclusive private bundle
creation and cleanup. `bin/configure.mjs` owns the prompt lifecycle and handoff
instructions. The existing launcher only dispatches the new command. Keep these
units small; do not introduce a generic forms framework or plugin system.

## Evidence path

Use real temporary filesystem tests for no-clobber and permissions, dotenv
round-trips for exact values, and contract tests against runtime/collector URL
policies. Exercise prompts through injected input/output boundaries and a real
pseudo-terminal probe, including cancellation and redaction. Install the actual
tarball and run the new command there: source-only tests cannot establish npm
inclusion. Existing server/collector tests, full coverage/types/build/audits and
package smoke guard unrelated behavior. Synthetic configuration checks do not
qualify a real Gateway, remote host, service or published artifact.
