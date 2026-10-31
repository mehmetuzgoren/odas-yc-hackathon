from __future__ import annotations
import asyncio
import hmac
import json
import os
import time
import uuid
from pathlib import Path
from aiohttp import ClientSession, web
from .camera import Camera
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

    async def open(self, app):
        self.session = ClientSession()
        self.vision = Vision(self.session)
        if self.mode == 'physical':
            self.robot = Q10Cloud(self.session)
            self.robot.start()
            for camera_id, config in self.config.get('cameras', {}).items():
                camera = Camera(camera_id, config, self.store, self.session)
                camera.start()
                self.cameras[camera_id] = camera

    async def close(self, app):
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
        camera = self.cameras.get(binding.get('cameraId', ''))
        if not camera or not camera.frame or not camera.connected or now - camera.frame.captured_at > 15000:
            return web.json_response({**base, 'connection': 'disconnected', 'error': 'No fresh camera frame. Private network route and camera credentials require commissioning.'})
        frame = camera.frame
        base.update({'capturedAt': frame.captured_at, 'sequence': frame.sequence, 'frameId': f'{camera.id}:{frame.sequence}', 'connection': 'connected'})
        try:
            result = await self.vision.inspect(frame.jpeg)
            return web.json_response({**base, **result, 'inferredAt': int(time.time() * 1000)})
        except Exception:
            return web.json_response({**base, 'inferredAt': int(time.time() * 1000), 'error': 'Vision inference failed. Readiness is not established.'})

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
        base = os.environ.get('API_INTERNAL_URL', f"http://127.0.0.1:{os.environ.get('API_PORT', '3000')}")
        try:
            async with self.session.post(f'{base}/api/internal/devices/authorize', json={'roomId': room_id, 'commandId': command_id}, headers={'Authorization': f'Bearer {self.token}'}, timeout=5) as response:
                return response.status == 200 and (await response.json()).get('authorized') is True
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
