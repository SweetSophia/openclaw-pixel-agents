# Private agent documents

The **Agent documents** section in an agent's private **Workspace** tab edits only existing root `AGENTS.md`, `SOUL.md`, `USER.md` and `MEMORY.md` files. Names are exact and case-sensitive. This is a bounded text editor, not general workspace editing: no creation, deletion, rename, uploads, attachments, arbitrary paths, force overwrite, `IDENTITY.md` or `BOOTSTRAP.md` editing.

Availability: **unreleased source feature**. Use a source build containing this guide; the existing package version alone does not identify this feature. Source/synthetic qualification does not enable an installed office or prove public npm availability, live permissions or real document mutation. Uploads and general workspace editing remain pending.

## Enable only with separate administrator approval

Editing is default-off. Configure [ordinary private access](task-access-setup.md) first, retaining the existing office key, ordinary device and persistent `DATA_DIR`. Ordinary read-only Workspace browsing does not start the document connection. Neither sending nor scheduling opt-ins enable document editing.

The native write method requires **`operator.admin`**. The separate document device requests `operator.read` and `operator.admin`; **never elevate the ordinary task device or reuse the scheduling device**. The document connection's exact local allowlist is `agents.files.get` and `agents.files.set`. That allowlist is application policy, **not cryptographic narrowing of the broader administrator credential**. A compromised server/device credential can have wider native authority. All office-key holders are trusted operators, not separate RBAC users. Restrict the entire office and protect this device independently.

These are deliberate operator actions, not steps performed by source qualification or the configuration wizard:

1. Preserve a private persistent `DATA_DIR` and existing private-access configuration. Add `CONTROL_DOCUMENTS_EDIT_ENABLED=true` to the office process environment and restart the office when authorized. Keep the validated `OPENCLAW_GATEWAY_URL` and `PIXEL_CONTROL_TOKEN`; do not change the ordinary grant.
2. For initial document-device pairing only, provide the server-side credential matching the Gateway's authentication mode as `OPENCLAW_DOCUMENTS_GATEWAY_TOKEN` or `OPENCLAW_DOCUMENTS_GATEWAY_PASSWORD`. Ordinary and scheduling bootstrap credentials are never borrowed. Never paste a Gateway credential into the browser, a URL, a collector or a `VITE_*` variable.
3. Unlock the private office, select the intended agent, return to **Live** if a recorded run is selected, open **Workspace**, then explicitly expand **Agent documents**. Only this authenticated opening lazily starts the document connection; startup and ordinary browsing create no document identity.
4. In Gateway administration, inspect `openclaw devices list`. Verify the pending **Pixel Agents document editing** device belongs to this office and requests the intended read/admin scopes before approving its exact request with `openclaw devices approve <request-id>`. Do not approve an ordinary/scheduling device by mistake. Approval is an independent administrator decision.
5. Reconnect/restart if needed after approval. Once the separate device grant is stored, remove the temporary document bootstrap credential and restart again. Preserve the private identity/grant under `DATA_DIR/control-documents/`. Keep directories `0700` and files `0600` on POSIX; use appropriate private ACLs elsewhere. Never copy another device's identity, commit credentials or share a data directory between independent offices.

The document profile requires a recognized **stable Gateway 2026.11.2 or newer**, negotiated get/set methods, and separately granted read/admin scopes. Missing, malformed and prerelease version identities are rejected. This is the conservative source-qualified floor, not a claim that every earlier Gateway is unsafe. An installed source tree or version string alone does not establish negotiated live compatibility.

With the flag omitted/false, no document directory, identity or connection is created, even when document bootstrap credentials are present. Setting it false and restarting disables this office's profile but **does not revoke the native grant** or undo completed writes. Revoke the document device independently in Gateway device administration when retiring it; ordinary tasks and scheduling grants are separate. Removing local identity files alone is not native revocation, and must never be used to retry an uncertain write.

Remote private access retains HTTPS/encrypted Gateway transport, exact Origin and office-key checks. The optional direct-Tailnet HTTP exception requires qualifying actual socket addresses; forwarded headers cannot enable it. See [private-access setup](task-access-setup.md).

## Edit, explicitly save, then verify

