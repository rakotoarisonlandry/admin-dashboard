import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Icon, Modal, request, e } from './common';

/* Same bounds as the backend (UpdateShopPositionDto): Robia IoT runs in Madagascar. */
export const inMadagascar = point => !!point && point.lat >= -26 && point.lat <= -11.5 && point.lng >= 43 && point.lng <= 51;
const ANTANANARIVO = { lat: -18.8792, lng: 47.5079 };
const NOMINATIM = 'https://nominatim.openstreetmap.org';

const pin = L.divIcon({
  className: 'map-pin',
  html: '<span class="map-pin-dot"></span>',
  iconSize: [34, 44],
  iconAnchor: [17, 42],
});

/** Free OpenStreetMap geocoding, used when Google has no result. Madagascar only. */
export async function searchAddress(query) {
  const response = await fetch(`${NOMINATIM}/search?format=jsonv2&countrycodes=mg&limit=5&accept-language=fr&q=${e(query)}`);
  if (!response.ok) throw new Error('Recherche indisponible.');
  return (await response.json()).map(item => ({
    id: `osm-${item.place_id}`,
    name: item.name || item.display_name.split(',')[0],
    formattedAddress: item.display_name,
    latitude: Number(item.lat),
    longitude: Number(item.lon),
  }));
}

/** Street address and city of a point, to prefill the form after a click on the map. */
export async function addressAt(point) {
  try {
    const response = await fetch(`${NOMINATIM}/reverse?format=jsonv2&zoom=18&accept-language=fr&lat=${point.lat}&lon=${point.lng}`);
    if (!response.ok) return null;
    const data = await response.json();
    const a = data.address || {};
    const street = [a.house_number, a.road].filter(Boolean).join(' ');
    const area = a.suburb || a.neighbourhood || a.quarter || '';
    return {
      address: [street, area].filter(Boolean).join(', ') || data.display_name?.split(',').slice(0, 2).join(',').trim() || '',
      city: a.city || a.town || a.village || a.county || '',
    };
  } catch { return null; }
}

/**
 * Map where the owner places the shop entrance: click, drag the pin or use
 * their own position. The pin is what customers see and are routed to.
 */
