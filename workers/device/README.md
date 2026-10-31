# Backend device worker

The Python process belongs to the backend release. The root development supervisor launches it with the API, native actor runtime, and Relay workers. It needs no bridge application on a guest or developer laptop.

```sh
uv sync --project workers/device --locked
uv run --project workers/device python -m odas_device
```

Set `INTERNAL_TOKEN` to a random secret of at least 24 characters, `DEVICE_PORT=8090`, `DATA_DIR`, and `DEVICE_MODE=simulator` or `physical`. The process binds loopback. A private container deployment may set `DEVICE_HOST=0.0.0.0` and `DEVICE_PRIVATE_CONTAINER=1`, with no public port mapping; authenticated RPC remains required. Do not publish the device port.

## Bindings and simulator

`simulator.bindings.json` explicitly binds one simulated camera/robot contract to `polk-310-office-01`. The other 30 modeled offices have no physical hardware association. Unbound offices return `connection: unverified`, unknown occupancy, and unknown robot state. Set `DEVICE_BINDINGS_FILE` to another JSON file for a different release or isolated fixture.

The simulator returns the same inspection, telemetry, start, and dock contracts as physical adapters. Every observation says `source: simulator`. Simulated starts still require RoomActor's current dispatch authorization. Simulation state and command IDs persist in `DATA_DIR/device/device.sqlite`. Tests can change scripted observations with the private simulator endpoint only when both `ODAS_TEST_MODE=1` and `DEVICE_MODE=simulator`; this control is absent from ordinary customer flows. Keep fixture ports, data directories, and actor projects isolated.

## Camera private network commissioning

The production path is backend device worker -> VPN -> an always-on office subnet router/gateway -> camera RTSP. The camera stays on its office LAN and does not run a VPN client. A cloud server cannot reach a private office address until a route exists.

