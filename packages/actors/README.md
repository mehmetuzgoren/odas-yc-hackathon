# Native room actors

`RoomActor` uses `terse-sdk/actor` and Terse's serialized mailbox, persisted fields, SQLite transactions, and durable alarms. It makes no provider calls. `snapshot`, `available`, and `command` are its public application methods; implementation helpers use JavaScript private methods.

The API gateway is the only application caller. Actor URLs and API keys stay on the backend. Configure `TERSE_ACTOR_SECRET` for local development and `TERSE_API_KEY` for callers. Deploy this package with `terse deploy` for the officially hosted production path. A `terse actor dev` process is a local development runtime, not a production deployment.

Evidence expires after 30 seconds. Robot observations expire after 60 seconds. An acknowledged command cannot establish observed motion or completion. A restarted dispatcher reconciles uncertain commands rather than blindly repeating them. Fixture runtimes use `ODAS_TEST_MODE=1`, isolated actor projects and explicit ticks; do not point that runtime at hardware.

Run `bun run test:integration` from the repository root for isolated native runtime verification. It starts a fresh runtime, checks atomic competition and evidence safety, actually stops the native processes, restarts the same actor storage, and verifies inventory/job/outbox recovery. It then runs the commerce integration against another isolated native actor project. Required ports are 7191 and 7111; existing processes are never killed to obtain those ports.

`CHECK_IN_WINDOW_MINUTES` and `TURNOVER_BUFFER_MINUTES` configure the actor's windows (defaults 15, supported 0 through 120). Set the same values for the API and hosted actor deployment. They are backend configuration, not guest mutation inputs.
