from __future__ import annotations
import asyncio
import os
import time
from dataclasses import dataclass
from urllib.parse import urlparse
from aiohttp import ClientSession
from .storage import Store

@dataclass(frozen=True)
class Frame:
    jpeg: bytes
    captured_at: int
    sequence: int

class Camera:
    """One persistent FFmpeg decoder per camera; only the latest frame is retained."""
    def __init__(self, camera_id: str, config: dict, store: Store, session: ClientSession):
        self.id = camera_id
        self.config = config
        self.store = store
        self.session = session
        self.frame: Frame | None = None
        self.task: asyncio.Task | None = None
        self.process: asyncio.subprocess.Process | None = None
        self.connected = False

    def start(self) -> None:
        self.task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        url = os.environ.get(self.config.get('urlEnv', ''), '')
        if not url:
            return
        while True:
            try:
                if self.config.get('kind') == 'http_jpeg':
                    async with self.session.get(url, timeout=8) as response:
                        response.raise_for_status()
                        jpeg = await response.read()
                        if not jpeg.startswith(b'\xff\xd8') or len(jpeg) > 5_000_000:
                            raise ValueError('Invalid JPEG')
                        self._capture(jpeg)
                    await asyncio.sleep(2)
                    continue
                if urlparse(url).scheme not in ('rtsp', 'rtsps'):
                    raise ValueError('RTSP camera URL required')
                self.process = await asyncio.create_subprocess_exec(
                    os.environ.get('FFMPEG_BIN', 'ffmpeg'), '-hide_banner', '-loglevel', 'error',
                    '-rtsp_transport', 'tcp', '-i', url, '-an', '-vf', 'fps=1,scale=960:-1',
                    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4', 'pipe:1',
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                )
                buffer = b''
                while chunk := await self.process.stdout.read(65536):
                    buffer += chunk
                    if len(buffer) > 5_000_000:
                        buffer = buffer[-1_000_000:]
                    while True:
                        begin = buffer.find(b'\xff\xd8')
                        end = buffer.find(b'\xff\xd9', begin + 2) if begin >= 0 else -1
                        if begin < 0 or end < 0:
                            break
                        self._capture(buffer[begin:end + 2])
                        buffer = buffer[end + 2:]
                self.connected = False
                await self.process.wait()
            except asyncio.CancelledError:
                raise
            except Exception:
                # URLs may contain camera credentials; never print provider exception text.
                self.connected = False
            await asyncio.sleep(2)

    def _capture(self, jpeg: bytes) -> None:
        self.frame = Frame(jpeg, int(time.time() * 1000), self.store.sequence(self.id))
        self.connected = True

    async def close(self) -> None:
        if self.task:
            self.task.cancel()
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 3)
            except asyncio.TimeoutError:
                self.process.kill()
        if self.task:
            await asyncio.gather(self.task, return_exceptions=True)
