# Deployment

Run one API replica with persistent `/data`. The release starts the Bun API, self-hosted Relaycast engine, separate operations and concierge workers, and authenticated Python device worker. The built React app is served by the API behind Caddy HTTPS. Relaycast and device RPC have no published ports. This MVP does not support multiple API replicas.

## Production inputs

1. A Linux VM with Docker Compose, persistent disk, a DNS name, and TCP 80/443 ingress. Set `ODAS_DOMAIN` and `APP_ORIGIN=https://your-domain`.
2. An authenticated Terse project. The actor directory includes its own lockfile and all type declarations. From `packages/actors`, run `bun ../../node_modules/terse-cli/dist/index.js deploy`. This is the official managed actor hosting path. Configure the printed `TERSE_ACTOR_URL` and a server-side `TERSE_API_KEY`; run `bun run actors:generate` against that contract and rebuild the release. Local `terse actor dev` is for development only. Configure actor environment `CHECK_IN_WINDOW_MINUTES` and `TURNOVER_BUFFER_MINUTES` to match the API; use the documented Terse secrets commands when overriding defaults.
3. Strong `INTERNAL_TOKEN` and `TERSE_ACTOR_SECRET` values (at least 32 random characters), generated privately. Terse API key and the local development secret are different credentials. Never publish either in frontend variables.
4. Stripe **test/sandbox** restricted credentials with Checkout, PaymentIntent read, and refund permissions. Set `STRIPE_SECRET_KEY` and register a signed webhook at `https://your-domain/api/payments/webhook` for Checkout completed/expired/async payment events and refund updates; set `STRIPE_WEBHOOK_SECRET`. Live keys are rejected. Set a stable `STRIPE_INTEGRATION_IDENTIFIER` with an 8-letter suffix. Seller onboarding and payouts are outside this release.
5. `DEVICE_MODE=physical` only after commissioning the explicit room binding in `workers/device/physical.bindings.example.json`. Supply Roborock account credentials privately, an owned Q10/B01 DUID, camera RTSP credentials, and the configured image provider credentials. Leave simulator mode for review.
6. For model concierge set `CONCIERGE_MODE=model`, `MODEL_API_KEY`, `MODEL_NAME`, and optionally `MODEL_BASE_URL`. Without credentials the product identifies development rules mode. Model calls have not been physically or externally verified unless recorded in the handoff.

Copy `.env.example` to `.env`, set these values, and run `docker compose --env-file .env -f deploy/compose.yaml up -d --build`. Secrets stay out of the image and repository. The API derives Secure cookies from the configured HTTPS origin and requires exact Origin plus CSRF tokens for browser mutations; arbitrary forwarded headers do not establish trust.

Provision real operators inside the release with `bun run operator:create --email operator@example.com --groups polk-310 --allow-physical`, supplying `OPERATOR_PASSWORD` privately. Omitting `--allow-physical` creates a test operator that cannot control physical devices. Workspace scopes must be explicit; public signup cannot create operators.

Back up `/data/odas.sqlite`, `/data/relaycast.sqlite`, `/data/relay-identities.json`, and device credential/state files using an application-consistent volume snapshot or SQLite backup. Actor state is hosted separately by Terse. Restore the same Relay identities with their Relaycast database. Run a single release at a time against a volume.

## Private office network

The cloud worker reaches Roborock through Roborock cloud. The camera stays on its office private address. Put a Tailscale subnet router on a supported office router or always-on Linux gateway; advertise only the camera subnet, approve the route, and allow the backend machine to accept it. The camera does not run Tailscale. Install Tailscale on the backend host, accept the approved subnet route, and allow routed traffic from the Docker bridge through the host according to the host firewall. Verify RTSP from **inside the backend container** before marking connected. No public RTSP port forwarding is needed or supported here.

See `workers/device/README.md` for concrete gateway, RTSP/FFmpeg, Q10/B01 authentication, experimental vision API, and commissioning steps. Device and image-provider connections remain unverified until these checks run. An internet outage can prevent Q10 cloud stop/dock delivery; the system does not promise an offline stop or certified people detection.

## Local packaged review

`docker compose -f deploy/compose.local.yaml up --build` starts a separate persistent review stack at `http://127.0.0.1:5174`. It uses native **local development** actors and explicitly simulated devices with rules concierge. This exercises the backend release packaging without presenting a local actor runtime as production hosting. It does not inherit laptop `.env` credentials.

No staging target or deployment secrets were configured in the new repository at initialization. Deployment assets are not evidence of a cloud deployment. Exact verification results are in `docs/baseline-handoff.md`.
