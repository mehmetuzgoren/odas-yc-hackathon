# ODAS runtime concierge and operations workers

These are application processes. They do not depend on a Codex coding session or a local agent harness.

The implementation uses `@agent-relay/sdk` 15.0.1 against the actual self-hosted `@relaycast/engine` 12.3.0. The SDK carries its supported Relaycast client dependency. The engine runs under a compatible Node release because its SQLite adapter uses `better-sqlite3`. Do not run that engine under Bun. The ODAS API and worker application code run under Bun.

## Startup

The root `bun dev` command supervises the engine, provisioning, API, both workers, actor runtime, device worker, and frontend. The underlying commands are:

```sh
node node_modules/@relaycast/engine/dist/bin/serve.js --db "$DATA_DIR/relaycast.sqlite" --port "$RELAY_PORT" --base-url "$RELAY_BASE_URL" --env development
bun packages/concierge/src/provision.ts
bun packages/concierge/src/worker.ts --role operations
bun packages/concierge/src/worker.ts --role concierge
```

Set `DATA_DIR`, `ODAS_NAMESPACE`, `RELAY_BASE_URL`, `API_INTERNAL_URL`, and `ODAS_INTERNAL_TOKEN`. The internal token must contain at least 32 characters. Keep the engine and internal API on a private network; do not expose their unauthenticated workspace creation path to the public internet.

Provisioning creates one workspace and two stable identities, then saves their credentials with mode 0600 in the ignored `DATA_DIR/relay-identities.json`. The workers reconnect with those tokens after restart. Preserve that file together with the Relaycast database. Use a different data directory and namespace for isolated test runs. `RELAY_WORKSPACE_KEY` can supply a pre-provisioned workspace, including a hosted workspace when its base URL is configured. Do not print or commit keys.

## Message processing

The actor outbox is drained into the application SQLite outbox. The operations worker publishes events targeted to the concierge, and the concierge worker publishes events targeted to operations. Thus every action request crosses an actual Relay process boundary. Both use `AgentRelay`, `workspace.reconnect`, `sendMessage`, `addListener`, `inbox.get`, `messages.listDirect`, and `messages.markRead`, verified against the installed SDK declarations.

A domain envelope contains contract version, outbox ID, target, event ID, room/booking IDs, correlation ID, revision, occurrence time, and idempotency key. The receiver calls the authenticated private API. The API validates the envelope against its persisted outbox and uses a durable processed-message claim. The domain service completes the action before the worker sends a `business_result` DM. The peer records that result and marks the outbox complete. Read state is a transport receipt only.

Outbox requests retry after missed deliveries. Workers reconcile unread direct messages after reconnecting. Completed application messages return the saved result, and duplicate replies/notifications use database uniqueness. Each new transport delivery gets its own idempotent result DM, keyed by the incoming Relay message ID, so an already-read acknowledgment cannot hide the result of a later retry. Commands arriving at the room actor retain its idempotency and revision checks. Worker scheduling uses wall time; fixture business clocks cannot extend message leases or suppress new event delivery.

## Concierge tools and consent

The same typed tools power development rules mode and the configurable model adapter:

- Search actual catalog availability and calculate a server quote.
- Read the authenticated guest's reservations, readiness, and authorized access instructions.
- Prepare normal Stripe hosted Checkout from a displayed, expiring quote.
- Search actual replacement inventory and offer it to the guest.
- Accept or decline a replacement after explicit guest confirmation.
- Cancel an owned reservation after explicit guest confirmation and show its cancellation policy.

The model cannot change storage, readiness, or robot commands. Zod validates every tool argument. Guest confirmations use an authenticated CSRF-protected action endpoint; the model only proposes those actions. Checkout holds the reviewed quote by ID, and fulfillment remains the payment service's responsibility.

Without `OPENAI_API_KEY`, the visible mode is `development_rules`. Set `CONCIERGE_MODE=rules` to keep that mode even when a key exists. A rules search accepts a dated Pacific interval such as `San Francisco on 2026-11-05 from 10:00 to 12:00 under $8/hour`. With a configured key, the real model adapter calls the OpenAI Responses API with strict function schemas. `CONCIERGE_MODEL` must name a configured compatible model; `CONCIERGE_MODEL_BASE_URL` selects the API endpoint. There is no assumed model ID. Model configuration or provider failures remain explicit failures; no model reasoning is claimed in rules mode.

## Guest updates

Conversations and notifications are durable and scoped to the session user. `/api/events` streams only that user's messages and notifications, with persisted row cursors in `Last-Event-ID`. Reconnection replays missed items; revoked or expired sessions close the stream. A new readiness disruption opens the concierge dialog once per notification, preserving the seen state per user. Native dialog focus management supports keyboard and Escape behavior.

## References

- [Current Relaycast API and self-hosting](https://agentrelay.com/docs/relaycast-api)
- [SDK source and README](https://github.com/AgentWorkforce/relay/tree/main/packages/sdk)
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
