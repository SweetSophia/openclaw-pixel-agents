# Configurable agent rosters

## Intent and decisions

Let office operators configure their OpenClaw agent IDs and public display names
without changing source or rebuilding. The user accepted the recommended guided
setup plus an editable roster file with sensible defaults. This is the next
delivery after guided configuration, not an OpenClaw agent-creation feature.

The following are implementer proposals, subject to approval of this document:
apply changes on office restart, retain the existing eight-agent roster when no
file is configured, use a versioned JSON file selected by `AGENT_ROSTER_PATH`,
and keep roster administration out of the public browser dashboard.

## Approaches

- **Guided setup plus a file (selected):** extend the existing native terminal
  `configure` command to author a roster alongside the environment files. The
  same documented file can subsequently be edited by hand. This serves both new
  installations and existing npm, source and Docker installations.
- **File only:** smaller initial change, but leaves new users hand-authoring the
  configuration this onboarding work is intended to simplify.
- **Live browser administration or automatic discovery:** changes the authority
  and lifecycle model. The public dashboard has no general administrator login,
  and the registry also limits private task/workspace access. These are separate
  future features, not prerequisites for custom IDs and names.

The user selected the first approach; the alternatives and technical details
above are the implementer's assessment, not additional user requirements.

## Scope and anti-goals

- Support custom IDs and names in local CLI and remote ingest installations,
  including compiled/npm startup, without rebuilding the browser or server.
- Keep existing eight-agent defaults and saved preferences working unchanged
  when no custom file is selected.
- Never silently replace an explicitly configured but invalid roster with the
  built-in roster, merge omitted default agents into a custom roster, or broaden
  private task access because a session mentions an unregistered ID.
- Setup must not create/rename/delete OpenClaw agents, edit OpenClaw configuration,
  discover agents by invoking commands, start services, contact the Gateway,
  or rotate credentials. Do not add public roster-mutation endpoints.
- No hot reload, browser roster editor, arbitrary per-agent configuration,
  new dependencies, package publication or live deployment in this delivery.
  Tags, enabled state and appearance remain the existing office preferences.

## Configuration contract

`AGENT_ROSTER_PATH` is an optional absolute path on the **dashboard host**, not
on the collector host. An absent or empty value selects the existing defaults.
A nonempty relative or whitespace-only path is an actionable startup error.
There is no implicit lookup in the package directory, current directory or
`DATA_DIR`, and no `~` expansion. Existing environment variables retain their
current precedence over `--env-file` values.

The UTF-8 JSON file has this exact version-1 shape:

```json
{
  "version": 1,
  "agents": [
    { "id": "main", "name": "Coordinator" },
    { "id": "researcher", "name": "Research Assistant" }
  ]
}
```

Proposed bounds are 1–50 entries and a maximum file size of 64 KiB. Entries have
only `id` and `name`; the top level has only `version` and `agents`. Reject wrong
types, unsupported versions, unknown fields, duplicate IDs and reserved object keys.
An empty custom roster is an error, not a request to restore the defaults.

IDs are exact, case-sensitive OpenClaw identities: 1–64 ASCII letters, digits,
underscores or hyphens, beginning with a letter or digit. This matches existing
private-task validation and is compatible with client live-sync validation. Reject
`__proto__`, `constructor` and `prototype`. Never silently lowercase, alias,
truncate or derive IDs from names. Explain that IDs must match OpenClaw and that
changing an ID creates a different office identity; display-name edits do not.

Names are public, trimmed, nonempty Unicode text, at most 128 UTF-16 code units,
without C0/C1 controls or Unicode line/paragraph separators. The wizard trims
input; file validation rejects noncanonical surrounding whitespace rather than
silently rewriting the file. Names are labels, not HTML, paths, session keys,
authorization subjects or executable input. Never echo unsafe rejected text in
terminal diagnostics. Report a field/index and reason, not the file contents.

Explicit files must be readable regular files, read with a byte bound rather
than an unbounded `readFileSync`. Missing, unreadable, nonregular, oversize or
invalid files cause a nonzero exit before listening, polling or Gateway startup.
Do not mutate or repair the roster file during reads. Load once per process;
edit, validate by restarting, and roll back the file if startup rejects it.

## Guided setup and later editing

Extend `configure`, leaving `setup` read-only. Explain that the roster lists
existing OpenClaw identities and names, not new OpenClaw agents. Offer the
existing eight-agent roster by default; alternatively ask for a count and each
ID/name with bounded validation and duplicate-ID re-prompts. Do not inspect
existing credentials or run discovery commands to populate answers.

New bundles contain `agents.json` as well as `office.env` and, in remote mode,
`collector.env`. Even accepting defaults writes the complete eight-entry roster
so the generated setup is subsequently editable. `office.env` sets the absolute
`AGENT_ROSTER_PATH` to that bundle's file. `collector.env` contains no roster
path: the collector transports sessions and the dashboard owns their admission.

Preview the ID/name list, destination and existing redacted environment preview
before the existing explicit save confirmation. Preserve all current guarantees:
no writes on cancellation, new directory only, private POSIX permissions,
exclusive file creation, owned-artifact-only cleanup, repeated destination
collision retries, retained answers and no credentials printed. On destination
retry regenerate the roster path for the new bundle while preserving the list.
Extend the fixed filename allowlist only for `agents.json`.

