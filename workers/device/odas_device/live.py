from __future__ import annotations
import asyncio
import time
import uuid
from collections.abc import Awaitable, Callable
from .camera import Frame
from .vision import Vision, VisionError


class LiveInspections:
    """Submit on capture, independently of inference latency. No waiting-frame queue."""
    MAX_IN_FLIGHT = 64

    def __init__(self, room_id: str, camera_id: str, vision: Vision, publish: Callable[[dict], Awaitable[bool]]):
        self.room_id = room_id
        self.camera_id = camera_id
        self.vision = vision
        self.publish = publish
        self.jev_enabled = False
        self.robo_enabled = False
        self.generation = 0
        self.tasks: set[asyncio.Task] = set()
        self.latest: dict | None = None
        self.submitted = self.completed = self.applied = self.failed = self.dropped = self.superseded = 0
        self.last_latency_ms: int | None = None
        self.last_error: str | None = None
        self.retry_at = 0.0
        self.backoff = 0.5

    def submit(self, frame: Frame) -> None:
        if not self.jev_enabled:
            return
        if len(self.tasks) >= self.MAX_IN_FLIGHT or time.monotonic() < self.retry_at:
            self.dropped += 1
            if len(self.tasks) >= self.MAX_IN_FLIGHT:
                self.last_error = 'Jev is still processing earlier frames; new frames are being skipped.'
            return
        self.submitted += 1
        task = asyncio.create_task(self._inspect(frame, self.generation))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def configure(self, changes: dict) -> None:
        if 'roboEnabled' in changes:
            self.robo_enabled = changes['roboEnabled']
        if 'jevEnabled' not in changes or changes['jevEnabled'] == self.jev_enabled:
            return
        self.jev_enabled = changes['jevEnabled']
        self.generation += 1
        self.latest = None
        self.last_error = None
        self.retry_at = 0
        self.backoff = 0.5
        pending = list(self.tasks)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    async def _inspect(self, frame: Frame, generation: int) -> None:
        started = time.monotonic()
        observation = {
            'id': f'inspection_{uuid.uuid4()}', 'roomId': self.room_id, 'source': 'camera',
            'capturedAt': frame.captured_at, 'inferredAt': frame.captured_at,
            'sequence': frame.sequence, 'frameId': f'{self.camera_id}:{frame.sequence}',
            'occupancy': 'unknown', 'floor': 'unknown', 'surfaces': 'unknown',
            'confidence': 0, 'connection': 'connected',
        }
        try:
            try:
                result = await self.vision.inspect(frame.jpeg)
                self.completed += 1
                observation.update(result)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self.failed += 1
                message = str(error) if isinstance(error, VisionError) else 'Jev inspection failed.'
                observation['error'] = message
                if isinstance(error, VisionError) and error.retryable:
                    self.retry_at = time.monotonic() + self.backoff
                    self.backoff = min(self.backoff * 2, 8)
            if not self.jev_enabled or generation != self.generation:
                return
            if self.latest and frame.sequence <= self.latest['sequence']:
                self.superseded += 1
                return
            observation['inferredAt'] = int(time.time() * 1000)
            self.last_latency_ms = round((time.monotonic() - started) * 1000)
            self.last_error = observation.get('error')
            self.latest = observation
            if await self.publish(observation):
                self.applied += 1
            elif self.jev_enabled and generation == self.generation:
                self.last_error = 'Room state did not accept this inspection.'
        except asyncio.CancelledError:
            raise
        except Exception:
            self.last_error = 'Could not deliver the inspection to the room actor.'

    def status(self) -> dict:
        return {
            'jevEnabled': self.jev_enabled, 'roboEnabled': self.robo_enabled,
            'vision': {
                'submitted': self.submitted, 'completed': self.completed, 'applied': self.applied,
                'failed': self.failed, 'dropped': self.dropped, 'superseded': self.superseded,
                'inFlight': len(self.tasks), 'maxInFlight': self.MAX_IN_FLIGHT,
                'lastLatencyMs': self.last_latency_ms, 'lastError': self.last_error,
                'retryAfterMs': max(0, round((self.retry_at - time.monotonic()) * 1000)),
            },
            'inspection': self.latest,
        }

    async def close(self) -> None:
        await self.configure({'jevEnabled': False, 'roboEnabled': False})
