# npm onboarding

The user approved three instruction surfaces: first-run guidance, a repeatable setup command, and a short install notice. This work implements that accepted scope in the existing Node launcher.

## Approach

Install-only instructions are unreliable when npm hides or disables scripts. First-run guidance and an explicit `setup` command remain available with scripts disabled. The install hook prints only a short pointer to that command.

Setup is an informational checklist rather than a configuration writer. This is an implementation choice for the requested instruction feature: it lets users select their deployment and preserves existing keys, files and device grants. Automatic configuration generation is outside this change.

## Behavior

- `openclaw-pixel-agents setup` prints configuration, persistent data, local/remote roster, optional office-key/Gateway pairing, startup and browser-URL instructions, then exits successfully. It neither reads an env file nor starts the server.
- A normal launch loads an explicitly supplied env file as before. If `CORS_ORIGIN` is absent or blank, it prints actionable setup instructions and exits unsuccessfully without importing or starting the server. This preserves failure signaling for service managers.
- Configured launches retain existing environment precedence, production mode and default persistent data directory. Optional private access is not required for roster-only use.
- Help advertises setup. Version and key-generation output remain machine-readable. Unknown positional commands and unsupported setup/options combinations fail without starting anything.
- The optional postinstall hook prints a brief setup pointer, without network requests, credential generation, filesystem writes or server startup. Instructions remain available when the hook is suppressed.

## Constraints and evidence

Keep Node `^22.22.2 || ^24.15.0 || >=26.0.0`, existing dependencies, README screenshot markup/images, data and Gateway scopes unchanged. Add only the exact new runtime files to the package allowlist and its smoke-test policy.

Real child-process tests cover setup, missing configuration, invalid commands and credential-safe output. A disposable tarball consumer verifies setup and first-run guidance with install scripts disabled, the notice when scripts run, and unchanged configured startup/assets/key generation/ingest/restart persistence. Run repository typecheck, coverage, build, package smoke and audits before delivery. No real agent task or production configuration is touched.
