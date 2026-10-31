# Camera demo API

The frontend page lives at `/demo`, with Polk 310 first. Each room monitor shows the camera, two independent controls, and a conversation between the agents.

Lion in Polk 310 has room ID `polk-310-office-01`. Use that stable ID in the endpoints below. All operator endpoints require the existing session cookie and workspace scope. Physical controls require a physical-capable operator account or an explicit room grant. Grant a scoped host access with `bun run operator:grant-control --email host@example.com --rooms polk-310-office-01`. The room detail response exposes `canControlDevices` for the UI. PATCH requests use the existing application Origin and CSRF headers; the web `api()` helper supplies them.

| Method | Endpoint | Result |
| --- | --- | --- |
| GET | `/api/operator/rooms/:id/demo` | Controls, camera and inference status, and authoritative room `state` |
| PATCH | `/api/operator/rooms/:id/demo` | Change one or both controls; return status and room `state` |
| GET | `/api/operator/rooms/:id/stream` | Continuous multipart JPEG preview at four frames per second |
| GET | `/api/operator/rooms/:id/frame` | One current JPEG, independent of whether Jev is enabled |
| GET | `/api/operator/rooms/:id/conversation` | Last 100 durable agent messages, oldest first |

The conversation shows room condition changes, cleaning requests and outcomes, robot movement, and changes to the concierge's availability decision. Routine toggle messages, unverified inspection chatter, initial robot status, and internal dispatch steps stay out of the feed. Existing routine messages are filtered without deleting stored history. Repeated frames, timestamps, battery levels, and details that leave the availability decision unchanged do not repeat an exchange. Older snapshots cannot overwrite a newer conversation state. Concierge questions and room answers come from the concierge's actual Relay event handler and the native room inventory check. Cleaning starts and completion are reported only after robot telemetry confirms them. Simulator observations are labeled. The UI polls this small feed once per second and preserves its history across refreshes.

## Controls

Both controls start **off** whenever the device worker starts. They are shared backend state for the room, so refreshing a page reads the actual current values rather than resetting them. They do not persist across worker restarts.

- **Jev** controls four vision checks per second, one for each newly captured JPEG. It does not control the camera or Robo.
- **Robo** permits vacuum dispatch through the existing safety checks. It does not control capture, preview, or Jev checks. Physical dispatch still requires fresh Jev vacancy evidence.

Camera capture and the MJPEG preview run independently at four frames per second, including when both controls are off. The browser keeps the stream connected through toggle changes and retries a failed preview. If an RTSP decoder stalls without delivering a complete frame for eight seconds, the worker stops it and reconnects. A disconnected camera stays visibly disconnected until real frames resume.

```json
{"jevEnabled": true}
```

```json
{"roboEnabled": true}
```

```json
{"jevEnabled": false, "roboEnabled": false}
```

The camera continues capturing and previewing four JPEGs per second with both controls off. With Jev on, each captured JPEG immediately starts one request containing the occupancy, floor, and surfaces questions. Requests overlap when inference takes longer than 250 ms. A completed response updates the durable room actor immediately; an older frame cannot overwrite a newer result. Capture and inference timestamps stay separate.

Turning Jev off stops new requests, cancels local requests in progress, rejects late responses from the previous enabled session, and invalidates the previous camera inspection to unknown. The physical inspection endpoint reads the latest result; manual inspections and maintenance do not send extra Jev requests.

Robo off blocks both automatic and manual cleaning starts, including at the device authorization boundary. Turning Robo off cancels a queued cleaning job or requests docking for an active job. A `dockResult` in the PATCH response describes delivery; `uncertain: true` must remain visible. Docking requests remain available while Robo is off. Enabling Robo permits the existing cleaning workflow; it does not bypass vacancy, confidence, telemetry, or actor authorization checks, and does not claim a robot is connected.

## Status

GET and PATCH return this shape, plus the full existing `RoomSnapshot` in `state`:

```json
{
  "roomId": "polk-310-office-01",
  "mode": "physical",
  "captureFps": 4,
  "jevEnabled": false,
  "roboEnabled": false,
  "camera": {
    "connected": true,
    "capturedAt": 1793476110490,
    "sequence": 1793476110490740,
    "framesCaptured": 20
  },
  "vision": {
    "submitted": 0,
    "completed": 0,
    "applied": 0,
    "failed": 0,
    "dropped": 0,
    "superseded": 0,
    "inFlight": 0,
    "maxInFlight": 64,
    "lastLatencyMs": null,
    "lastError": null,
    "retryAfterMs": 0
  },
  "inspection": null,
  "state": {}
}
```

The example timestamps and counters illustrate the response format. `state` contains the complete actor snapshot in actual responses. `inspection` contains the latest completed Jev result while enabled, or null before the first result and when disabled. Use `state` for room readiness. Poll status every 250 ms for the demo; use the MJPEG stream for the camera image rather than repeatedly downloading the full room detail response. `lastLatencyMs` measures the inference request; `inferredAt - capturedAt` includes any time between capture and inference completion.

The worker keeps at most 64 requests in flight and does not queue stale frames. Provider rate limits trigger a short exponential backoff. `dropped`, `retryAfterMs`, and `lastError` expose skipped frames and provider failures. The camera keeps running at four FPS during backoff. `superseded` counts completed older frames that were ignored to preserve ordering. Counters reset with the worker.

The worker pushes completed inspections to authenticated `POST /api/internal/devices/inspection`. This endpoint is private and is not called by the browser. The API validates the explicit physical binding, persists the inspection in the existing room actor, and delivers resulting events through the existing Relay outbox. Camera URLs, passwords, API keys, and the private worker token stay on the backend.
