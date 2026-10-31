# ODAS contracts v1

The integration lead owns this contract, migrations, root manifests, generated actor clients, composition, deployment, and final verification. Times are UTC epoch milliseconds; user inputs are resolved for their selected date in America/Los_Angeles. Money is integer USD cents. Every native actor mutation has an idempotent command ID. Public room state never contains account or conversation data.

## File ownership

| Owner | Exclusive implementation paths |
| --- | --- |
| Integration lead | Root files, packages/contracts, apps/api/src/core.ts, apps/api/src/db.ts, apps/api/src/index.ts, apps/api/src/generated, apps/web/src/{main,App,api,styles}.*, scripts, deploy, migrations, docs |
| Marketplace | apps/api/src/catalog, apps/web/src/marketplace |
| Commerce | apps/api/src/commerce, apps/web/src/commerce |
| Room operations | packages/actors, apps/api/src/operations, apps/web/src/operations, workers/device |
| Concierge | packages/concierge, apps/api/src/concierge, apps/web/src/concierge |

Feature modules export createCatalogRoutes(runtime), createCommerceRoutes(runtime), createOperationsRoutes(runtime), and createConciergeRoutes(runtime), mounted at /api. Features export their service factory from service.ts; the lead wires runtime.services after construction. Feature UI exports route-ready components from index.tsx. Use the shared api<T>(path, options) client and useSession() hook from ../api. React Router preserves URL search params. No feature owner changes root dependencies, migrations, shared contract, or generated files; request changes from the lead.

## HTTP API

Responses are JSON; errors are {error: string, code?: string}. Mutations use same-origin credentials and X-CSRF-Token obtained from GET /api/auth/session. Stripe webhook alone consumes raw signed request body. Authenticated data is scoped by session user. Internal worker API uses a bearer credential and binds to loopback by default.

| Owner | Endpoints |
| --- | --- |
| Marketplace | GET /catalog/search, /catalog/groups/:id, /catalog/offices/:id |
| Commerce | GET /auth/session; POST /auth/signup, /auth/login, /auth/logout; POST /quotes, /reservations, /reservations/:id/checkout, /reservations/:id/reconcile, /reservations/:id/cancel, /reservations/:id/check-in, /reservations/:id/check-out; GET /reservations, /reservations/:id; POST /payments/webhook; POST /offers/:id/accept, /offers/:id/decline |
| Operations | GET /operator/rooms, /operator/rooms/:id, /operator/tasks; PATCH /operator/rooms/:id; POST /operator/rooms/:id/{inspect,clean,dock,blocks}, /operator/tasks/:id/resolve; DELETE /operator/rooms/:id/blocks/:blockId; restricted camera frame endpoint |
| Concierge | GET /conversations, /conversations/:id/messages, /notifications, /events (SSE); POST /conversations, /conversations/:id/messages, /notifications/:id/read; internal event/action endpoints |

## Service composition

Runtime has db (bun:sqlite Database), clock.now(), rooms (RoomGateway), config, and services. Shared core supplies user lookup, guest/operator authorization, audit, event enqueue, and HTTP errors. Service interfaces are in apps/api/src/core.ts. All imports use project modules or @odas/contracts.

Room actor public contract: snapshot(): Promise<RoomSnapshot>, command(command: RoomCommand): Promise<RoomResult>, available(startAt,endAt,excludeBookingId?): Promise<boolean>. Native generated clients are server-only. Actor private helpers use #private methods. Mutations persist with this.db.transaction, avoid @Emittable private state, schedule native alarms, and persist outgoing events before external actions. Operations drains actor events to the SQLite application outbox, acknowledging actor events only after durable insert.

DomainEvent v1 carries id, roomId, optional bookingId, correlationId, revision, idempotencyKey, occurredAt and typed payload. Relay delivery receipts do not mean business completion. Workers store processed-message results and send application result messages. Outbox delivery remains retryable until an application result is stored.

SQLite schema is centrally owned. Most tables include a data JSON column for feature detail alongside indexed/CAS columns. Ask the lead for schema extensions. Isolated integration runs set DATA_DIR, API_PORT, WEB_PORT, ACTOR_PORT, ACTOR_PROJECT_ID, DEVICE_PORT and ODAS_NAMESPACE. Test clock requires ODAS_TEST_MODE=1 and simulated devices.
