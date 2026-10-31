import { z } from 'zod';

export const demoPatchSchema = z.object({
  jevEnabled: z.boolean().optional(),
  roboEnabled: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Set Jev and/or Robo.');

export const cameraInspectionSchema = z.object({
  id: z.string().min(1).max(200), roomId: z.string().min(1).max(200), source: z.literal('camera'),
  capturedAt: z.number().int().nonnegative(), inferredAt: z.number().int().nonnegative(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  occupancy: z.enum(['vacant', 'occupied', 'unknown']), confidence: z.number().min(0).max(1),
  floor: z.enum(['clean', 'dirty', 'unknown']), surfaces: z.enum(['clear', 'cluttered', 'unknown']),
  connection: z.enum(['connected', 'disconnected', 'unverified']),
  frameId: z.string().max(400).optional(), error: z.string().max(1000).optional(),
}).strict();
