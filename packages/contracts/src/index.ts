import { z } from 'zod';

export const CONTRACT_VERSION = 1 as const;
export const TIMEZONE = 'America/Los_Angeles';
export const TURNOVER_MS = 15 * 60_000;
export const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export const intervalSchema = z.object({ startAt: z.number().int().positive(), endAt: z.number().int().positive() }).refine(v => v.endAt > v.startAt, 'End must follow start');
export const eventSchema = z.object({ version: z.literal(1), id: z.string().min(1), type: z.string(), roomId: z.string(), bookingId: z.string().optional(), correlationId: z.string(), revision: z.number().int().nonnegative(), idempotencyKey: z.string(), occurredAt: z.number(), payload: z.record(z.string(), z.unknown()) });
export const CANCELLATION_POLICY = 'Full refund before the reservation starts. Full refund if ODAS cannot provide your reserved or accepted replacement office. Ordinary cancellations after check-in require operator review.';
export type * from "../../actors/src/contracts";
