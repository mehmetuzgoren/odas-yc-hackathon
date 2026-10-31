import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { divIcon, latLngBounds, type LatLngBounds } from 'leaflet';
import { Circle, MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { ImageOff, Search, X } from 'lucide-react';
import { money } from '@odas/contracts';
import { Photo } from '../ui';
import 'leaflet/dist/leaflet.css';

const CENTER: [number, number] = [37.7749, -122.4194];
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export interface MapListing { id: string; latitude: number; longitude: number; rateCents: number; unavailable: boolean; street: string; suite: string; photo?: string; href: string }

function Viewport({ listings, fitKey, selectedId, view, onMoved, onMapClick }: { listings: MapListing[]; fitKey: number; selectedId: string | null; view: string; onMoved: (bounds: LatLngBounds) => void; onMapClick: () => void }) {
  const map = useMap();
  const programmatic = useRef(0);
  const mark = () => { programmatic.current = Date.now(); };
  const fit = () => { if (listings.length) map.fitBounds(latLngBounds(listings.map(listing => [listing.latitude, listing.longitude])), { padding: [60, 60], maxZoom: 19 }); };
  useEffect(() => { if (fitKey) { mark(); fit(); } }, [fitKey, map]);
  useEffect(() => {
    const listing = listings.find(value => value.id === selectedId);
    if (listing && !map.getBounds().pad(-0.1).contains([listing.latitude, listing.longitude])) { mark(); map.panTo([listing.latitude, listing.longitude]); }
  }, [selectedId, map]);
  useEffect(() => {
    const timer = setTimeout(() => { mark(); map.invalidateSize(); fit(); }, 150);
    return () => clearTimeout(timer);
  }, [map, view]);
  useMapEvents({ click: onMapClick, moveend: () => { if (Date.now() - programmatic.current >= 1200) onMoved(map.getBounds()); } });
  return null;
}

function PricePin({ listing, active, onOpen, onLeave }: { listing: MapListing; active: boolean; onOpen: (select: boolean) => void; onLeave: () => void }) {
  const navigate = useNavigate();
  const icon = useMemo(() => divIcon({ className: 'pin-wrap', iconSize: [0, 0], html: `<span class="price-pin ${active ? 'active' : ''} ${listing.unavailable ? 'unavailable' : ''}">${money(listing.rateCents)}</span>` }), [active, listing.rateCents, listing.unavailable]);
  return <Marker position={[listing.latitude, listing.longitude]} icon={icon} zIndexOffset={active ? 1000 : 0} title={`${money(listing.rateCents)} per hour, ${listing.street}`} alt={`${money(listing.rateCents)} per hour, ${listing.street}`} eventHandlers={{
    click: () => onOpen(true), mouseover: () => onOpen(false), mouseout: onLeave,
    keypress: event => { if (event.originalEvent.key === 'Enter') void navigate(listing.href); },
  }} />;
}

function Preview({ listing, onClose, onEnter, onLeave }: { listing: MapListing; onClose: () => void; onEnter: () => void; onLeave: () => void }) {
  return <div role="dialog" aria-label={`${listing.street} preview`} onMouseEnter={onEnter} onMouseLeave={onLeave} className="pop-in absolute top-4 right-4 left-4 z-[600] max-w-sm overflow-hidden rounded-2xl border border-stone-200 bg-ivory shadow-2xl sm:right-auto sm:w-80">
    {listing.photo ? <Photo src={listing.photo} className="h-28 w-full" /> : <div className="flex h-28 flex-col items-center justify-center gap-1 bg-stone-100 text-stone-500"><ImageOff className="h-5 w-5" aria-hidden="true" /><span className="text-xs font-medium">Surroundings image not yet verified</span></div>}
    <button onClick={onClose} aria-label="Close preview" className="absolute top-2 right-2 rounded-full bg-white/90 p-1.5 text-stone-700 shadow-sm hover:bg-white"><X className="h-4 w-4" /></button>
    <div className="space-y-1 p-4">
      <p className="font-serif text-lg font-semibold text-stone-900">{money(listing.rateCents)}<span className="font-sans text-sm font-normal text-stone-500"> / hr</span></p>
      <p className="text-sm font-medium text-stone-800">{listing.street}, San Francisco</p>
      {listing.suite && <p className="text-sm text-stone-600">{listing.suite}</p>}
      <Link to={listing.href} className="mt-3 inline-flex rounded-full bg-forest px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-forest-dark">View listing</Link>
    </div>
  </div>;
}

export default function ExploreMap({ listings, selectedId, onSelect, onSearchArea, fitKey, view }: { listings: MapListing[]; selectedId: string | null; onSelect: (id: string) => void; onSearchArea: (bounds: LatLngBounds) => void; fitKey: number; view: string }) {
  const [moved, setMoved] = useState<LatLngBounds | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cancel = () => clearTimeout(closing.current);
  const closeLater = () => { cancel(); closing.current = setTimeout(() => setPreviewId(null), 250); };
  const close = () => { cancel(); setPreviewId(null); };
  const preview = listings.find(listing => listing.id === previewId);
  useEffect(() => {
    if (!previewId) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [previewId]);
  return <div className="relative isolate h-full w-full overflow-hidden" aria-label="Map of spaces in San Francisco">
    <MapContainer center={CENTER} zoom={13} scrollWheelZoom className="h-full w-full">
      <TileLayer url={TILES} attribution={ATTRIBUTION} />
      <Viewport listings={listings} fitKey={fitKey} selectedId={selectedId} view={view} onMoved={setMoved} onMapClick={close} />
      {listings.map(listing => <PricePin key={listing.id} listing={listing} active={listing.id === selectedId} onLeave={closeLater} onOpen={select => { cancel(); setPreviewId(listing.id); if (select) onSelect(listing.id); }} />)}
    </MapContainer>
    {preview && <Preview listing={preview} onClose={close} onEnter={cancel} onLeave={closeLater} />}
    {moved && <button onClick={() => { onSearchArea(moved); setMoved(null); }} className="absolute top-4 left-1/2 z-[500] flex -translate-x-1/2 items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-stone-900 shadow-lg transition-transform hover:scale-[1.03]"><Search className="h-4 w-4" aria-hidden="true" /> Search this area</button>}
  </div>;
}

export function NeighborhoodMap({ latitude, longitude }: { latitude: number; longitude: number }) {
  return <div className="relative isolate h-72 overflow-hidden rounded-2xl border border-stone-200">
    <MapContainer center={[latitude, longitude]} zoom={15} scrollWheelZoom={false} className="h-full w-full">
      <TileLayer url={TILES} attribution={ATTRIBUTION} />
      <Circle center={[latitude, longitude]} radius={180} pathOptions={{ color: '#2E4A3B', fillColor: '#2E4A3B', fillOpacity: 0.15 }} />
    </MapContainer>
  </div>;
}

export function PinnedMap({ latitude, longitude }: { latitude: number; longitude: number }) {
  const icon = useMemo(() => divIcon({ className: 'pin-wrap', iconSize: [0, 0], html: '<span class="price-pin active">Here</span>' }), []);
  return <div className="relative isolate h-72 overflow-hidden rounded-xl border border-stone-200">
    <MapContainer center={[latitude, longitude]} zoom={13} className="h-full w-full">
      <TileLayer url={TILES} attribution={ATTRIBUTION} />
      <Marker position={[latitude, longitude]} icon={icon} />
    </MapContainer>
  </div>;
}