1. Identify the camera model and verify that it supports RTSP. For Tapo, configure a camera account in the Tapo application and reserve its private LAN address. Current model capabilities and RTSP paths are documented in [Tapo's RTSP FAQ](https://www.tapo.com/en/faqs/tapo-camera-onvif-and-rtsp-common-questions-answered/). Many battery cameras do not support continuous RTSP.
2. Install Tailscale on a supported office router or a dedicated, powered Linux gateway on the camera LAN. Enable IP forwarding on that gateway and advertise only the required camera route, for example `sudo tailscale set --advertise-routes=192.168.50.20/32`. Approve the route in the tailnet administration console. This is an example subnet; replace it with the actual private camera address.
3. Join the always-running backend host to the same tailnet with an appropriate server identity. On a Linux backend accept subnet routes (`sudo tailscale set --accept-routes=true`). Tailnet grants/ACLs should allow the backend server identity only to the camera's RTSP TCP port 554. Ensure forwarding/firewall policy on the office gateway permits this path. See [Tailscale's subnet router setup](https://tailscale.com/docs/features/subnet-routers).
4. Store `OFFICE_CAMERA_RTSP_URL` as a backend secret, for example `rtsp://CAMERA_USER:CAMERA_PASSWORD@192.168.50.20:554/stream2`. Set `DEVICE_BINDINGS_FILE` to a private copy of `physical.bindings.example.json` and confirm the exact workspace/office/camera association. Never commit camera URLs containing credentials.
5. Start the packaged backend and verify a fresh frame from the protected operator camera action. Verify capture sequence increments, capture time remains separate from inference time, and disabling the gateway or RTSP stream produces disconnected/unknown evidence. The API requires operator scope before proxying a frame. Frames are not served in public room state.

The example policy in `tailscale-grants.example.json` and forwarding settings in `office-gateway.sysctl.example.conf` make the route requirements concrete. Replace the example camera address and merge the grants into your existing tailnet policy. Tag the backend `tag:odas-backend` and the office gateway `tag:odas-office-gateway`; do not replace an unrelated tailnet policy wholesale.

No port forwarding, public RTSP address, or camera VPN client is required. One long-lived FFmpeg process runs per configured camera, captures four JPEGs per second, and retains only its latest frame. HTTP JPEG cameras can use `kind: http_jpeg` with the same secret URL mechanism.

The `/demo` backend controls start with Jev and Robo off. Camera capture and the private MJPEG preview continue while Jev is off. Enabling Jev submits every captured frame immediately, with concurrent requests and immediate delivery of completed inspections to the room actor. Robo must be enabled separately before any cleaning start. See [the demo API contract](../../docs/demo-api.md) for controls, status, preview endpoints, cancellation, and concurrency limits.

## Typed image inspection

Set `TYPESAFE_API_KEY` and optionally `TYPESAFE_MODEL` (default `jev-latest`). The adapter uses the documented `POST https://api.typesafe.ai/v1/systemone` image assets format and `TypeSafe-Danger-Zone-Images: true` header. It validates closed-set occupancy, floor, and surface answers and uses the minimum answer confidence. Capture time and sequence identify the source frame; inference completion never refreshes an old image.

TypeSafe currently describes its image API as experimental. See [the current image documentation](https://docs.typesafe.ai/images). This integration is a prototype, not certified occupancy detection. Camera coverage, occlusion, image uncertainty, and provider errors require physical commissioning. Missing credentials return unknown inspection evidence and cannot authorize cleaning.

## Q10/B01 cloud commissioning

The production path is backend worker -> Roborock cloud -> the explicitly bound Q10. `python-roborock==7.13.0` supplies the B01/Q10 driver. The worker keeps its device manager/MQTT connection alive and observes the Q10 status trait. It uses `device.b01_q10_properties`, never a guessed V1 command substitution.

1. Set `ROBOROCK_EMAIL` and provision the existing Roborock account using the supported code login. Run the one-time command below in a private commissioning terminal; it hides the email code and stores account credentials with mode 0600.

   ```sh
   uv run --project workers/device python -m odas_device.auth --email YOUR_EMAIL --output .data/private/roborock-user.json
   ```

2. Mount that credential file privately in the backend and set `ROBOROCK_USER_DATA_FILE` to its absolute path. Set `ROBOROCK_DEVICE_DUID` for the exact robot. Device discovery must expose `b01_q10_properties`; a model using another driver is rejected. Confirm that the whole area reached by a whole-home clean is the intended single office. This release prohibits sharing a physical robot across room bindings.
3. Verify connected telemetry and battery/state without sending motion commands. The driver's `refresh()` sends a query; it does not by itself establish a fresh status timestamp. Only a genuine status update refreshes the worker's observation time. Unchanged cached status can conservatively age out.
4. With the room clear, verify a fresh high-confidence vacancy inspection. Request a clean through the protected operator action. The actor persists request, claim, and dispatch intent; the worker calls the API to recheck that claim and vacancy immediately before the external start. It sets `YXCleanType.VACUUM`, then calls the supported whole-home `start_clean()` for the room-bound robot.
5. Verify observed cleaning telemetry, then `return_to_dock()`, observed docking, and a fresh post-cleaning inspection. A successful vendor response records acceptance, not observed motion or completion. If a command times out or a process dies after intent, reconcile telemetry and operator attention before another start.
6. In a controlled room, verify a person observation during cleaning produces an interruption/dock request. Disconnect camera/VPN and verify cleaning dispatch is blocked and interruption is requested. Disconnect internet and verify that stop delivery is explicitly uncertain.

The Q10's cloud command path depends on internet service. An internet outage can prevent delivery of a stop/dock command. ODAS does not provide an offline stop guarantee or a safety certification. Keep physical deployment supervised until these commissioning checks pass.

Coordinate/zone cleaning and calibration are deferred. This release sends only whole bound-office vacuum cleaning and return-to-dock.

## Status and current verification

Native actor compilation and Python driver imports are checked independently from physical connections. Devices are currently offline; camera routing, live Jev inference, Roborock authentication/telemetry, whole-office motion, interruption, and docking require the commissioning steps above. The simulator never labels its observations as live.
