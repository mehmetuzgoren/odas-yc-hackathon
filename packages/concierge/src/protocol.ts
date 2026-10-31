import { z } from 'zod';
import { eventSchema } from '@odas/contracts';

export const roleSchema = z.enum(['operations', 'concierge']);
export type WorkerRole = z.infer<typeof roleSchema>;
export const relayEnvelopeSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('domain_event'), outboxId: z.string().min(1), target: roleSchema, event: eventSchema }),
  z.object({ version: z.literal(1), kind: z.literal('business_result'), outboxId: z.string().min(1), worker: roleSchema, eventId: z.string().min(1), status: z.enum(['completed', 'failed']), result: z.unknown().optional(), error: z.string().optional() }),
]);
export type RelayEnvelope = z.infer<typeof relayEnvelopeSchema>;
export const workerName = (role: WorkerRole, namespace: string) => `odas-${role}-${namespace.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48)}`;
