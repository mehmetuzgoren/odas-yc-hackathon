from __future__ import annotations
import asyncio
import hmac
import json
import os
import time
import uuid
from pathlib import Path
from aiohttp import ClientSession, web
from .camera import Camera, Frame
from .live import LiveInspections
from .robot import Q10Cloud
from .storage import Store
from .vision import Vision

ROOT = Path(__file__).resolve().parent.parent

class Worker:
    def __init__(self):
        self.token = os.environ.get('INTERNAL_TOKEN', '')
        if len(self.token) < 24:
            raise RuntimeError('INTERNAL_TOKEN must contain at least 24 characters')
        self.mode = os.environ.get('DEVICE_MODE', 'simulator')
        self.test_mode = os.environ.get('ODAS_TEST_MODE') == '1'
        if self.test_mode and self.mode == 'physical':
            raise RuntimeError('Test clocks cannot be combined with physical devices')
        self.store = Store(str(Path(os.environ.get('DATA_DIR', '.data/development')) / 'device'))
        configured = os.environ.get('DEVICE_BINDINGS_FILE', '')
        path = Path(configured) if configured else ROOT / 'simulator.bindings.json'
        self.config = json.loads(path.read_text()) if path.exists() else {'bindings': [], 'cameras': {}}
        self.bindings = {b['roomId']: b for b in self.config.get('bindings', [])}
        if len(self.bindings) != len(self.config.get('bindings', [])):
            raise RuntimeError('Each room must have exactly one explicit device binding')
        robots = [os.environ.get(b['robotDuidEnv']) or b['robotDuidEnv'] for b in self.bindings.values() if b.get('robotDuidEnv')]
        if len(robots) != len(set(robots)):
            raise RuntimeError('This release supports one room per physical robot; duplicate robot ownership is prohibited')
        self.session: ClientSession | None = None
        self.cameras: dict[str, Camera] = {}
        self.robot: Q10Cloud | None = None
        self.vision: Vision | None = None
        self.live: dict[str, LiveInspections] = {}
        self.control_locks: dict[str, asyncio.Lock] = {}

    async def open(self, app):
        self.session = ClientSession()
        self.vision = Vision(self.session)
        for room_id, binding in self.bindings.items():
            if self.binding(room_id):
                self.live[room_id] = LiveInspections(room_id, binding.get('cameraId', ''), self.vision, self.publish_inspection)
                self.control_locks[room_id] = asyncio.Lock()
        if self.mode == 'physical':
            self.robot = Q10Cloud(self.session)
            self.robot.start()
            for camera_id, config in self.config.get('cameras', {}).items():
                camera = Camera(camera_id, config, self.store, self.session, lambda frame, camera_id=camera_id: self.captured(camera_id, frame))
                camera.start()
                self.cameras[camera_id] = camera

    async def close(self, app):
        for live in self.live.values():
            await live.close()
        for camera in self.cameras.values():
            await camera.close()
        if self.robot:
            await self.robot.close()
        if self.session:
            await self.session.close()

    def now(self, request) -> int:
        return int(request.query.get('now', time.time() * 1000)) if self.test_mode else int(time.time() * 1000)

    def binding(self, room_id: str) -> dict | None:
        binding = self.bindings.get(room_id)
        if not binding or binding.get('mode', self.mode) != self.mode:
            return None
        return binding

    def sim(self, room_id: str) -> dict:
        return self.store.get(f'sim:{room_id}', {'occupancy': 'vacant', 'floor': 'clean', 'surfaces': 'clear', 'confidence': 0.99, 'connection': 'connected', 'state': 'docked', 'battery': 100, 'cleaningDurationMs': 600000})

    def captured(self, camera_id: str, frame: Frame) -> None:
        for live in self.live.values():
            if live.camera_id == camera_id:
                live.submit(frame)

    async def publish_inspection(self, observation: dict) -> bool:
        base = os.environ.get('API_INTERNAL_URL', f"http://127.0.0.1:{os.environ.get('API_PORT', '3000')}")
        async with self.session.post(f'{base}/api/internal/devices/inspection', json=observation, headers={'Authorization': f'Bearer {self.token}'}, timeout=5) as response:
            return response.status == 200 and (await response.json()).get('accepted') is True

    def demo_state(self, room_id: str) -> dict:
        live = self.live.get(room_id)
        if not live:
            raise web.HTTPNotFound(reason='No device is bound to this office.')
        camera = self.cameras.get(live.camera_id)
        frame = camera.frame if camera else None
        fresh = bool(camera and camera.connected and frame and time.time() * 1000 - frame.captured_at <= 15000)
        return {
            'roomId': room_id, 'mode': self.mode, 'captureFps': 4, **live.status(),
            'camera': {'connected': fresh, 'capturedAt': frame.captured_at if frame else None, 'sequence': frame.sequence if frame else None, 'framesCaptured': camera.frames_captured if camera else 0},
        }

    async def demo_status(self, request):
        return web.json_response(self.demo_state(request.match_info['room_id']))

    async def configure_demo(self, request):
        room_id = request.match_info['room_id']
        if room_id not in self.live:
            raise web.HTTPNotFound()
        changes = await request.json()
        if not isinstance(changes, dict) or not changes or any(key not in ('jevEnabled', 'roboEnabled') or type(value) is not bool for key, value in changes.items()):
            raise web.HTTPBadRequest(reason='Set jevEnabled and/or roboEnabled to a boolean.')
        async with self.control_locks[room_id]:
            was_enabled = self.live[room_id].jev_enabled
            await self.live[room_id].configure(changes)
            if was_enabled and not self.live[room_id].jev_enabled and self.mode == 'physical':
                observation = self.empty_inspection(room_id, 'Jev analysis is disabled.')
                try:
                    await self.publish_inspection(observation)
                except Exception:
                    self.live[room_id].last_error = 'Jev is off; could not invalidate the previous room inspection.'
            return web.json_response(self.demo_state(room_id))

    def empty_inspection(self, room_id: str, error: str) -> dict:
        now = int(time.time() * 1000)
        live = self.live.get(room_id)
        camera = self.cameras.get(live.camera_id) if live else None
        connected = bool(camera and camera.connected and camera.frame and now - camera.frame.captured_at <= 15000)
        return {'id': f'inspection_{uuid.uuid4()}', 'roomId': room_id, 'source': 'camera', 'capturedAt': now, 'inferredAt': now, 'sequence': self.store.sequence(f'inspection:{room_id}'), 'occupancy': 'unknown', 'confidence': 0, 'floor': 'unknown', 'surfaces': 'unknown', 'connection': 'connected' if connected else 'disconnected', 'error': error}

    async def inspection(self, request):
        room_id = request.match_info['room_id']
        now = self.now(request)
        base = {'id': f'inspection_{uuid.uuid4()}', 'roomId': room_id, 'source': 'simulator' if self.mode == 'simulator' else 'camera', 'capturedAt': now, 'inferredAt': now, 'sequence': self.store.sequence(f'inspection:{room_id}'), 'occupancy': 'unknown', 'confidence': 0, 'floor': 'unknown', 'surfaces': 'unknown', 'connection': 'unverified'}
        binding = self.binding(room_id)
        if not binding:
            return web.json_response({**base, 'error': 'No device binding is configured for this office.'})
        if self.mode == 'simulator':
            state = self.sim(room_id)
            if state.get('state') == 'cleaning' and now >= state.get('finishAt', now + 1):
                state.update({'state': 'docked', 'floor': 'clean'})
                self.store.put(f'sim:{room_id}', state)
            return web.json_response({**base, **{k: state[k] for k in ('occupancy', 'floor', 'surfaces', 'confidence', 'connection')}})
        live = self.live[room_id]
        if not live.jev_enabled:
            return web.json_response(self.empty_inspection(room_id, 'Jev analysis is disabled.'))
        camera = self.cameras.get(binding.get('cameraId', ''))
        if not camera or not camera.frame or not camera.connected or now - camera.frame.captured_at > 15000:
            return web.json_response({**base, 'connection': 'disconnected', 'error': 'No fresh camera frame. Private network route and camera credentials require commissioning.'})
        return web.json_response(live.latest or self.empty_inspection(room_id, 'Waiting for the first Jev result.'))

    async def telemetry(self, request):
        room_id = request.match_info['room_id']
        now = self.now(request)
        binding = self.binding(room_id)
        if not binding:
            return web.json_response({'roomId': room_id, 'source': 'simulator' if self.mode == 'simulator' else 'roborock', 'observedAt': now, 'connection': 'unverified', 'state': 'unknown', 'error': 'No robot is bound to this office.'})
        if self.mode == 'simulator':
            state = self.sim(room_id)
            if state.get('state') == 'cleaning' and now >= state.get('finishAt', now + 1):
                state.update({'state': 'docked', 'floor': 'clean'})
                self.store.put(f'sim:{room_id}', state)
            return web.json_response({'roomId': room_id, 'source': 'simulator', 'observedAt': now, 'connection': state['connection'], 'state': state['state'], 'battery': state['battery'], 'commandId': state.get('commandId')})
        duid = os.environ.get(binding.get('robotDuidEnv', ''), '')
        if not duid:
            return web.json_response({'roomId': room_id, 'source': 'roborock', 'observedAt': 0, 'connection': 'unverified', 'state': 'unknown', 'error': 'Robot DUID configuration has not been commissioned.'})
        return web.json_response(await self.robot.telemetry(room_id, duid))

    async def authorized(self, room_id: str, command_id: str) -> bool:
        live = self.live.get(room_id)
        if not live or not live.robo_enabled or self.mode == 'physical' and not live.jev_enabled:
            return False
        base = os.environ.get('API_INTERNAL_URL', f"http://127.0.0.1:{os.environ.get('API_PORT', '3000')}")
        try:
            async with self.session.post(f'{base}/api/internal/devices/authorize', json={'roomId': room_id, 'commandId': command_id}, headers={'Authorization': f'Bearer {self.token}'}, timeout=5) as response:
                return response.status == 200 and (await response.json()).get('authorized') is True and live.robo_enabled and (self.mode != 'physical' or live.jev_enabled)
        except Exception:
            return False

    async def action(self, request):
        room_id = request.match_info['room_id']
        kind = request.match_info['kind']
        body = await request.json()
        command_id = body.get('commandId')
        if not isinstance(command_id, str) or not command_id or len(command_id) > 2000:
            raise web.HTTPBadRequest(text=json.dumps({'error': 'A durable command ID is required'}), content_type='application/json')
        binding = self.binding(room_id)
        if not binding:
            return web.json_response({'accepted': False, 'uncertain': False, 'message': 'No device is bound to this office.'})
        duplicate = self.store.claim(command_id, room_id, kind)
        if duplicate is not None:
            return web.json_response(duplicate)
        if kind == 'start' and not self.live[room_id].robo_enabled:
            return web.json_response(self.store.finish(command_id, {'accepted': False, 'uncertain': False, 'message': 'Robo cleaning is disabled.'}))
        # Recheck the authoritative actor immediately before a delayed physical/simulated start.
        if kind == 'start' and not await self.authorized(room_id, command_id):
            return web.json_response(self.store.finish(command_id, {'accepted': False, 'uncertain': False, 'message': 'RoomActor dispatch authorization or fresh vacancy has expired.'}))
        if self.mode == 'simulator':
            now = self.now(request)
            state = self.sim(room_id)
            if state['connection'] != 'connected':
                return web.json_response(self.store.finish(command_id, {'accepted': False, 'uncertain': True, 'message': 'Simulated device is disconnected.'}))
            if kind == 'start':
                state.update({'state': 'cleaning', 'finishAt': now + int(state['cleaningDurationMs']), 'commandId': command_id})
            else:
                state.update({'state': 'docked', 'commandId': command_id})
            self.store.put(f'sim:{room_id}', state)
            return web.json_response(self.store.finish(command_id, {'accepted': True, 'uncertain': False, 'message': 'Simulator accepted the command. Motion is established separately by telemetry.'}))
        duid = os.environ.get(binding.get('robotDuidEnv', ''), '')
        try:
            if kind == 'start':
                await self.robot.start_vacuum(duid, lambda: self.authorized(room_id, command_id))
            else:
                await self.robot.dock(duid)
            return web.json_response(self.store.finish(command_id, {'accepted': True, 'uncertain': False, 'message': 'Vendor accepted the command; observed motion still requires telemetry.'}))
        except Exception:
            return web.json_response(self.store.finish(command_id, {'accepted': False, 'uncertain': True, 'message': 'Cloud command delivery is uncertain. Do not repeat without reconciling telemetry.'}))

    async def simulate(self, request):
        if self.mode != 'simulator' or not self.test_mode:
            raise web.HTTPForbidden()
        room_id = request.match_info['room_id']
        if not self.binding(room_id):
            raise web.HTTPNotFound()
        body = await request.json()
        allowed = {'occupancy': {'vacant', 'occupied', 'unknown'}, 'floor': {'clean', 'dirty', 'unknown'}, 'surfaces': {'clear', 'cluttered', 'unknown'}, 'connection': {'connected', 'disconnected', 'unverified'}, 'state': {'docked', 'cleaning', 'idle', 'returning', 'error', 'unknown'}}
        for key, options in allowed.items():
            if key in body and body[key] not in options:
                raise web.HTTPBadRequest()
        for key in ('confidence', 'cleaningDurationMs', 'finishAt', 'battery'):
            if key in body and not isinstance(body[key], (int, float)):
                raise web.HTTPBadRequest()
        if 'confidence' in body and not 0 <= body['confidence'] <= 1:
            raise web.HTTPBadRequest()
        if 'cleaningDurationMs' in body and not 100 <= body['cleaningDurationMs'] <= 3600000:
            raise web.HTTPBadRequest()
        state = self.sim(room_id)
        state.update({key: value for key, value in body.items() if key in allowed or key in ('confidence', 'cleaningDurationMs', 'finishAt', 'battery')})
        self.store.put(f'sim:{room_id}', state)
        return web.json_response({'ok': True, 'source': 'simulator', 'state': state})

    async def frame(self, request):
        binding = self.binding(request.match_info['room_id'])
        camera = self.cameras.get(binding.get('cameraId')) if binding else None
        if not camera or not camera.frame or not camera.connected or time.time() * 1000 - camera.frame.captured_at > 15000:
            raise web.HTTPServiceUnavailable(text='No verified fresh camera frame is available')
        return web.Response(body=camera.frame.jpeg, content_type='image/jpeg', headers={'Cache-Control': 'no-store'})

    async def stream(self, request):
        binding = self.binding(request.match_info['room_id'])
        camera = self.cameras.get(binding.get('cameraId')) if binding else None
        if not camera:
            raise web.HTTPServiceUnavailable(reason='No camera is configured.')
        response = web.StreamResponse(headers={'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store'})
        await response.prepare(request)
        sequence = 0
        try:
            while True:
                frame = camera.frame
                if frame and frame.sequence != sequence and camera.connected:
                    await response.write(b'--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + str(len(frame.jpeg)).encode() + b'\r\n\r\n' + frame.jpeg + b'\r\n')
                    sequence = frame.sequence
                camera.changed.clear()
                if camera.frame is frame:
                    try:
                        await asyncio.wait_for(camera.changed.wait(), 5)
                    except asyncio.TimeoutError:
                        if request.transport is None or request.transport.is_closing():
                            break
        except (ConnectionResetError, BrokenPipeError):
            pass
        return response

    def app(self):
        @web.middleware
        async def auth(request, handler):
            if not hmac.compare_digest(request.headers.get('Authorization', ''), f'Bearer {self.token}'):
                return web.json_response({'error': 'Private device authentication is required'}, status=401)
            try:
                return await handler(request)
            except web.HTTPException as error:
                return web.json_response({'error': error.reason}, status=error.status)
            except Exception:
                return web.json_response({'error': 'Device request failed; inspect connection and commissioning status'}, status=503)
        app = web.Application(middlewares=[auth], client_max_size=100000)
        app.on_startup.append(self.open)
        app.on_cleanup.append(self.close)
        async def health(request):
            return web.json_response({'ok': True, 'mode': self.mode, 'boundRooms': list(self.bindings), 'physicalVerified': False})
        app.router.add_get('/health', health)
        app.router.add_get('/v1/rooms/{room_id}/inspection', self.inspection)
        app.router.add_get('/v1/rooms/{room_id}/telemetry', self.telemetry)
        app.router.add_get('/v1/rooms/{room_id}/frame', self.frame)
        app.router.add_get('/v1/rooms/{room_id}/stream', self.stream)
        app.router.add_get('/v1/rooms/{room_id}/demo', self.demo_status)
        app.router.add_patch('/v1/rooms/{room_id}/demo', self.configure_demo)
        app.router.add_post('/v1/rooms/{room_id}/simulate', self.simulate)
        app.router.add_post('/v1/rooms/{room_id}/{kind:start|dock}', self.action)
        return app

if __name__ == '__main__':
    worker = Worker()
    # Device RPC is private. Production may use a private container network instead.
    host = os.environ.get('DEVICE_HOST', '127.0.0.1')
    if host not in ('127.0.0.1', '::1') and os.environ.get('DEVICE_PRIVATE_CONTAINER') != '1':
        raise RuntimeError('Non-loopback device RPC requires an explicitly private container network')
    web.run_app(worker.app(), host=host, port=int(os.environ.get('DEVICE_PORT', '8090')), print=lambda _: print('ODAS authenticated device worker started'))
