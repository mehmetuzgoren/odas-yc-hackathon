# ODAS

An hourly office marketplace with native durable room inventory, Stripe sandbox payments, a persistent concierge, and supervised room turnover.

## Run locally

Use Bun 1.4.4, Node 22.23.4, uv 0.12.19, and FFmpeg. Python 3.13.7 dependencies are locked in `workers/device/uv.lock`; uv installs the worker environment on first launch.

```sh
bun install --frozen-lockfile
bun run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). One command starts the API, Vite frontend, native local Terse runtime, actual Relaycast engine, separate operations and concierge workers, and Python device worker. The supervisor stops the stack if a child process exits. Docker restarts the packaged release when configured with `restart: unless-stopped`.

The seed contains 6 explicit workspace groups and 31 modeled offices. Configured 08:00 to 20:00 Pacific hours are test hours. Capacity, amenities, dimensions, access, and photography remain unknown. Only `polk-310-office-01` has an explicit simulator binding; no physical hardware is claimed for the other offices.

Development guest and operator accounts use ordinary password login. Their generated credentials are in the ignored `.data/development/dev-accounts.json`, mode 0600. Set `DEV_GUEST_PASSWORD` and `DEV_OPERATOR_PASSWORD` before first seeding to choose them. Public signup always creates a guest. Test operator accounts can view their assigned rooms and camera feeds; changing physical-device controls requires a physical-capable operator. Production startup does not seed development accounts.

With the development stack running, populate the host schedule with `bun run seed:reservations`. It creates staggered confirmed reservations for rooms 2 onward in each building for today and the next three days, in Pacific time. Their reserved times and turnover buffers reject overlapping bookings through native room inventory. Each building's first room stays available for the live demo. The records have demo payment status and never charge Stripe or control devices. Repeating the command preserves existing reservations and skips elapsed slots or conflicts. Use `--date YYYY-MM-DD --days 4` to choose another date range.

Provision an operator separately with `bun run operator:create --email operator@example.com --name "Office operator" --groups polk-310`. Supply `OPERATOR_PASSWORD` privately, or use the generated ignored credential file. Scope IDs are explicit. The account defaults to test permissions; `--allow-physical` explicitly permits physical device access after commissioning. Existing guest accounts are never silently promoted.

## Configure

Copy `.env.example` to `.env` for overrides. Default development secrets are generated privately under `DATA_DIR`. Keep that directory to preserve accounts, sessions, conversations, Relay identities, and native actor state. Use a different `DATA_DIR`, namespace, and ports for each isolated run.

Set Stripe sandbox credentials in `.env` or the ignored `.data/private/stripe.env`. This release accepts test credentials, including claimable sandbox restricted keys, and rejects live keys. Checkout uses dynamic payment methods, integer server prices, and a 10% service fee. A redirect starts server reconciliation and never proves payment. For local signed webhook delivery, use the Stripe CLI against `/api/payments/webhook` and set the listener's signing secret privately. The deployed webhook uses its configured signing secret.

Cancellation defaults to a full refund before the start, and a full service-disruption refund if the reserved or accepted replacement cannot be provided. Ordinary cancellation after check-in requires operator review. Set `CANCELLATION_POLICY_TEXT` only with a matching policy implementation; changing text alone does not change the refund rules. `CHECK_IN_WINDOW_MINUTES`, `TURNOVER_BUFFER_MINUTES`, and `CLEANING_ESTIMATE_MINUTES` configure the relevant defaults. Keep actor environment values aligned with the API when deploying managed actors.

Without an API key, conversations run in labeled development rules mode through the same domain tools and Relay workers as model mode. Set `OPENAI_API_KEY` and `CONCIERGE_MODE=model` to use OpenAI's `gpt-6-luna` for guest concierge replies and the concierge/room-agent exchanges on the demo page. `CONCIERGE_MODEL` can override the model; `CONCIERGE_MODEL_BASE_URL` can override the Responses API base URL. Existing `MODEL_API_KEY`, `MODEL_NAME`, and `MODEL_BASE_URL` aliases still work. Model replies cannot directly change storage, readiness, or robot commands. Financial and replacement actions require explicit guest confirmation.

The demo labels generated messages with their model and keeps inspection and robot events labeled separately. Each room exchange uses verified room facts and the native actor's inventory decision. Repeated observations do not trigger new model calls. Provider failures show a labeled rules fallback; guest chat failures remain explicit. Secrets stay in the ignored server-side `.env`.

## Verify

```sh
bun run check
bun run test:integration
bun run test:scenario
```

The integration command launches and restarts actual isolated native actor processes, verifies inventory/evidence safety, and runs commerce checks. Available sandbox credentials also exercise real hosted Checkout creation and expiration; successful card payment and refund are separate browser checks recorded in the handoff.

The scenario command runs the 10am to 12pm fixture through real booking services, native actors, the actual Relay engine and workers, and the authenticated Python simulator. Its initial confirmed bookings have explicitly synthetic fixture funding; it never presents those seeds as Stripe payments. The guest's assignment changes only through the actual resumable swap. Controlled clocks are accepted only in isolated `test-*` namespaces with simulated devices.

For a focused running-stack Relay check:

```sh
DATA_DIR=.data/development bun packages/concierge/src/verify.ts
```

## Cloud and physical devices

See [deployment](deploy/README.md) for the always-running container release, managed Terse deployment, private Relay, persistent storage, and exact cloud inputs. [Device commissioning](workers/device/README.md) covers Q10/B01 account authentication, the office VPN/subnet gateway, RTSP capture, and experimental vision configuration. The camera remains private; a supported office router or always-on gateway terminates the VPN. Cloud connectivity, image inference, physical cleaning, and docking require commissioning while the devices are online.

A separate packaged local review runs with `docker compose -f deploy/compose.local.yaml up --build` at [http://127.0.0.1:5174](http://127.0.0.1:5174). Its local native actor runtime is development infrastructure, not the managed production hosting path.

## Handoff and history

[Baseline handoff](docs/baseline-handoff.md) records architecture, contracts, file ownership, verification evidence, and remaining external checks. [Parallel work](docs/parallel-work.md) sets the frontend refinement boundary for Claude and backend/device/cloud ownership for Codex.

Development history is in this repository's timestamped commits and `dev` PR. The repository started empty on 2026-10-31. Commit timestamps are not backdated. Production promotion to `main` requires a separate release request.
