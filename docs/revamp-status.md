# Revamp status

Updated 2026-10-26 against source revision `cf1dceb` (Usage PR #323).
This tracker separates merged source, recorded deployment evidence and work still
requiring qualification. A source merge does not establish what a live office or
an already published npm package is running.

## Merged and source-verified

| Scope | Delivery evidence | Recorded runtime status |
| --- | --- | --- |
| Live activity and canvas Fit/zoom/pan | [#279](https://github.com/SweetSophia/openclaw-pixel-agents/pull/279), [#293](https://github.com/SweetSophia/openclaw-pixel-agents/pull/293); [canvas plan](superpowers/plans/2026-10-22-canvas-controls.md) | Included in the later backed-up, verified Task and Workspace rollouts. |
| Task details and private conversations/follow-ups | [#294](https://github.com/SweetSophia/openclaw-pixel-agents/pull/294), [#295](https://github.com/SweetSophia/openclaw-pixel-agents/pull/295), [#296](https://github.com/SweetSophia/openclaw-pixel-agents/pull/296); [task-controls plan](superpowers/plans/2026-10-23-task-controls.md) | Both deliveries recorded live read acceptance with preserved state; the real-task send check was handed to the user. |
| Restart-safe appearances and portrait/map consistency | [#300](https://github.com/SweetSophia/openclaw-pixel-agents/pull/300), [#301](https://github.com/SweetSophia/openclaw-pixel-agents/pull/301) | Included in the subsequently qualified Workspace runtime and 1.6.0 release. |
| Results and delivered files | [#304](https://github.com/SweetSophia/openclaw-pixel-agents/pull/304); [Results plan](superpowers/plans/2026-10-24-results-files.md) and [1.5.0 notes](releases/1.5.0.md) | Recorded backed-up deployment verified Results, the roster and existing read/send capability without sending a task. |
| Read-only Workspace and recovery follow-ups | [#310](https://github.com/SweetSophia/openclaw-pixel-agents/pull/310), [#311](https://github.com/SweetSophia/openclaw-pixel-agents/pull/311), [#312](https://github.com/SweetSophia/openclaw-pixel-agents/pull/312), [#313](https://github.com/SweetSophia/openclaw-pixel-agents/pull/313); [Workspace plan](superpowers/plans/2026-10-25-workspace-panel.md) and [1.6.0 notes](releases/1.6.0.md) | PR #310 records runtime-only deployment and live Workspace/Results acceptance with saved state and credentials preserved. |
| Install notice and first-run/setup instructions | [#315](https://github.com/SweetSophia/openclaw-pixel-agents/pull/315); [onboarding plan](superpowers/plans/2026-10-26-npm-onboarding.md) | Source/package qualification passed; deployment and publication of this addition were not part of that PR. |
| Conversation Usage | [#323](https://github.com/SweetSophia/openclaw-pixel-agents/pull/323); [Usage plan](superpowers/plans/2026-10-26-usage-panel.md) | Source qualification passed: 1,407 tests, required CI, Docker, package smoke and synthetic browser checks. This PR did not deploy or publish. |

The older plans' completion checkboxes are reconciled with their merged PRs and
recorded release ledgers. Those historical acceptance results do not claim fresh
live acceptance today.

## Active closeout work

| Task | State and owner | Branch/PR | Completion evidence required |
| --- | --- | --- | --- |
| Reconcile plans and keep this tracker current | In progress — Codex documentation agent | `docs/revamp-closeout-20261026`; PR pending independent review | Review the documentation diff, check links and source/evidence consistency, complete the review window, merge. |
| Qualify dependency maintenance | Under review — Codex coordinator | [#324](https://github.com/SweetSophia/openclaw-pixel-agents/pull/324), Ready for review at `8301f68`, branch `chore/revamp-dependencies-20261026`. Original PRs [#316](https://github.com/SweetSophia/openclaw-pixel-agents/pull/316)–[#322](https://github.com/SweetSophia/openclaw-pixel-agents/pull/322). | Initial independent review is clean; 1,407 local tests and Docker on Node 26.12.1 pass. The current review window ends **2026-10-26 18:25:23 UTC**; inspect current-head checks and findings before merge. A further push restarts the window. |
| Qualify the current runtime and roll out merged additions | In progress — Codex runtime audit/coordinator; recovery and rollout acceptance pending | Read-only audit complete; no new rollout claimed | Retain a fresh backup and rollback path, preserve data/configuration/current device grants, independently review office-only recovery, then verify the exact tested runtime, fresh roster and private reads. Send no real task as an automated smoke test. |
| Publish onboarding and Usage to npm | Deferred — separate release work | No publication included in this closeout | A versioned release must be qualified and explicitly tracked through the [release workflow](releases.md). The already published 1.6.0 package predates these additions. |

For each new or updated PR, the coordinator records its exact pushed revision,
independent review, 15-minute review deadline, checks and findings. Every push
restarts that window. An unavailable bot is replaced by a fresh independent
review; failing enforced checks or repository protections remain blockers.

### Runtime audit snapshot

The read-only audit on 2026-10-26 identified live runtime `4dd179f`
([PR #313](https://github.com/SweetSophia/openclaw-pixel-agents/pull/313)), before
onboarding and Usage. The public roster contains eight agents with fresh ingest.
The private Gateway connection reports `auth-error`, although the retained
read/write device grant still matches the authoritative source record. This is
not evidence that a new grant or credential rotation is needed. Office-only
recovery is awaiting independent review and fresh acceptance evidence; Usage is
not yet deployed. No recovery, real-task send or npm publication is claimed here.

## Future capabilities

The [task-controls design](superpowers/specs/2026-10-23-task-controls-design.md)
identifies approvals, Stop/Steer and other run controls, scheduling and model
selection as future directions. Attachments/uploads, workspace editing, historical
run selection, external-channel delivery and multi-user access are also outside
the delivered plans. They have no agreed implementation acceptance criteria in
this tracker and are not silently added to the current closeout.

No npm publication, new Gateway permission or real agent task is authorized by a
completed source checkbox alone.
