# Subsequent work

Claude owns frontend refinement after the functional baseline is handed off. Codex owns backend, native actors, runtime workers, payments, physical devices, and cloud commissioning. The integration lead approves shared API/event contract changes, owns root manifests and lockfiles, migrations, composition, and generated native actor clients.

| Area | Follow-up owner | Boundary |
| --- | --- | --- |
| apps/web/src/marketplace, commerce, operations, concierge | Claude | Improve layout, typography, responsive behavior, focus states, copy, and loading/error feedback. Preserve actual services, authentication, interval filters, and explicit guest decisions. |
| apps/web/src/App.tsx, styles.css | Claude with integration lead | Refine shared navigation and tokens; coordinate shared entrypoints. |
| apps/api/src/catalog, commerce, operations, concierge | Codex | Preserve integer server pricing, session ownership, durable financial workflows, and private operator/device data. |
| packages/actors, generated native client | Codex and integration lead | Native actors remain inventory/readiness authority. Regenerate clients after public contract changes. |
| packages/concierge | Codex | Keep actual independently running Relay participants, durable outbox/processed records, and application acknowledgments. |
| workers/device and deploy | Codex | Commission private networking, provider credentials, and hardware. Keep simulator labels and uncertain states honest. |
| packages/contracts, db.ts, root manifests, scripts | Integration lead | Version API/event contracts and serialize dependency/schema changes. |

Frontend work should start from merged `dev`, in its own `codex/` feature branch or Claude's equivalent task branch, with a PR into `dev`. Do not add another mock booking store, fake Checkout response, mirrored replacement reservation, or presenter-only scenario UI. Current product screens already call the actual backend.

Preserve 6 groups and 31 modeled offices, individual prices, unknown property facts, and the user's ivory/green palette. Source photos can be used only when the room/workspace association is known. Refinement should preserve time selection and filters through navigation, use the selected date's IANA offset, and retain explicit replacement acceptance and cancellation policy review.

Do not retain the completed feature worktree while waiting for production. The integration lead retires it after the exact changes are confirmed merged into GitHub `dev`, preserving needed ignored review state in the primary checkout and keeping this chat open. Production promotion requires the user's release request.

The integration lead owns the shared type declarations in `packages/actors/src/contracts.ts`, re-exported by `packages/contracts/src/index.ts`. This keeps the official managed Terse source archive self-contained; app runtime schemas and constants remain in `packages/contracts`. The actor contract is unchanged.
