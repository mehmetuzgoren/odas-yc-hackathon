import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { TIMEZONE } from '@odas/contracts';
import type { User } from '@odas/contracts';
import { fail, type Runtime } from '../core';

const id = z.string().min(1).max(160);
const nullableId = id.nullable();
export const toolSchemas = {
  resolve_interval: z.object({ date: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/), startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).strict(),
  search_offices: z.object({ location: z.string().max(200).nullable(), startAt: z.number().int().positive().nullable(), endAt: z.number().int().positive().nullable(), maxRateCents: z.number().int().nonnegative().nullable() }).strict(),
  quote_office: z.object({ roomId: id, startAt: z.number().int().positive(), endAt: z.number().int().positive() }).strict(),
  reservation_details: z.object({ bookingId: nullableId }).strict(),
  room_readiness: z.object({ bookingId: id }).strict(),
  start_checkout: z.object({ roomId: id, startAt: z.number().int().positive(), endAt: z.number().int().positive(), quoteId: nullableId }).strict(),
  replacement_options: z.object({ bookingId: id }).strict(),
  accept_replacement: z.object({ offerId: id }).strict(),
  decline_replacement: z.object({ offerId: id }).strict(),
  cancel_reservation: z.object({ bookingId: id }).strict(),
} as const;
export type ToolName = keyof typeof toolSchemas;
export interface ToolContext { user: User; messageId: string; confirmedAction?: ToolName }
export function createConciergeTools(rt: Runtime) {
  async function execute(name: string, raw: unknown, context: ToolContext): Promise<unknown> {
    if (!(name in toolSchemas)) fail(400, 'This concierge tool is unavailable.');
    const toolName = name as ToolName;
    const input = toolSchemas[toolName].parse(raw) as any;
    switch (toolName) {
      case 'resolve_interval': {
        try {
          const startAt = Number(Temporal.ZonedDateTime.from(`${input.date}T${input.startTime}[${TIMEZONE}]`, { disambiguation: 'reject' }).epochMilliseconds);
          const endAt = Number(Temporal.ZonedDateTime.from(`${input.date}T${input.endTime}[${TIMEZONE}]`, { disambiguation: 'reject' }).epochMilliseconds);
          if (endAt <= startAt) fail(400, 'The end time must follow the start time.');
          return { startAt, endAt, timezone: TIMEZONE };
        } catch { return fail(400, 'Choose a valid unambiguous Pacific date and time. Daylight saving transitions may skip or repeat that time.'); }
      }
      case 'search_offices': return rt.services.catalog.search({ location: input.location ?? undefined, startAt: input.startAt ?? undefined, endAt: input.endAt ?? undefined, maxRateCents: input.maxRateCents ?? undefined });
      case 'quote_office': return rt.services.commerce.quote(context.user, input);
      case 'reservation_details': return input.bookingId ? rt.services.commerce.get(context.user, input.bookingId) : rt.services.commerce.list(context.user);
      case 'room_readiness': {
        const booking = await rt.services.commerce.get(context.user, input.bookingId);
        const state = await rt.rooms.snapshot(booking.roomId);
        return { bookingId: booking.id, bookingStatus: booking.status, paymentStatus: booking.paymentStatus, refundStatus: booking.refundStatus, office: booking.office, readiness: state.readiness, expectedReadyAt: state.expectedReadyAt, occupancy: state.occupancy, cleanliness: state.cleanliness, operational: state.operational, job: state.job, evidenceCapturedAt: state.inspection?.capturedAt ?? null, source: state.inspection?.source ?? 'unverified' };
      }
      case 'start_checkout': {
        if (context.confirmedAction !== toolName) {
          const quote = await rt.services.commerce.quote(context.user, input);
          return { requiresConfirmation: true, action: toolName, input: { ...input, quoteId: quote.id }, quote, message: 'Review the price and cancellation policy, then choose Continue to Checkout.' };
        }
        if (!input.quoteId) fail(409, 'Review a current quote before starting Checkout.');
        const reservation = await rt.services.commerce.hold(context.user, input.quoteId, `concierge:${context.messageId}:checkout`);
        return rt.services.commerce.checkout(context.user, reservation.id);
      }
      case 'replacement_options': {
        const booking = await rt.services.commerce.get(context.user, input.bookingId);
        const offer = await rt.services.commerce.offerReplacement(booking.id);
        return { bookingId: booking.id, offer, message: offer ? 'The guest must explicitly accept the offer before the assignment changes.' : 'No compatible replacement is available. You can keep the current booking or cancel under the disruption policy when eligible.' };
      }
      case 'accept_replacement':
      case 'decline_replacement': {
        const offer = await rt.db.query('SELECT * FROM offers WHERE id=?').get(input.offerId) as any;
        if (!offer) fail(404, 'Replacement offer not found.');
        await rt.services.commerce.get(context.user, offer.booking_id);
        if (context.confirmedAction !== toolName) return { requiresConfirmation: true, action: toolName, input, message: 'Choose the offer action to confirm your decision.' };
        return toolName === 'accept_replacement' ? rt.services.commerce.acceptOffer(context.user, input.offerId) : rt.services.commerce.declineOffer(context.user, input.offerId);
      }
      case 'cancel_reservation': {
        const booking = await rt.services.commerce.get(context.user, input.bookingId);
        if (context.confirmedAction !== toolName) return { requiresConfirmation: true, action: toolName, input, bookingId: booking.id, cancellationPolicy: booking.cancellationPolicy, message: 'Choose Confirm cancellation to cancel this reservation under the displayed policy.' };
        return rt.services.commerce.cancel(context.user, input.bookingId, 'Guest explicitly confirmed cancellation in concierge.');
      }
    }
  }
  return { execute };
}
const descriptions: Record<ToolName, string> = {
  resolve_interval: 'Resolve the guest local date and HH:MM start/end time in America/Los_Angeles using date-specific IANA rules. Call this for local times; do not compute UTC offsets yourself. Ambiguous or nonexistent DST times require a different user choice.',
  search_offices: 'Search actual available office inventory. All times are UTC epoch milliseconds; resolve the guest date in America/Los_Angeles. Missing fields must be null. Ask for missing dates and time before starting Checkout.',
  quote_office: 'Calculate a real server quote with 10% service fee and cancellation policy.',
  reservation_details: 'Read only the authenticated guest reservation, or their reservation list when bookingId is null. Includes authorized access instructions.',
  room_readiness: 'Read the reserved room readiness and evidence through the native room actor after verifying ownership.',
  start_checkout: 'Prepare a normal hosted Stripe Checkout. Returns a confirmation action so the guest can explicitly review and approve the quote. Never claim payment succeeded.',
  replacement_options: 'Search actual compatible available inventory for an owned disrupted reservation and persist an offer. Never claim equivalence without its data.',
  accept_replacement: 'Prepare a confirmation action for a replacement. Only a guest UI confirmation may change the real assignment.',
  decline_replacement: 'Prepare a confirmation action to keep the current assignment.',
  cancel_reservation: 'Prepare an explicit cancellation confirmation with the applicable policy. Only the guest confirmation may execute cancellation.',
};
export function modelTools() {
  return Object.entries(toolSchemas).map(([name, schema]) => {
    const parameters = z.toJSONSchema(schema) as any;
    delete parameters.$schema;
    return { type: 'function', name, description: descriptions[name as ToolName], parameters, strict: true };
  });
}
