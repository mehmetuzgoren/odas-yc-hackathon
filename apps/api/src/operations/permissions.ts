import type { Runtime } from '../core';
import type { User } from '@odas/contracts';

export function canControlDevices(rt: Pick<Runtime, 'db' | 'config'>, user: User, roomId: string) {
  if (user.role !== 'operator') return false;
  const scoped = rt.db.query('SELECT 1 FROM operator_scopes s JOIN offices o ON o.group_id=s.group_id WHERE s.user_id=? AND o.id=?').get(user.id, roomId);
  return !!scoped && (rt.config.deviceMode !== 'physical' || !user.testAccount || !!rt.db.query('SELECT 1 FROM operator_device_grants WHERE user_id=? AND room_id=?').get(user.id, roomId));
}
