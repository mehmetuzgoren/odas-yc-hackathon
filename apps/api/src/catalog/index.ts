import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Runtime } from '../core';
import { fail } from '../core';
import type { SearchInput } from '@odas/contracts';
import { localInstant } from './service';

function searchInput(c: Context): SearchInput {
  const number = (key: string) => { const value = c.req.query(key); if (value === undefined || value === '') return undefined; const result = Number(value); if (!Number.isFinite(result)) fail(400, `Invalid ${key}.`, 'invalid_filter'); return result; };
  let startAt = number('startAt');
  let endAt = number('endAt');
  const date = c.req.query('date');
  if (date && startAt === undefined) startAt = localInstant(date, c.req.query('start') || '10:00');
  if (date && endAt === undefined) endAt = localInstant(date, c.req.query('end') || '12:00');
  const minCapacity = number('minCapacity');
  if (minCapacity !== undefined && (!Number.isInteger(minCapacity) || minCapacity < 1)) fail(400, 'Capacity must be a positive number.', 'invalid_filter');
  return { location: c.req.query('location'), startAt, endAt, maxRateCents: number('maxRateCents'), attributes: { ...(minCapacity !== undefined ? { minCapacity } : {}), ...(c.req.query('capacityKnown') === 'true' ? { capacityKnown: true } : {}) } };
}

export function createCatalogRoutes(rt: Runtime) {
  return new Hono()
    .get('/catalog/search', async c => c.json(await rt.services.catalog.search(searchInput(c))))
    .get('/catalog/groups/:id', async c => c.json(await rt.services.catalog.group(c.req.param('id'), searchInput(c))))
    .get('/catalog/offices/:id', async c => c.json(await rt.services.catalog.office(c.req.param('id'), searchInput(c))));
}

export { createCatalogService } from './service';