After saving, print where to edit the roster and that changes require restarting
the office, not a rebuild or collector reconfiguration. Later edits are manual;
rerunning `configure` remains create-only and does not overwrite an existing
bundle or silently rotate its credentials. Existing installations can create
their own file and add the single environment variable without regenerating
their entire setup. Document absolute host paths and read-only file mounts for
Docker, and that an ambient `AGENT_ROSTER_PATH` overrides an env-file value.

## Registry, state and compatibility

Extract roster policy from `server/index.ts` into a focused module. Load and
validate before constructing the registry, applying persisted preferences, or
starting runtime connections. Use one reusable schema/validation implementation
for wizard output and server input, compatible with the native ESM CLI and the
compiled CommonJS server. The builder chooses the smallest compatible module
arrangement; all required runtime assets must ship in build, npm and Docker.

An explicit roster **replaces**, rather than extends, the built-in list. For IDs
matching built-in agents, preserve their built-in default tags and recipes while
taking the configured name. New IDs start enabled, without tags (the existing
room resolver selects Office), with the existing safe default appearance.
Persisted enabled/sprite/tag/recipe preferences override those defaults by ID;
the configured display name remains authoritative. Make default-recipe and
palette lookups own-key-safe, including valid IDs such as `toString`.

Removing an ID removes its runtime/public state and private-access eligibility
after restart, but does not delete its saved preferences or saved layout seats.
Preference saves must retain previously loaded, validated preferences for absent
IDs as well as current registered agents. Re-adding the same ID restores them;
invalid persisted records remain rejected. Preserve existing atomic-write and
durability-error handling. No migration rewrites or preference garbage collection.

Custom IDs without saved seats use the existing reachable-floor temporary-seat
behavior. Do not add or persist furniture/seats merely to configure a roster.
There is a destructive legacy `shodan` → `main` seat normalization in
`server/validation.ts`. Replace it with a **non-destructive seat-lookup fallback**:
keep literal validated seat keys in the layout contract and persistence. An exact
`main` seat wins; only when that key is absent and `shodan` is not a registered
agent may `main` temporarily use the old `shodan` coordinate. A real custom
`shodan` always uses its own identity. Never persist the derived fallback as a
new `main` seat or delete the source key merely because the roster changed.

This is the implementer's resolution of the builder check's sole important
question: if custom `shodan` is removed and later re-added, its saved seat must
survive intervening reads and saves. Current registry context cannot distinguish
an absent custom identity from a historical alias, so aliasing must not rewrite
stored identity. Existing old layouts retain their visual placement without
destructive canonicalization. Adjust characterization tests for literal seat keys
and test the rendering/lookup compatibility instead. Do not add a history store,
provenance flags, new configuration options or weakened layout validation.

The existing registry continues to drive CLI snapshots, ingest admission,
preference mutation targets and private task/workspace allowlists. Unknown ingest
IDs remain rejected, not automatically enrolled. Document that a remote roster
must include every agent whose sessions the collector submits; visibility is
controlled separately with the existing enabled preference. Preserve canonical
agent/session ownership, transport, device scopes and independent private keys.
Adding a public roster entry does not grant Gateway permissions or create a
private task target by itself.

## Evidence required before completion

- Parser and bounded loader tests: schema/version/field errors, cardinality,
  duplicate/reserved IDs, control text, Unicode names, maximum lengths and bytes,
  missing/nonregular/unreadable files, and no unsafe diagnostic echo.
- Server tests: unchanged defaults, complete replacement, configured names in
  active and sleeping states, CLI and ingest with custom IDs, unknown-ID denial,
  known-only private access and unchanged ownership checks. Startup failure must
  precede listener/poller/Gateway activity, not merely return a validation error.
- Persistence/layout tests: rename keeps settings; removal, another preference
  save and re-addition preserves orphan settings/seats; custom `shodan` and
  `main` seats stay distinct while old default layouts retain compatibility.
  Remove `shodan`, save a layout, restart, and re-add it to prove preservation;
  exact `main` coordinates must outrank the non-persisted legacy fallback.
- Wizard tests: default/custom lists, input retries, safe preview, cancellation,
  no clobber, permissions/cleanup, collision retries and path recomputation.
  Include a real terminal exercise, not injected answers alone.
- Installed-tarball smoke: configure a non-built-in ID, start from a different
  working directory, observe its configured name through the real API/socket,
  edit only the roster, restart the same installation and observe the new name
  without rebuilding. Invalid configuration must fail closed. Exercise both
  source/compiled and installed module resolution, plus mounted Docker startup.
- Browser check: a custom-ID agent has a portrait, selectable character/details
  and usable seat behavior; names render as text. Do not claim large-roster
  rendering performance or live Gateway compatibility from unit tests alone.
- Full existing typecheck, tests, coverage floors, build, package smoke and both
  audit gates remain unchanged. Review actual bot findings before integration;
  publication/deployment requires a separate decision.

## Remaining builder choices

Exact small-module placement, prompt wording, test fixture organization and the
minimal module-format/build plumbing are left to the builder. The bounds,
startup/restart policy, replacement semantics and no-clobber/preservation rules
above are implementer choices for the user to approve, not unspecified behavior.
