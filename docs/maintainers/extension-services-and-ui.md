# Extension services and generic UI

Extensions own portable feature behavior. The daemon owns admission, canonical
session and process lifetime, persistence and interaction arbitration. Felan
owns its local provider implementations, default `host.json` and clients.
Providers run trusted code; service handles are not a JavaScript sandbox.

## Declare capabilities, not application factories

A configured extension declares required and optional versioned contracts on
its default export. `pi.services.get(contract)` only permits declared access.
A missing required provider leaves that extension unloaded with a diagnostic;
a missing optional provider disables only the dependent capability.

```ts
import {
  SESSIONS_HISTORY_SERVICE,
  type FelanExtensionAPI,
} from '@felan-ai/agent-core';

export default Object.assign((pi: FelanExtensionAPI) => {
  const history = pi.services.get(SESSIONS_HISTORY_SERVICE)!;
  pi.registerCommand('history-count', {
    description: 'Count the first page of visible sessions',
    handler: async () => {
      const page = await history.list({ scope: 'visible' }, { limit: 100 });
      await pi.ui.notify({ level: 'info', text: `${page.items.length} sessions on this page` });
    },
  });
}, { serviceRequirements: { required: [SESSIONS_HISTORY_SERVICE] } });
```

Prefer read-only `SESSIONS_HISTORY_SERVICE` for history consumers. Full
`SESSIONS_SERVICE` also grants admitted child execution and control. Its
execution handles are scoped to the parent. History IDs, revisions and cursors
are opaque; a project filter is not an authorization grant. Reads never adopt,
restore or execute old sessions. Pin pagination to the returned session,
revision and branch, and handle stale or unavailable data explicitly.

`MODELS_SERVICE` exposes allowed model metadata and inference, not credentials
or arbitrary endpoint configuration. `SECRETS_SERVICE` is only for trusted
credential consumers; namespaces address an existing grant, not new authority.
Never put credential values in prompts, generic UI, events or diagnostics.

`RUNTIME_DEPENDENCIES_SERVICE` requests a host-owned operation by a known
dependency ID. The provider applies host policy and, when necessary, obtains
approval from an eligible local console. An ordinary session form cannot grant
installation authority. Missing installation support does not disable an
already available runtime dependency.

## Describe UI independently of clients

Every extension receives `pi.ui`: notifications, typed statuses, forms,
documents, views and progress. Execution code must not require a TUI renderer
or an attached client to exist. An unavailable responder does not mean approval.

Forms identify the selected action explicitly. Publish declared fields,
defaults and action outcomes; never infer approval from a nonempty answer.
View actions address the exact element revision and, for item actions, a
current item ID. Query and paging actions are ordinary validated actions.
Preserve cancellation and stale-action errors rather than replaying effects.

Hints identify optional client presentation enhancements. They cannot change
IDs, data, allowed inputs or outcomes. Keep rich renderers in the client
(`apps/felan` for the bundled TUI); a no-hint client must still display the content and perform the
same actions. Historical prompt insertion is client-local and must never
silently submit a new agent turn.

The UI vocabulary is explicitly negotiated. Forms use the `form` interaction
kind alone; presentation and actions use versionless `ui.*` capabilities. Clients
lacking the corresponding interaction kind or interactive capability get read-only fallback content or an unsupported result, not an
action they cannot submit. TUI and ACP clients with equivalent capabilities
use the same wire semantics. Verified transport facts determine local-console
authority; client kind and a claimed capability are not authority.

Use `audience: 'owner'` for owner-only session approvals, such as Chrome access.
Use `audience: 'host'` for local-console prompts. These restrictions are enforced
by the broker from transport facts, not by the client's `kind` label. Answering an
ordinary form does not authorize a host operation outside its service policy.

## Provider and lifecycle boundaries

Providers resolve from the managing package's fixed installation anchor, not
the current directory or a project-controlled config path. Changing provider
selection requires restart. Like Pi resume, restoring an evicted session
composes it from the current configuration; there is no stored configuration
identity or drift check. The daemon checks canonical storage paths and never
grants a new storage location implicitly.

Control state version 1 holds sessions, requests, interactions and resources.
Invalid or foreign control state is quarantined and rebuilt; pre-daemon
discovery re-adopts the transcripts it described.

Validate configuration and dependencies before effects. Activate an admitted
session only after canonical registration. Settle work before releasing its
ownership, retain UI through asynchronous shutdown handlers, and revoke scoped
services after their users have drained. Failed cleanup must remain visible
and must not release ownership prematurely.

The public package versions, wire versions and stored-state versions are
independent. Follow the repository's incompatible-minor rule for `0.x` API
changes and the [release procedure](releasing.md). This guide defines the
boundary; verification and packed-install gates establish release readiness.
Run daemon and client tests only through `scripts/test-isolated.sh`, including
the full gate: `scripts/test-isolated.sh pnpm verify`.

## Memory workers

Memory uses the host-only `HOST_WORKERS_SERVICE` rather than
`SessionsService.create()` until the latter supports workspace selection,
tool allowlists and in-process tools. Dreaming needs an isolated staging
workspace and a removal tool restricted to staged memory pages. The worker
still runs under daemon admission, model scope, canonical session ownership
and runtime lifetime barriers; it is not a second session registry.

The host worker exposes turn events so memory flushes its retained run journal
after each completed turn and again on finalization. Hosts without runtime
file capabilities report memory unavailable; hosts without worker scheduling
retain read access without claiming they can schedule dreams.