export function MapPicker({ value, onChange }) {
  const box = useRef(null);
  const map = useRef(null);
  const marker = useRef(null);
  const change = useRef(onChange);
  const [locating, setLocating] = useState(false);
  const [hint, setHint] = useState('');
  useEffect(() => { change.current = onChange; }, [onChange]);

  useEffect(() => {
    const instance = L.map(box.current, { zoomControl: true, attributionControl: true }).setView(value || ANTANANARIVO, value ? 17 : 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(instance);
    instance.on('click', event => change.current({ lat: event.latlng.lat, lng: event.latlng.lng }, 'map'));
    map.current = instance;
    // The map is mounted inside an opening dialog: measure again once it is laid out.
    const timer = setTimeout(() => instance.invalidateSize(), 200);
    return () => { clearTimeout(timer); instance.remove(); map.current = null; marker.current = null; };
    // The map is created once; position updates are applied by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    if (!value) { marker.current?.remove(); marker.current = null; return; }
    if (!marker.current) {
      marker.current = L.marker(value, { icon: pin, draggable: true, keyboard: true, title: 'Entrée de la boutique' }).addTo(instance);
      marker.current.on('dragend', () => { const point = marker.current.getLatLng(); change.current({ lat: point.lat, lng: point.lng }, 'map'); });
    } else marker.current.setLatLng(value);
    if (!instance.getBounds().pad(-0.2).contains(value)) instance.setView(value, Math.max(instance.getZoom(), 17));
  }, [value]);

  const locate = () => {
    if (!navigator.geolocation) { setHint('La localisation n’est pas disponible sur ce navigateur.'); return; }
    setLocating(true); setHint('');
    navigator.geolocation.getCurrentPosition(
      position => { setLocating(false); const point = { lat: position.coords.latitude, lng: position.coords.longitude }; if (!inMadagascar(point)) setHint('Votre position est hors de Madagascar : placez le repère à la main.'); else { change.current(point, 'map'); map.current?.setView(point, 18); } },
      () => { setLocating(false); setHint('Position refusée ou introuvable. Placez le repère sur la carte.'); },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  return <div className="map-picker">
    <div ref={box} className="map-box" role="application" aria-label="Carte : cliquez pour placer la boutique"/>
    <div className="map-toolbar">
      <small>{value ? 'Déplacez le repère pour viser l’entrée exacte.' : 'Cliquez sur la carte pour placer la boutique.'}</small>
      <button type="button" className="btn soft small" disabled={locating} onClick={locate}><Icon name="pin" size={16}/>{locating ? 'Localisation…' : 'Je suis dans la boutique'}</button>
    </div>
    {hint && <p className="hint">{hint}</p>}
  </div>;
}

/** Fix or set the position of an existing shop. */
export function PositionDialog({ shop, onClose, onSaved }) {
  const initial = shop.latitude != null && shop.longitude != null ? { lat: shop.latitude, lng: shop.longitude } : null;
  const [point, setPoint] = useState(initial);
  const [address, setAddress] = useState(shop.address || '');
  const [city, setCity] = useState(shop.city || '');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const find = async event => {
    event.preventDefault();
    if (query.trim().length < 3) return;
    setSearching(true); setError('');
    try { const items = await searchAddress(query.trim()); setResults(items); if (!items.length) setError('Adresse introuvable. Placez le repère directement sur la carte.'); }
    catch { setError('Recherche indisponible. Placez le repère directement sur la carte.'); }
    finally { setSearching(false); }
  };
  const move = async (next, source) => {
    setPoint(next);
    if (source === 'map' && !address.trim()) { const found = await addressAt(next); if (found) { setAddress(current => current || found.address); setCity(current => current || found.city); } }
  };
  const save = async () => {
    if (!inMadagascar(point)) { setError('Placez la boutique à Madagascar sur la carte.'); return; }
    setBusy(true); setError('');
    try {
      await request(`/appointments/admin/shops/${e(shop.id)}/position`, { method: 'PATCH', body: JSON.stringify({ latitude: point.lat, longitude: point.lng, ...(address.trim() && { address: address.trim() }), ...(city.trim() && { city: city.trim() }) }) });
      await onSaved();
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return <Modal wide onClose={onClose} label="Position de la boutique">
    <span className="eyebrow">{shop.name}</span>
    <h2>Où se trouve l’entrée ?</h2>
    <p>Cette position est celle que les clients voient sur la carte de l’application et vers laquelle l’itinéraire les guide.</p>
    <form className="search-inline" onSubmit={find}>
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Chercher une adresse, un quartier, un repère…" aria-label="Chercher une adresse"/>
      <button className="btn soft" disabled={searching || query.trim().length < 3}>{searching ? 'Recherche…' : 'Chercher'}</button>
    </form>
    {!!results.length && <div className="list" style={{ marginTop: 10 }}>{results.map(item => <button type="button" key={item.id} className="row-item" onClick={() => { setResults([]); setPoint({ lat: item.latitude, lng: item.longitude }); if (!address.trim()) setAddress(item.formattedAddress.split(',').slice(0, 2).join(',').trim()); }}>
      <span className="icon-tile"><Icon name="pin" size={18}/></span><span className="row-copy"><strong>{item.name}</strong><small>{item.formattedAddress}</small></span>
    </button>)}</div>}
    <MapPicker value={point} onChange={move}/>
    <div className="form-grid">
      <label>Adresse affichée<input value={address} maxLength={300} onChange={event => setAddress(event.target.value)} placeholder="Lot, rue, quartier"/></label>
      <label>Ville<input value={city} maxLength={120} onChange={event => setCity(event.target.value)} placeholder="Antananarivo"/></label>
    </div>
    {error && <div className="notice" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}
    <div className="dialog-actions"><button type="button" className="btn ghost" onClick={onClose}>Annuler</button><button type="button" className="btn primary" disabled={busy || !point} onClick={() => void save()}>{busy ? 'Enregistrement…' : 'Enregistrer la position'}</button></div>
  </Modal>;
}
