from __future__ import annotations
import asyncio
import json
import os
import time
from pathlib import Path
from aiohttp import ClientSession
from roborock.data import UserData
from roborock.data.b01_q10.b01_q10_code_mappings import YXCleanType, B01_Q10_DP
from roborock.protocols.b01_q10_protocol import Q10DpsUpdate
from roborock.devices.device_manager import UserParams, create_device_manager

class Q10Cloud:
    """Persistent python-roborock B01/Q10 manager. No local V1-protocol substitutions."""
    def __init__(self, session: ClientSession):
        self.session = session
        self.manager = None
        self.devices: dict = {}
        self.observed: dict[str, int] = {}
        self.unsubscribers = []
        self.status_tasks = []
        self.task = None
        self.error = 'Roborock cloud account and physical connection have not been verified.'

    def start(self) -> None:
        self.task = asyncio.create_task(self._connect_loop())

    async def _connect_loop(self) -> None:
        while True:
            try:
                email = os.environ.get('ROBOROCK_EMAIL', '')
                auth_file = os.environ.get('ROBOROCK_USER_DATA_FILE', '')
                if not email or not auth_file or not Path(auth_file).exists():
                    await asyncio.sleep(15)
                    continue
                user_data = UserData.from_dict(json.loads(Path(auth_file).read_text()))
                self.manager = await create_device_manager(UserParams(username=email, user_data=user_data), session=self.session)
                for device in await self.manager.get_devices():
                    if device.b01_q10_properties is None:
                        continue
                    self.devices[device.duid] = device
                    def updated(duid=device.duid):
                        self.observed[duid] = int(time.time() * 1000)
                    self.unsubscribers.append(device.b01_q10_properties.status.add_update_listener(updated))
                    # The pinned driver's trait listener only fires when values change.
                    # Observe actual DPS messages too, so repeated docked status stays fresh.
                    self.status_tasks.append(asyncio.create_task(self._observe_status(device)))
                    await device.b01_q10_properties.refresh()
                self.error = ''
                return  # Device manager owns persistent reconnecting MQTT connections.
            except asyncio.CancelledError:
                raise
            except Exception:
                self.error = 'Roborock cloud connection failed or requires renewed account authentication.'
                for task in self.status_tasks:
                    task.cancel()
                await asyncio.gather(*self.status_tasks, return_exceptions=True)
                self.status_tasks.clear()
                if self.manager:
                    await self.manager.close()
                    self.manager = None
                self.devices.clear()
                await asyncio.sleep(15)

    async def _observe_status(self, device) -> None:
        # python-roborock 7.13.0 exposes its decoded stream on the Q10 channel.
        async for message in device.b01_q10_properties._channel.subscribe_stream():
            if isinstance(message, Q10DpsUpdate) and B01_Q10_DP.STATUS in message.dps:
                self.observed[device.duid] = int(time.time() * 1000)

    async def telemetry(self, room_id: str, duid: str) -> dict:
        device = self.devices.get(duid)
        if not device or not device.is_connected:
            return {'roomId': room_id, 'source': 'roborock', 'observedAt': self.observed.get(duid, 0), 'connection': 'unverified' if not device else 'disconnected', 'state': 'unknown', 'error': self.error or 'Robot cloud connection is disconnected.'}
        properties = device.b01_q10_properties
        await properties.refresh()
        status = properties.status
        state_name = status.status.name.lower() if status.status is not None else 'unknown'
        state = 'cleaning' if state_name in ('cleaning', 'sweeping') else 'docked' if state_name == 'charging' else 'returning' if state_name == 'returning_home' else 'idle' if state_name in ('idle', 'sleeping', 'paused') else 'error' if state_name == 'error' else 'unknown'
        # Refresh acceptance does not fabricate a new observation timestamp. Listener timestamps genuine changes.
        observed_at = self.observed.get(duid, 0)
        return {'roomId': room_id, 'source': 'roborock', 'observedAt': observed_at, 'connection': 'connected' if observed_at else 'unverified', 'state': state, 'battery': status.battery}

    async def start_vacuum(self, duid: str, authorize) -> None:
        device = self.devices.get(duid)
        if not device or not device.is_connected or device.b01_q10_properties is None:
            raise ValueError('Configured Q10 robot is not connected')
        properties = device.b01_q10_properties
        await properties.vacuum.set_clean_mode(YXCleanType.VACUUM)
        # Mode configuration is an external await: recheck immediately before motion.
        if not await authorize():
            raise ValueError('RoomActor authorization expired during mode configuration')
        await properties.vacuum.start_clean()  # Whole bound office; zones and coordinates are intentionally absent.

    async def dock(self, duid: str) -> None:
        device = self.devices.get(duid)
        if not device or not device.is_connected or device.b01_q10_properties is None:
            raise ValueError('Cloud route unavailable; stop delivery is not guaranteed')
        await device.b01_q10_properties.vacuum.return_to_dock()

    async def close(self) -> None:
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        for task in self.status_tasks:
            task.cancel()
        await asyncio.gather(*self.status_tasks, return_exceptions=True)
        for unsubscribe in self.unsubscribers:
            unsubscribe()
        if self.manager:
            await self.manager.close()
