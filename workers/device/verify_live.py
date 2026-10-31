"""HTTP integration checks for capture cadence, concurrent inference, and demo controls.

Uses a generated camera image and a delayed vision fixture; no vendor or hardware calls.
"""
from __future__ import annotations
import asyncio
import io
import json
import os
import tempfile
import time
from pathlib import Path
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image
import odas_device.__main__ as device


async def verify():
    token = 'isolated-live-worker-verification-token'
    received = []
    latest_sequence = 0
    async def observe(request):
        nonlocal latest_sequence
        assert request.headers.get('Authorization') == f'Bearer {token}'
        observation = await request.json()
        accepted = observation['sequence'] > latest_sequence
        if accepted:
            latest_sequence = observation['sequence']
            received.append(observation)
        return web.json_response({'accepted': accepted})
    async def authorize(request):
        assert request.headers.get('Authorization') == f'Bearer {token}'
        return web.json_response({'authorized': True})
    api = web.Application()
    api.router.add_post('/api/internal/devices/inspection', observe)
    api.router.add_post('/api/internal/devices/authorize', authorize)
    output = io.BytesIO()
    Image.new('RGB', (320, 320), 'white').save(output, 'JPEG')
    camera_app = web.Application()
    async def photo(_):
        return web.Response(body=output.getvalue(), content_type='image/jpeg')
    camera_app.router.add_get('/photo', photo)

    class DelayedVision:
        starts = []
        active = peak = 0
        def __init__(self, _):
            pass
        async def inspect(self, _):
            self.starts.append(time.monotonic())
            self.active += 1
            self.peak = max(self.peak, self.active)
            try:
                # Some older frames finish after newer ones.
                await asyncio.sleep(0.8 if len(self.starts) % 4 == 1 else 0.04)
                return {'occupancy': 'occupied', 'floor': 'clean', 'surfaces': 'clear', 'confidence': 0.99}
            except asyncio.CancelledError:
                # A provider may already have completed after local cancellation.
                await asyncio.sleep(0.02)
                return {'occupancy': 'vacant', 'floor': 'clean', 'surfaces': 'clear', 'confidence': 0.99}
            finally:
                self.active -= 1

    class RobotFixture:
        starts = 0
        def __init__(self, _):
            pass
        def start(self):
            pass
        async def start_vacuum(self, _, authorize):
            assert await authorize()
            self.starts += 1
        async def close(self):
            pass

    original_environment = os.environ.copy()
    original_vision, original_robot = device.Vision, device.Q10Cloud
    async with TestServer(api) as api_server, TestServer(camera_app) as camera_server:
        with tempfile.TemporaryDirectory(prefix='odas-live-worker-') as directory:
            bindings = Path(directory) / 'bindings.json'
            bindings.write_text(json.dumps({'bindings': [{'roomId': 'fixture-lion', 'mode': 'physical', 'cameraId': 'fixture-camera'}], 'cameras': {'fixture-camera': {'kind': 'http_jpeg', 'urlEnv': 'FIXTURE_CAMERA_URL'}}}))
            os.environ.update({'INTERNAL_TOKEN': token, 'DEVICE_MODE': 'physical', 'ODAS_TEST_MODE': '0', 'DATA_DIR': directory, 'DEVICE_BINDINGS_FILE': str(bindings), 'FIXTURE_CAMERA_URL': str(camera_server.make_url('/photo')), 'API_INTERNAL_URL': str(api_server.make_url('')).rstrip('/')})
            device.Vision, device.Q10Cloud = DelayedVision, RobotFixture
            worker = device.Worker()
            try:
                async with TestClient(TestServer(worker.app()), headers={'Authorization': f'Bearer {token}'}) as client:
                    path = '/v1/rooms/fixture-lion'
                    async def status():
                        response = await client.get(path + '/demo')
                        assert response.status == 200
                        return await response.json()
                    async def configure(changes):
                        response = await client.patch(path + '/demo', json=changes)
                        assert response.status == 200
                        return await response.json()
                    initial = await status()
                    assert initial['jevEnabled'] is False and initial['roboEnabled'] is False
                    denied = await client.get(path + '/demo', headers={'Authorization': ''})
                    assert denied.status == 401
                    invalid = await client.patch(path + '/demo', json={'jevEnabled': 'true'})
                    assert invalid.status == 400
                    await asyncio.sleep(0.8)
                    off = await status()
                    assert off['camera']['framesCaptured'] >= 3 and off['vision']['submitted'] == 0
                    async with client.get(path + '/stream') as stream:
                        first = await asyncio.wait_for(stream.content.readuntil(b'\xff\xd9\r\n'), 2)
                        assert b'Content-Type: image/jpeg' in first
                    denied = await (await client.post(path + '/start', json={'commandId': 'off-start'})).json()
                    assert denied['accepted'] is False and 'disabled' in denied['message']

                    await configure({'jevEnabled': True})
                    await asyncio.sleep(2.4)
                    on = await status()
                    assert on['roboEnabled'] is False
                    assert 7 <= on['vision']['submitted'] <= 12, on
                    assert worker.vision.peak > 1, 'Inference serialized frame capture'
                    starts = worker.vision.starts
                    interval = (starts[-1] - starts[0]) / (len(starts) - 1)
                    assert 0.19 <= interval <= 0.36, interval
                    assert len(received) >= 5
                    assert all(a['sequence'] < b['sequence'] for a, b in zip(received, received[1:]))
                    assert all(o['capturedAt'] <= o['inferredAt'] and o['source'] == 'camera' for o in received)
                    assert on['vision']['superseded'] > 0

                    await configure({'roboEnabled': True})
                    accepted = await (await client.post(path + '/start', json={'commandId': 'enabled-start'})).json()
                    assert accepted['accepted'] is True and worker.robot.starts == 1
                    await configure({'roboEnabled': False})
                    denied = await (await client.post(path + '/start', json={'commandId': 'disabled-again'})).json()
                    assert denied['accepted'] is False and worker.robot.starts == 1

                    disabled = await configure({'jevEnabled': False})
                    count = len(received)
                    assert received[-1]['occupancy'] == 'unknown' and 'disabled' in received[-1]['error']
                    await asyncio.sleep(0.8)
                    final = await status()
                    assert len(received) == count, 'A late provider response replaced disabled state'
                    assert final['vision']['submitted'] == disabled['vision']['submitted']
                    assert final['vision']['inFlight'] == 0
                    assert final['camera']['framesCaptured'] > disabled['camera']['framesCaptured']
                    assert final['jevEnabled'] is False and final['roboEnabled'] is False
                    print(json.dumps({'ok': True, 'meanSubmissionIntervalMs': round(interval * 1000), 'concurrentInference': True, 'liveResults': count - 1, 'verified': ['four captures/submissions per second', 'preview with Jev off', 'off defaults', 'typed controls and private authentication', 'out-of-order response protection', 'late response cancellation', 'Robo command boundary']}))
            finally:
                worker.store.db.close()
                device.Vision, device.Q10Cloud = original_vision, original_robot
                os.environ.clear()
                os.environ.update(original_environment)


if __name__ == '__main__':
    asyncio.run(verify())
