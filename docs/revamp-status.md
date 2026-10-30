# Revamp status

First-phase closeout recorded on 2026-10-26 against source and verified live runtime revision `ad7acb3`
(Usage PR #323, dependency PR #324 and reconnect reliability PR #326).
This tracker separates merged source, recorded deployment evidence and work still
requiring qualification. A source merge does not establish what a live office or
an already published npm package is running.

The user subsequently authorized the seven-delivery [phase-two plan](superpowers/plans/2026-10-26-revamp-phase-two.md), starting with npm 1.7.0 publication. That work is tracked below; the first-phase evidence remains historical.

## Merged and source-verified

| Scope | Delivery evidence | Recorded runtime status |
| --- | --- | --- |
| Live activity and canvas Fit/zoom/pan | [#279](https://github.com/SweetSophia/openclaw-pixel-agents/pull/279), [#293](https://github.com/SweetSophia/openclaw-pixel-agents/pull/293); [canvas plan](superpowers/plans/2026-10-22-canvas-controls.md) | Included in the later backed-up, verified Task and Workspace rollouts. |
| Task details and private conversations/follow-ups | [#294](https://github.com/SweetSophia/openclaw-pixel-agents/pull/294), [#295](https://github.com/SweetSophia/openclaw-pixel-agents/pull/295), [#296](https://github.com/SweetSophia/openclaw-pixel-agents/pull/296); [task-controls plan](superpowers/plans/2026-10-23-task-controls.md) | Both deliveries recorded live read acceptance with preserved state; the real-task send check was handed to the user. |
| Restart-safe appearances and portrait/map consistency | [#300](https://github.com/SweetSophia/openclaw-pixel-agents/pull/300), [#301](https://github.com/SweetSophia/openclaw-pixel-agents/pull/301) | Included in the subsequently qualified Workspace runtime and 1.6.0 release. |
| Results and delivered files | [#304](https://github.com/SweetSophia/openclaw-pixel-agents/pull/304); [Results plan](superpowers/plans/2026-10-24-results-files.md) and [1.5.0 notes](releases/1.5.0.md) | Recorded backed-up deployment verified Results, the roster and existing read/send capability without sending a task. |
| Read-only Workspace and recovery follow-ups | [#310](https://github.com/SweetSophia/openclaw-pixel-agents/pull/310), [#311](https://github.com/SweetSophia/openclaw-pixel-agents/pull/311), [#312](https://github.com/SweetSophia/openclaw-pixel-agents/pull/312), [#313](https://github.com/SweetSophia/openclaw-pixel-agents/pull/313); [Workspace plan](superpowers/plans/2026-10-25-workspace-panel.md) and [1.6.0 notes](releases/1.6.0.md) | PR #310 records runtime-only deployment and live Workspace/Results acceptance with saved state and credentials preserved. |
| Install notice and first-run/setup instructions | [#315](https://github.com/SweetSophia/openclaw-pixel-agents/pull/315); [onboarding plan](superpowers/plans/2026-10-26-npm-onboarding.md) | Source and packaged-consumer qualification passed. Available from source; already published npm 1.6.0 predates these instructions. No new npm publication occurred. |
| Conversation Usage | [#323](https://github.com/SweetSophia/openclaw-pixel-agents/pull/323); [Usage plan](superpowers/plans/2026-10-26-usage-panel.md) | Source qualification passed: 1,407 tests, required CI, Docker, package smoke and synthetic browser checks. Initial live acceptance at `cf1dceb` and repeat acceptance after the `ad7acb3` reliability rollout both reached Ready. No npm publication occurred. |
| Private access after Gateway startup refusals | [#326](https://github.com/SweetSophia/openclaw-pixel-agents/pull/326); [access recovery guidance](task-access-setup.md) | Bounded retry recovers explicitly retryable startup refusals and service restart closures without restarting the office process. Authentication/scope failures remain terminal. Qualified with 1,411 tests, a compiled synthetic HTTP recovery probe and live `ad7acb3` acceptance. |

The older plans' completion checkboxes are reconciled with their merged PRs and
recorded release ledgers. Fresh 2026-10-26 runtime acceptance is recorded below;
older feature-specific results remain historical evidence.

## Closeout tasks

This document reconciles the plans with their source and delivery evidence. The
accompanying documentation PR records its own review and verification; its
temporary branch, review deadline and merge state belong in the execution ledger.

| Task | State and owner | Branch/PR | Evidence or next gate |
| --- | --- | --- | --- |
| Qualify dependency maintenance | Complete — Codex coordinator | [#324](https://github.com/SweetSophia/openclaw-pixel-agents/pull/324), squash merge `90e78a7` on 2026-10-26 at 18:27:11 UTC. Original PRs [#316](https://github.com/SweetSophia/openclaw-pixel-agents/pull/316)–[#322](https://github.com/SweetSophia/openclaw-pixel-agents/pull/322) are closed as superseded. | The full 15-minute review window elapsed before merge. Independent review, 1,407 local tests, package smoke, Docker on Node 26.12.1, required CI/security checks, Kody and Sourcery passed. A clean fresh independent review replaced Kilo's provider-rate-limit failure. The merged tree matches reviewed head `8301f68`. The subsequent `ad7acb3` rollout installed the full qualified dependency tree alongside the runtime. |
| Harden transient Gateway startup recovery | Complete — Codex coordinator | [#326](https://github.com/SweetSophia/openclaw-pixel-agents/pull/326), squash merge `ad7acb3` on 2026-10-26 at 19:28:31 UTC | Independent reviews, 1,411 tests, coverage/types/build/package/audits, required CI, Docker, CodeQL, Kody and Sourcery passed. A clean fresh independent review replaced unavailable Kilo. The reset 15-minute review window elapsed before merge; post-merge main CI and CodeQL passed on `ad7acb3`. |
| Qualify the current runtime and roll out merged additions | Complete — Codex runtime audit/coordinator | Exact merged source `ad7acb3`; operator backup/rollback record retained | Independently reviewed deployment installed the tested runtime and full qualified dependencies. Fresh roster, private Usage/Results/Workspace, read/send capability and exact-client checks passed. Saved preferences/layouts and current credentials were preserved. No real task was sent. |
| Publish onboarding and Usage to npm | Complete — Codex release author/coordinator | [#327](https://github.com/SweetSophia/openclaw-pixel-agents/pull/327), merged `57dbf4b`; [v1.7.0 release](https://github.com/SweetSophia/openclaw-pixel-agents/releases/tag/v1.7.0), published 2026-10-26 | npm 1.7.0 is already published; registry version and integrity were rechecked on 2026-10-28. See [1.7.0 notes](releases/1.7.0.md). That artifact predates run history and Stop/Steer. |

For each new or updated PR, the coordinator records its exact pushed revision,
independent review, 15-minute review deadline, checks and findings. Every push
restarts that window. An unavailable bot is replaced by a fresh independent
review; failing enforced checks or repository protections remain blockers.

### Runtime recovery and delivery

The read-only audit on 2026-10-26 found the older runtime `4dd179f` with a fresh
public roster but a private `auth-error`. Independently reviewed office-only
recovery at 18:14:54 UTC restored read/send capability while retaining the same
runtime, credentials and scoped device grant.

At 18:18:20 UTC, an independently reviewed runtime-only deployment installed exact
merged revision `cf1dceb`. A fresh backup and rollback record were retained. Saved
preferences/layouts and current credentials were preserved. Post-deployment
acceptance verified eight fresh roster agents, read/send capability, Workspace,
ready Results files, a repeat Usage read reaching Ready, and the exact tested
client build. The collector remains active and retired previews remain disabled.

Native Chromium confirmed six tabs, a locked Usage panel until the access key is
entered, and no browser exceptions. That initial acceptance did not establish
recovery across a later Gateway restart. Private access was later unavailable
after an external restart despite a valid retained grant. No retained native
response establishes the exact rejection behind that live incident.

Source inspection and synthetic tests confirmed that retryable startup refusals
could be misclassified as terminal. PR #326 fixes that classification with bounded
reconnect policy while preserving terminal authentication/scope failures. A
compiled synthetic recovery probe observed HTTP connecting → ready → unavailable
→ ready and transient service
closures 1012/1013 with the same grant, scopes and signed device authentication.
It required no office-process restart, real task, session creation or live Gateway
restart. Untrusted retry hints select only a fixed bounded delay policy.

The reviewed rollout staged all 271 qualified packages with matching fingerprints,
file modes, relative executable links and module resolution, then passed an
isolated loopback startup/assets check with Gateway access disabled. At about
19:30 UTC, the independently reviewed deployment installed exact source `ad7acb3`
and the full qualified `node_modules`, retaining rollback copies of both runtime
and dependencies. Saved preferences/layouts and current credentials were preserved.

Repeat live acceptance at 19:32 UTC verified Ready Usage and Results, Workspace,
eight fresh roster agents, read/send capability, the exact tested client, an active
collector and disabled retired previews. No real task was sent. The earlier
`cf1dceb` snapshot remains historical; the current qualified live revision and
dependency tree are `ad7acb3`. At first-phase closeout, npm remained 1.6.0 and
onboarding/Usage publication was separate release work. Phase two now authorizes
that publication, which subsequently completed as npm 1.7.0. These historical
runtime checks do not establish a later run-history or Stop/Steer deployment.

## Phase-two tasks

The user explicitly authorized the previously proposed roadmap after the first
phase was complete. The [phase-two plan](superpowers/plans/2026-10-26-revamp-phase-two.md)
records dependencies, acceptance criteria and the shared verification/review
contract. The coordinator owns integration and merge decisions.

| Order | Delivery | State / owner | Branch or next gate |
| --- | --- | --- | --- |
| 1 | New npm release | Complete — Codex release author/coordinator | [#327](https://github.com/SweetSophia/openclaw-pixel-agents/pull/327), `57dbf4b`, published [v1.7.0](https://github.com/SweetSophia/openclaw-pixel-agents/releases/tag/v1.7.0); no later controls are included |
| 2 | Task/run history | Complete — Codex coordinator | [#328](https://github.com/SweetSophia/openclaw-pixel-agents/pull/328), merged `26d77d6` on 2026-10-28; source-backed bounded history and read-only selection across private panels. No new npm publication or runtime rollout is claimed. |
| 3 | Stop and Steer | Complete — Codex coordinator | [#330](https://github.com/SweetSophia/openclaw-pixel-agents/pull/330), squash merge `c86e6eb` on 2026-10-28; [completion plan](superpowers/plans/2026-10-28-run-controls-completion.md), [setup and semantics](task-access-setup.md#live-follow-ups-steering-and-stop). Independent whole-branch review found and verified the final confirmation-identity fix; 1,582 tests, local release gates, Docker and synthetic browser acceptance passed. The full review window elapsed, protected PR checks passed, and exact post-merge `main` CI/CodeQL passed. No live mutation, deployment or later npm publication is claimed. |
| 4 | Approval handling | Complete — Codex coordinator | [#332](https://github.com/SweetSophia/openclaw-pixel-agents/pull/332), squash merge `56181af` on 2026-10-29 UTC; [spec](superpowers/specs/2026-10-29-approvals.md), [plan](superpowers/plans/2026-10-29-approvals.md) and [operator guide](task-access-setup.md#private-approval-handling). Scoped authority, inspected one-time decisions, first-answer truth, bounded no-replay and historical suppression. Independent review fixes include proven pre-dispatch recovery and terminal-error private-state clearing. Final `c1a3822` passed 1,723 tests, types/coverage/build/package/both audits, exact-source Docker API/SPA and hard synthetic browser checks for keyboard/phone geometry, recovery, latches and private-state cleanup. The full review window elapsed, protected PR checks passed, and exact post-merge `main` [CI](https://github.com/SweetSophia/openclaw-pixel-agents/actions/runs/40976651227) and [CodeQL](https://github.com/SweetSophia/openclaw-pixel-agents/actions/runs/40976651099) passed. No live mutation, deployment or later npm publication is claimed. |
| 5 | Model selection | Implemented / locally qualified / in review — Codex coordinator | [Spec](superpowers/specs/2026-10-30-model-selection.md), [plan](superpowers/plans/2026-10-30-model-selection.md), [operator guide](task-access-setup.md#conversation-model-selection). Final product source `4799d52`; fresh local types, 1,844 tests, coverage, build, package smoke, both audits and exact-source Docker API/SPA startup passed. Fresh isolated real-panel native browser checks passed at five documented widths plus short phone/landscape, including keyboard/hit geometry, malformed timestamp rejection/recovery, uncertain recovery, private-state cleanup and scoped accessibility. Final independent review/integration remains with the coordinator. Protected merge and exact post-merge main CI/CodeQL remain required; no model deployment, live acceptance or npm publication is claimed. |
| 6 | Scheduling | Pending — Codex coordinator | Native scheduling authority, bounded validation and duplicate-safe creation |
| 7 | Workspace editing and attachments | Pending — Codex coordinator | Native confined writes/uploads/attachment contracts and conflict-safe explicit actions |

External-channel delivery and multi-user access remain future directions outside
these seven deliveries. No new Gateway permission or real agent task is authorized
by a completed source checkbox alone; unsupported capabilities and missing grants
must be reported honestly rather than bypassed.

Approval contract evidence is the installed OpenClaw 2026.10.3 native schemas and handlers, not live permission or mutation acceptance. Published npm **1.7.0** predates approvals as well as run history and Stop/Steer; this delivery does not publish a new package or roll out a runtime.

Model selection uses native per-conversation semantics with the existing non-admin read/write grant and write opt-in. Known-busy/unknown activity blocks dispatch; work racing the idle check may still switch or restart. Explicit configured-default reset differs from pinning the same model, and a confirmed preference is not execution proof. Unknown outcomes never automatically replay; bounded process-local guards do not survive server restart. Published npm **1.7.0** also predates this implementation.
