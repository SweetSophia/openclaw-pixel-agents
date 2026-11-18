# Native image follow-ups (unreleased source feature)

This guide describes the current source implementation, not an already published
npm release, deployed office or enabled Gateway. A source build or locally packed
artifact containing this guide is required. No version bump, publication, pairing
or activation is implied.

## Enable deliberately

First establish [ordinary private task access](task-access-setup.md) with the
office's existing task device and its `operator.read` plus `operator.write` grant.
Image follow-ups use that same identity; they need no separate image credential,
administrator authority or browser-to-Gateway connection. Do not grant additional
scopes to work around an unavailable image action.

In the office's private server environment, explicitly set:

```dotenv
CONTROL_SEND_ENABLED=true
CONTROL_ATTACHMENTS_ENABLED=true
```

Both flags default to false. Existing `OPENCLAW_GATEWAY_URL` and
`PIXEL_CONTROL_TOKEN` configuration is also required. Restart the office after
changing its environment; rebuilding alone does not change a running process.
The [configuration reference](configuration.md) explains explicit env-file loading,
transport and reverse-proxy requirements. The guided installer does not opt in.

The connected source must identify as a recognized stable OpenClaw Gateway
**2026.11.2 or newer**, negotiate the ordinary send methods and read/write grant,
and advertise valid positive safe-integer image, frame and buffer limits. Missing,
invalid, older or prerelease capability disables images without disabling ordinary
task reads. An unavailable source or insufficient grant is not an invitation to
pair another identity or request admin access.

## Select, review, then send

Unlock Task details, select an existing writable conversation and use its live
follow-up composer. Enter nonempty ordinary text (at most **8,000 characters**)
and select **one PNG or JPEG**. Images are not supported for a new conversation,
recorded-history view, Steer, command/abort aliases, external delivery or model/
runtime overrides. The server freezes the exact session ID, lifecycle, branch and
active leaf during preparation and verifies them again before dispatch.

The decoded image must be nonempty and at most **4 MiB (4,194,304 bytes)**, or the
Gateway's smaller total/image limit. Each dimension is at most **8,192 pixels**;
the total is at most **16,777,216 pixels**. JPEG header discovery is bounded at
**64 KiB**. File extensions and browser MIME claims alone are not trusted: the
server verifies bytes, format and dimensions and computes SHA-256. It normalizes
the filename; review the displayed name, type, byte count, dimensions and digest.
There is no image thumbnail or object URL in the review.

Preparation sends nothing to the Gateway. A review expires after **five minutes**.
Read the warning and check the initially unchecked acknowledgment before confirming:

> The image, including embedded metadata, will be sent to OpenClaw and may be processed by its model and tools. OpenClaw sharing and retention settings apply, including existing or later public session shares. The office does not make the image exclusive to this conversation. Sending cannot be undone by Lock or closing this panel.

The office does not strip embedded metadata. Remove sensitive metadata yourself
before selecting a file. Confirmation sends a native `chat.send` follow-up with
`queueMode: 'followup'`, `deliver: false`, the exact reviewed session ID and leaf;
it does not create a conversation or external destination.

## Uncertainty is check-only, never replay

Once the office invokes native send, it never resends that image operation—not
after repeated confirmation, a timeout, lost acknowledgment, reconnect, receipt
check or office restart. This differs from ordinary text Retry. **Check** reads
source-correlated evidence; it does not send, confirm or prepare a replacement.
If the outcome remains unknown, inspect the conversation/OpenClaw before deciding
on any new action. Do not reconstruct an image operation to force a retry.

`Sending` can include preflight; it does not prove an upload has begun. `Accepted`
only establishes native admission. `Recorded` requires a correlated message ID and
sequence, not proof the model consumed the image, the image bytes persisted, or
that storage is exclusive to this conversation. Image-reference evidence is
reported separately as unverified, reference-recorded or omitted. A typed native
`UPLOADS_DISABLED` denial is shown as rejected; other failures after invocation
remain uncertain. A changed source/target or expired review requires fresh review
only when non-dispatch is established, not an automatic resend.

## Lock, limits and disable

Lock, access-key generation changes, agent/target changes, hiding the page and
unmounting the composer clear the locally selected image/review. An already
admitted operation's metadata-only marker survives a form remount so closing and
reopening cannot enable duplicate sending. Lock is not cancellation or erasure.

The office keeps image/prompt payloads only in bounded process/tab memory: two
process-wide image slots cover reception through native settlement, preparations
are limited to ten per minute per IP, and body/native deadlines are 30 seconds.
Metadata-only receipts last ten minutes, capped at 128; a full live set refuses
new work instead of evicting operations to make room. Old reviews/receipts are
unavailable after an office restart and cannot restore dispatch authority. There
is no office image/prompt journal, secure-erasure guarantee or native-media deletion
promise. OpenClaw/provider/tool retention and existing or later public session
sharing still apply.

Private image bytes, filename, prompt, target and review token must not appear in
browser storage, URLs, logs, the public roster/socket or collector. The shared
office key is retained only in tab memory. Use HTTPS except for the documented
private loopback/direct-Tailnet transport cases.

To disable, set `CONTROL_ATTACHMENTS_ENABLED=false` (or remove it) and restart the
office. Keep ordinary access/sending only if still wanted. Disabling creates no
new attachment identity or store, but **does not undo a dispatched action** or
remove image data already held by OpenClaw, providers, tools or session shares.

## Contributor qualification

Use only a disposable signed synthetic Gateway, office data, roster, access keys
and images. Follow the source checkout's `CONTRIBUTING.md` browser checks. The real-child
restart tests are `server/control/attachmentIntegration.test.ts`; package smoke
checks guide delivery and default-off startup. Source, local qualification,
exact-head hosted CI, merge, publication, deployment and live activation are
separate gates. Never upload a real agent's image as an automated check.
