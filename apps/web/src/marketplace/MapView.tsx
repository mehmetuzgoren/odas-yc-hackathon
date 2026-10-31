import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { divIcon, latLngBounds } from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import type { Workspace } from '@odas/contracts';
import { money } from '@odas/contracts';
import 'leaflet/dist/leaflet.css';

function MapBounds({ groups }: { groups: Workspace[] }) {
  const map = useMap();
  useEffect(() => {
    if (groups.length) map.fitBounds(latLngBounds(groups.map(group => [group.latitude, group.longitude])), { padding: [48, 48], maxZoom: 15, animate: false });
    map.invalidateSize();
  }, [groups, map]);
  return null;
}

export default function MapView({ groups, query }: { groups: Workspace[]; query: string }) {
  return <div className="market-map" aria-label="Map of workspace groups in San Francisco">
    <MapContainer center={[37.779, -122.420]} zoom={14} scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
      <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <MapBounds groups={groups} />
      {groups.map(group => <Marker key={group.id} position={[group.latitude, group.longitude]} title={`${group.name}: ${group.availableCount ? `from ${money(group.lowestRateCents!)} per hour` : 'no matching availability'}`} icon={divIcon({ className: 'market-marker-wrap', html: `<span class="market-price-marker${group.availableCount ? '' : ' unavailable'}">${group.availableCount ? money(group.lowestRateCents!) : 'No availability'}</span>`, iconSize: [112, 38], iconAnchor: [56, 19] })}>
        <Popup><strong>{group.name}</strong><p>{group.availableCount ? `${group.availableCount} matching ${group.availableCount === 1 ? 'office' : 'offices'} · from ${money(group.lowestRateCents!)}/hr` : 'No offices available for the selected filters.'}</p><Link to={`/workspaces/${group.id}?${query}`}>View individual offices</Link><p className="muted">Modeled map position</p></Popup>
      </Marker>)}
    </MapContainer>
    <div className="market-map-caption">Seed map positions · availability for your selected interval</div>
  </div>;
}