1. Check the visible **agent ID and document name**. Only canonical registered IDs are admitted; roster display names do not change identity. Documents belong to the current agent, not a historical run. **Return to live conversation** before editing from recorded-run mode.
2. Select one of the four existing documents. Missing files, unsupported/binary text, invalid source metadata and oversized files cannot be saved. An empty existing file is valid.
3. Edit plain text and inspect its UTF-8 byte count. The bound is **32 KiB (32,768 bytes)**, not characters. Text must round-trip as UTF-8 without NUL, other ASCII controls except tab/newline/carriage return, or unpaired surrogates. Native size/raw SHA-256 metadata must match the re-encoded text; lossy decoding fails closed. Ordinary read-only Workspace preview limits are unchanged.
4. Choose **Save document**. There is **no autosave**. One immutable submission is sent, with the previously read revision and exact selected identity. A second click does not send another write. **Saved and verified** requires an exact validated native acknowledgement, not merely HTTP connectivity or an optimistic UI update.

You may keep typing during a save. A late acknowledgement never overwrites newer input. If a submitted version was saved but the current draft differs, the UI says that the submitted version was saved and the current draft remains unsaved. Undoing to the old text during an outstanding/uncertain save still requires discard consent: the server may already contain the submitted version.

## Conflicts and unknown outcomes: read, do not replay

Every native set carries the server-retained **`expectedHash` and `expectedWorkspace`** from the reviewed read. The browser receives only an opaque revision, never an editable absolute host path or native hash. Consumed, expired or connection-invalidated revisions cannot write.

These checks are **optimistic**, not cross-process atomic compare-and-swap against arbitrary external writers. The native handler's hash-read and write are separate operations under a process-local queue. Another editor/process can write between them. Coordinate external writers and review current native content; do not interpret a saved receipt as an exclusive filesystem lock.

| State | Safe response |
| --- | --- |
| Saved and verified | The exact submitted text was acknowledged. Review any newer unsaved draft separately. |
| Conflict / changed document | Your draft remains. Explicitly **Reload and review** the current file before another edit/save; no force overwrite or silent rebase. |
| Outcome unknown | A lost, timed-out, canceled, malformed or post-acknowledgement connection failure may follow a committed write. **Do not resubmit or recreate the operation to retry.** Save remains disabled. Explicitly reload/review native truth before deciding on a new edit. Unknown is not confirmed failure. |
| Disabled / pairing required / permission required | Inspect the separate opt-in and intended device grant. Never broaden the ordinary grant to work around this state. Other private panels remain independent. |
| Unsupported | Verify the stable native floor, negotiated methods and hash/precondition reply contract. No shell, generic RPC, tool-call, task-send or local-filesystem fallback. |
| Temporarily unavailable / source changed | Keep the draft, restore readiness, then explicitly reload/review. Reconnection does not revive an old write revision. |

**Reload and review discards the current draft after confirmation.** Preserve anything you need privately before accepting; the editor has no merge or backup service. Canceling discard keeps the draft. A new read is a new explicit review point, not permission to replay an earlier submission.

Server-side tickets (32) and operation receipts (128) are bounded, memory-only records, accepted/deduplicated for up to ten minutes. Expiry is enforced on subsequent requests, not by a timed physical-memory erasure guarantee. An identical operation identity/payload can return its retained receipt without another native dispatch; changed reuse is rejected. No automatic replay occurs. Restart loses tickets/receipts, invalidating old revisions rather than replaying them. Document text is not journaled to disk. Do not apply Conversation message retry semantics or scheduling journal recovery to document writes.

## Draft lifetime and privacy

Drafts and loaded text stay in component/tab memory, not browser storage, URLs, public agents/socket payloads or the collector. Public roster access is not a substitute for private document access.

- Leaving Workspace, selecting another document, collapsing the editor, closing the modal or reloading with dirty/unresolved text requires an explicit discard decision; page unload warns. Native browser warnings depend on browser policy and are not durable storage.
- Temporarily hiding the page or losing readiness retains the draft, cancels requests and invalidates write authority. Return with a fresh explicit review; no submission is replayed.
- **Lock**, an access-key generation change, an agent change and final close clear private text. Lock does not undo a write already dispatched. Reloading clears the tab's key and drafts; there is no recovery after Lock/reload. A server restart may leave an open tab's in-memory draft visible but invalidates its write revision; there is no server-side draft recovery.

Source qualification uses controlled native-shaped HTTP/WebSocket fixtures, an isolated real browser and installed native handlers against synthetic files only. It does not include approval of live administrator authority, activation, deployment or writes to real agent documents. Contributor gates remain in `CONTRIBUTING.md`; none substitute for an operator's explicit live authorization.
