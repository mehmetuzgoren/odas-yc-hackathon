# Concierge verification evidence

Verified on 2026-10-31 against the supervised development stack with actual Relaycast and two separate application worker processes.

Command:

```sh
DATA_DIR=.data/development API_PORT=3000 WEB_PORT=5173 bun packages/concierge/src/verify.ts
```

The check created ordinary guest accounts through signup, persisted a conversation and guest message, and received an assistant reply with five available office cards from the actual catalog tool. The operations process published the request through Agent Relay; the concierge process handled it and returned a business result. The application outbox completed with Relay message ID `242357652714430464`.

The same integration check verified that a repeated guest request reused its message, that only one assistant reply persisted, that another guest received HTTP 404 for the conversation, and that an authenticated SSE reconnection replayed the owned messages using a saved event cursor. The integration lead independently ran the same check and obtained Relay message ID `242357550964809728`.

`bun run typecheck` passed after integration. The concierge ran in the explicitly labeled `development_rules` mode. A real language model call was not performed. This evidence does not establish live camera or Roborock connectivity, payment fulfillment, or actor restart persistence; their owners report those separately.
