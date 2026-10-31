import type { Office, Workspace } from '@odas/contracts';

const BUILDINGS: Record<string, { street: string; suite: string; neighborhood: string }> = {
  'polk-310': { street: '507 Polk St', suite: 'Suite 310', neighborhood: 'Civic Center' },
  'mission-400': { street: '1360 Mission St', suite: '4th Floor, Suite 400', neighborhood: 'SoMa' },
  'market-1540-f3': { street: '1540 Market St', suite: '3rd Floor', neighborhood: 'Civic Center' },
  'gough-207': { street: '44 Gough St', suite: 'Suite 207', neighborhood: 'Hayes Valley' },
  'post-204': { street: '2211 Post St', suite: 'Suite 204', neighborhood: 'Lower Pacific Heights' },
  'market-870-1242': { street: '870 Market St', suite: 'Suite 1242', neighborhood: 'Union Square' },
};

export function building(group: { id: string; name: string }) {
  const known = BUILDINGS[group.id];
  if (known) return known;
  const [street = group.name, ...suite] = group.name.split(', ');
  return { street, suite: suite.join(', '), neighborhood: 'San Francisco' };
}

export const NEIGHBORHOODS = [...new Set(Object.values(BUILDINGS).map(value => value.neighborhood))];
export const roomName = (name: string) => name.replace(/^Office 0*/, 'Office ');

export function roomTitle(group: { id: string; name: string }, name: string) {
  const { street, suite } = building(group);
  return [street, suite, roomName(name)].filter(Boolean).join(' · ');
}

export const roomPhotos = (office: Office) => office.photos.length ? office.photos : office.workspace?.photos ?? [];
export const quoteTotal = (rateCents: number, minutes: number) => {
  const subtotal = Math.round(rateCents * minutes / 60);
  const fee = Math.round(subtotal * 10 / 100);
  return { subtotal, fee, total: subtotal + fee };
};

export const ROOM_TYPES: Record<string, string> = { private_office: 'Private office', meeting_room: 'Meeting room', creative_workspace: 'Creative workspace' };
export const AMENITIES: Record<string, string> = { wifi: 'Wi-Fi', monitor: 'Monitor', whiteboard: 'Whiteboard', coffee: 'Coffee', accessible: 'Accessible entrance' };
export const CAPACITIES: Record<string, string> = { known: 'Known capacity', 1: '1+ people', 2: '2+ people', 4: '4+ people' };

export interface Filters { minPrice: string; maxPrice: string; types: string[]; amenities: string[]; capacity: string; availableOnly: boolean }

const list = (value: string | null) => value ? value.split(',').filter(Boolean) : [];

export function filtersFrom(params: URLSearchParams): Filters {
  return { minPrice: params.get('minPrice') || '', maxPrice: params.get('maxPrice') || '', types: list(params.get('types')), amenities: list(params.get('amenities')), capacity: params.get('capacity') || '', availableOnly: params.get('available') === '1' };
}

export function writeFilters(params: URLSearchParams, filters: Filters) {
  const next = new URLSearchParams(params);
  const values: Record<string, string> = { minPrice: filters.minPrice, maxPrice: filters.maxPrice, types: filters.types.join(','), amenities: filters.amenities.join(','), capacity: filters.capacity, available: filters.availableOnly ? '1' : '' };
  for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key); }
  return next;
}

export const activeFilterCount = (filters: Filters) => (filters.minPrice ? 1 : 0) + (filters.maxPrice ? 1 : 0) + filters.types.length + filters.amenities.length + (filters.capacity ? 1 : 0) + (filters.availableOnly ? 1 : 0);

// Unknown attributes never satisfy a required filter: modeled offices stay unverified until a real value exists.
export function matchesFilters(office: Office, filters: Filters) {
  const rate = office.rateCents / 100;
  if (filters.minPrice && rate < Number(filters.minPrice)) return false;
  if (filters.maxPrice && rate > Number(filters.maxPrice)) return false;
  if (filters.availableOnly && !office.available) return false;
  if (filters.types.length && !filters.types.includes(String(office.attributes.type ?? 'private_office'))) return false;
  const amenities = Array.isArray(office.attributes.amenities) ? office.attributes.amenities.map(String) : [];
  if (!filters.amenities.every(amenity => amenities.includes(amenity))) return false;
  const capacity = office.attributes.capacity;
  if (filters.capacity === 'known') return typeof capacity === 'number';
  if (filters.capacity) return typeof capacity === 'number' && capacity >= Number(filters.capacity);
  return true;
}

export const matchesLocation = (group: Workspace, query: string) => !query.trim() || `${group.name} ${group.address} ${building(group).neighborhood} San Francisco SF`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());

export function bestOffice(offices: Office[]) {
  return [...offices].sort((a, b) => Number(b.available) - Number(a.available) || a.rateCents - b.rateCents || a.id.localeCompare(b.id))[0];
}
