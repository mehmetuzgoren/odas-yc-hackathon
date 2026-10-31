// Shared ODAS v1 type declarations. Integration lead owns this file.
// Kept inside the actor project so official managed Terse source packaging is self-contained.
export type Role = 'guest' | 'operator';
export interface User { id: string; email: string; name: string; role: Role; testAccount: boolean }
export interface Hours { open: string; close: string; days: number[]; modeled: boolean }
export interface Workspace { id: string; name: string; address: string; latitude: number; longitude: number; baseRateCents: number; timezone: string; modeled: boolean; description: string; hours: Hours; photos: string[]; attributes: Record<string, unknown>; officeCount?: number; lowestRateCents?: number | null; availableCount?: number; accessInstructions?: string | null }
export interface Office { id: string; groupId: string; name: string; description: string; rateCents: number; photos: string[]; attributes: Record<string, unknown>; modeled: boolean; available?: boolean; availabilityReason?: string; workspace?: Workspace }
export interface SearchInput { location?: string; startAt?: number; endAt?: number; maxRateCents?: number; attributes?: Record<string, unknown> }
export interface SearchResult { groups: Workspace[]; offices: Office[]; startAt: number; endAt: number; timezone: string; modeled: boolean }
export interface Quote { id: string; userId: string; roomId: string; startAt: number; endAt: number; rateCents: number; subtotalCents: number; feeCents: number; totalCents: number; currency: 'usd'; expiresAt: number; cancellationPolicy: string }
export type BookingStatus = 'held' | 'checkout_pending' | 'payment_pending' | 'confirmed' | 'checked_in' | 'checked_out' | 'canceled' | 'expired' | 'unfulfillable';
export type RefundStatus = 'none' | 'requested' | 'pending' | 'succeeded' | 'failed' | 'review_required';
export interface Reservation { id: string; userId: string; roomId: string; originalRoomId: string; groupId: string; quoteId: string; startAt: number; endAt: number; subtotalCents: number; feeCents: number; totalCents: number; currency: string; status: BookingStatus; paymentStatus: string; refundStatus: RefundStatus; checkoutUrl?: string | null; checkoutSessionId?: string | null; holdExpiresAt?: number; createdAt: number; revision: number; office?: Office; workspace?: Workspace; roomState?: RoomSnapshot; offers?: ReplacementOffer[]; accessInstructions?: string | null; cancellationPolicy?: string; checkInWindowMinutes?: number }
export interface InventoryInterval { bookingId: string; startAt: number; endAt: number; status: 'held' | 'confirmed' | 'checked_in' | 'checked_out' | 'canceled'; expiresAt?: number; revision: number }
export interface Inspection { id: string; roomId: string; source: 'simulator' | 'camera'; capturedAt: number; inferredAt: number; sequence: number; occupancy: 'vacant' | 'occupied' | 'unknown'; confidence: number; floor: 'clean' | 'dirty' | 'unknown'; surfaces: 'clear' | 'cluttered' | 'unknown'; connection: 'connected' | 'disconnected' | 'unverified'; frameId?: string; error?: string }
export interface DeviceTelemetry { roomId: string; source: 'simulator' | 'roborock'; observedAt: number; connection: 'connected' | 'disconnected' | 'unverified'; state: 'docked' | 'cleaning' | 'returning' | 'idle' | 'unknown' | 'error'; battery?: number; error?: string; commandId?: string }
export type JobStatus = 'requested' | 'dispatching' | 'started' | 'completed' | 'uncertain' | 'failed' | 'interrupted';
export interface CleaningJob { id: string; status: JobStatus; requestedAt: number; startedAt?: number; completedAt?: number; expectedReadyAt?: number; estimateSource: 'configured' | 'history'; commandId: string; reason?: string; claimId?: string; claimExpiresAt?: number }
export interface DomainEvent { version: 1; id: string; type: string; roomId: string; bookingId?: string; correlationId: string; revision: number; idempotencyKey: string; occurredAt: number; payload: Record<string, unknown> }
export interface RoomSnapshot { roomId: string; revision: number; intervals: InventoryInterval[]; occupancy: 'vacant' | 'occupied' | 'unknown'; inspection: Inspection | null; cleanliness: 'clean' | 'dirty' | 'unknown'; operational: 'available' | 'maintenance' | 'blocked'; readiness: 'ready' | 'not_ready' | 'unknown'; expectedReadyAt: number | null; device: DeviceTelemetry | null; job: CleaningJob | null; events: DomainEvent[]; blocks: { id: string; startAt: number; endAt: number; reason: string }[]; attentionReasons: string[] }
export interface CommandBase { id: string; now: number; expectedRevision?: number; correlationId?: string }
export type RoomCommand = CommandBase & (
  | { type: 'hold'; bookingId: string; startAt: number; endAt: number; expiresAt: number }
  | { type: 'confirm' | 'cancel' | 'check_in' | 'check_out'; bookingId: string }
  | { type: 'inspect'; inspection: Inspection }
  | { type: 'telemetry'; telemetry: DeviceTelemetry }
  | { type: 'request_clean'; jobId: string; expectedReadyAt?: number }
  | { type: 'claim_clean'; jobId: string; claimId: string; claimExpiresAt: number }
  | { type: 'authorize_dispatch'; jobId: string; claimId: string }
  | { type: 'job_result'; jobId: string; status: JobStatus; reason?: string; expectedReadyAt?: number }
  | { type: 'set_operational'; operational: RoomSnapshot['operational']; reason: string }
  | { type: 'block'; blockId: string; startAt: number; endAt: number; reason: string }
  | { type: 'unblock'; blockId: string }
  | { type: 'ack_events'; eventIds: string[] }
  | { type: 'tick' }
);
export interface RoomResult { ok: boolean; code?: string; message?: string; snapshot: RoomSnapshot }
export interface RoomGateway { snapshot(roomId: string): Promise<RoomSnapshot>; command(roomId: string, command: RoomCommand): Promise<RoomResult>; available(roomId: string, startAt: number, endAt: number, excludeBookingId?: string): Promise<boolean> }
export interface ReplacementOffer { id: string; bookingId: string; roomId: string; status: 'offered' | 'accepted' | 'declined' | 'expired' | 'failed'; expiresAt: number; equivalence: string; differences: string[]; roomRevision: number; office?: Office; createdAt: number }
export interface ChatMessage { id: string; conversationId: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: number; cards?: Office[]; offer?: ReplacementOffer; checkoutUrl?: string; toolResults?: unknown[] }
export interface Notification { id: string; userId: string; bookingId?: string; type: string; title: string; body: string; createdAt: number; readAt?: number; openConcierge: boolean; data?: Record<string, unknown> }
export interface AttentionTask { id: string; roomId: string; reason: string; status: 'open' | 'assigned' | 'resolved'; assignee?: string; resolutionEvidence?: string; createdAt: number; resolvedAt?: number }
export interface DeviceAdapter { inspect(roomId: string): Promise<Inspection>; telemetry(roomId: string): Promise<DeviceTelemetry>; start(roomId: string, commandId: string): Promise<{ accepted: boolean; uncertain: boolean; message?: string }>; dock(roomId: string, commandId: string): Promise<{ accepted: boolean; uncertain: boolean; message?: string }> }
