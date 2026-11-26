import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertsControl, Empty, Icon, LiveBadge, Login, Metric, Modal, Shell, ToastProvider, addDays, dayKey, e, formatDate, formatDay, formatTime,
  initials, post, request, useAlerts, useConfirm, useDocumentTitle, useLiveStream, useSession, useToast,
} from './common';
import { MapPicker, PositionDialog, addressAt, inMadagascar, searchAddress } from './position-picker';
import './style.css';

/* Same rule as the backend: Monday–Saturday, 08:00–16:00, Madagascar (UTC+3). */
const OPEN_DAYS = [1, 2, 3, 4, 5, 6];
const OPENS = 8 * 60;
const CLOSES = 16 * 60;
const WEEKDAYS = [[1, 'Lun'], [2, 'Mar'], [3, 'Mer'], [4, 'Jeu'], [5, 'Ven'], [6, 'Sam']];
const SHOP_SPACE_URL = import.meta.env.VITE_SHOP_DASHBOARD_URL || '';
const toMinutes = value => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };
const isPublished = shop => !!shop?.bookingEnabled && shop?.status === 'active';
/** Monday (YYYY-MM-DD) of the Madagascar week containing `key`. */
const weekStart = key => { const weekday = new Date(`${key}T12:00:00Z`).getUTCDay(); return dayKey(addDays(key, weekday === 0 ? -6 : 1 - weekday)); };

function previewPlan(plan, now) {
  const first = Date.parse(`${plan.from}T00:00:00Z`); const last = Date.parse(`${plan.to}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return { count: 0, error: 'La date de fin doit suivre la date de début.' };
  if ((last - first) / 86400000 + 1 > 62) return { count: 0, error: 'La période est limitée à 62 jours.' };
  if (toMinutes(plan.endTime) <= toMinutes(plan.startTime)) return { count: 0, error: 'L’heure de fin doit suivre l’heure de début.' };
  const start = Math.max(OPENS, toMinutes(plan.startTime)); const end = Math.min(CLOSES, toMinutes(plan.endTime));
  let count = 0; let days = 0;
  for (let day = first; day <= last; day += 86400000) {
    const weekday = new Date(day).getUTCDay();
    if (!plan.weekdays.includes(weekday) || !OPEN_DAYS.includes(weekday)) continue;
    let dayCount = 0;
    for (let minute = start; minute + plan.intervalMinutes <= end; minute += plan.intervalMinutes) {
      if (day + minute * 60000 - 3 * 3600000 > now) dayCount++;
    }
    if (dayCount) { days++; count += dayCount; }
  }
  return { count, days, error: count > 1000 ? 'Le planning est limité à 1000 créneaux : réduisez la période.' : '' };
}

function AdminDashboard({ user, logout }) {
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [shops, setShops] = useState([]);
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState('overview');
  const [slots, setSlots] = useState(null);
  const [agents, setAgents] = useState(null);
  const [activity, setActivity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notOwner, setNotOwner] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [creating, setCreating] = useState(false);
  const [placing, setPlacing] = useState(false);
  const shop = shops.find(item => item.id === selected);
  const base = `/appointments/admin/shops/${e(selected)}`;
  useDocumentTitle(`${shop ? `${shop.name} · ` : ''}Administration · Robia IoT`);

  const loadShops = useCallback(async () => {
    const items = await request('/locations');
    setShops(items);
    setSelected(current => items.some(item => item.id === current) ? current : items[0]?.id || '');
  }, []);
  useEffect(() => {
    loadShops()
      .catch(err => { if (/organisation|introuvable/i.test(err.message)) setNotOwner(true); else setError(err.message); })
      .finally(() => setLoading(false));
  }, [loadShops]);

  const loadDetails = useCallback(async id => {
    if (!id) return;
    const today = dayKey(Date.now());
    const [slotItems, team, todayItems, latest] = await Promise.all([
      request(`/appointments/admin/shops/${e(id)}/slots`).catch(() => []),
      request(`/appointments/admin/shops/${e(id)}/agents`).catch(() => []),
      request(`/appointments/agent/shops/${e(id)}/bookings?date=${today}`).catch(() => []),
      request(`/appointments/agent/shops/${e(id)}/bookings`).catch(() => []),
    ]);
    setSlots(slotItems); setAgents(team);
    setActivity({
      today: todayItems.filter(item => !['rejected', 'cancelled'].includes(item.status)).length,
      arrived: todayItems.filter(item => item.checkedInAt).length,
      pending: latest.filter(item => item.status === 'pending' && Date.parse(item.slot?.startsAt) > Date.now()).length,
      recent: latest.slice(0, 5),
    });
  }, []);
  useEffect(() => { setSlots(null); setAgents(null); setActivity(null); void loadDetails(selected); }, [selected, loadDetails]);

  // Real time: bookings, cancellations, arrivals and slot changes from any shop.
  const alerts = useAlerts();
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const detailTimer = useRef(null);
  const live = useLiveStream(event => {
    const locationId = event.data?.locationId;
    const name = shops.find(item => item.id === locationId)?.name || 'une boutique';
    if (event.type === 'ready') { void loadShops().catch(() => {}); if (selectedRef.current) void loadDetails(selectedRef.current); return; }
    if (event.type === 'shop.changed') void loadShops().catch(() => {});
    if (locationId && locationId === selectedRef.current) {
      clearTimeout(detailTimer.current);
      detailTimer.current = setTimeout(() => void loadDetails(locationId), 300);
    }
    if (event.type === 'booking.created') { toast(`Nouvelle réservation · ${name}`, 'info'); alerts.notify('Nouvelle réservation', name); }
    if (event.type === 'booking.updated' && event.data?.status === 'cancelled') toast(`Annulation d’un client · ${name}`, 'info');
  });

  const run = async (key, work, success) => {
    if (busy) return false;
    setBusy(key);
    try { await work(); if (success) toast(success, 'success'); return true; }
    catch (err) { toast(err.message, 'error'); return false; }
    finally { setBusy(''); }
  };

  const published = isPublished(shop);
  const upcoming = slots || [];
  const week = upcoming.filter(slot => Date.parse(slot.startsAt) < Date.now() + 7 * 86400000);
  const fill = week.reduce((sum, slot) => ({ capacity: sum.capacity + slot.capacity, reserved: sum.reserved + slot.reserved }), { capacity: 0, reserved: 0 });
  const fillRate = fill.capacity ? Math.round((fill.reserved / fill.capacity) * 100) : 0;
  const checklist = shop ? [
    { done: shop.latitude != null && shop.longitude != null, label: 'Position sur la carte', hint: 'Sans elle, la boutique n’apparaît pas sur la carte de l’application ni dans l’itinéraire.', action: () => setPlacing(true) },
    { done: upcoming.some(slot => slot.available > 0), label: 'Créneaux disponibles', hint: 'Les clients ne voient que les créneaux publiés.', action: () => setTab('slots') },
    { done: (agents || []).length > 0, label: 'Au moins un agent', hint: 'Vous pouvez aussi accueillir vous-même depuis l’espace boutique.', action: () => setTab('team') },
    { done: published, label: 'Réservations publiées', hint: 'Rend la boutique visible dans l’application.' },
  ] : [];
  const ready = checklist.slice(0, 2).every(item => item.done);

  const togglePublish = async () => {
    if (published && !await confirm({ title: 'Suspendre les réservations ?', text: 'La boutique disparaît de l’application mobile. Les rendez-vous déjà pris sont conservés et restent gérables.', confirm: 'Suspendre', danger: true })) return;
    if (!published && !ready && !await confirm({ eyebrow: 'Avant de publier', title: 'La boutique n’est pas tout à fait prête', text: checklist.slice(0, 2).filter(item => !item.done).map(item => `• ${item.label} : ${item.hint}`).join(' '), confirm: 'Publier quand même' })) return;
    void run('publish', async () => { await post(`${base}/${published ? 'disable' : 'enable'}`); await loadShops(); }, published ? 'Réservations suspendues.' : 'Boutique publiée dans l’application.');
  };

  if (notOwner) return <Shell user={user} logout={logout} role="Administration" nav={null}>
    <div className="page"><div className="panel" style={{ maxWidth: 640, margin: '40px auto' }}>
      <Empty icon="key" title="Ce compte n’administre aucune boutique" text="L’administration est réservée au propriétaire d’une organisation Robia. Si vous êtes agent, utilisez l’espace boutique pour gérer les rendez-vous.">
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 18, flexWrap: 'wrap' }}>
          {SHOP_SPACE_URL && <a className="btn primary" href={SHOP_SPACE_URL}>Ouvrir l’espace boutique</a>}
          <button className="btn ghost" onClick={logout}>Changer de compte</button>
        </div>
      </Empty>
    </div></div>
  </Shell>;

  const nav = <>
    <div className="side-label">Vos boutiques</div>
    <nav className="nav">
      {shops.map(item => <button key={item.id} className={`nav-item ${item.id === selected ? 'active' : ''}`} onClick={() => setSelected(item.id)}>
        <Icon name="shop" size={19}/><span className="nav-copy"><span>{item.name}</span><small><span className={`state-dot ${isPublished(item) ? 'on' : ''}`}/>{isPublished(item) ? 'Publiée' : 'Non publiée'}</small></span>
      </button>)}
      <button className="nav-item add" onClick={() => setCreating(true)}><Icon name="plus" size={19}/>Nouvelle boutique</button>
    </nav>
  </>;
  const mobileNav = <select aria-label="Boutique" value={selected} onChange={event => setSelected(event.target.value)}>{shops.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>;

  return <Shell user={user} logout={logout} role="Administration" nav={nav} mobileNav={shops.length ? mobileNav : null}>
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="date-line">{formatDay(Date.now())}</div>
          <h1>Bonjour{user?.name ? ` ${user.name.split(' ')[0]}` : ''}</h1>
        </div>
        <div className="heading-tools">
          <AlertsControl alerts={alerts}/>
          <LiveBadge status={live}/>
          {shops.length > 0 && <button className="btn ghost" onClick={() => setCreating(true)}><Icon name="plus" size={18}/>Nouvelle boutique</button>}
        </div>
      </div>
      {error && <div className="notice" role="alert">{error}</div>}

      {loading ? <div className="skeleton" style={{ height: 200 }}/>
        : !shops.length ? <div className="panel"><Empty icon="shop" title="Créez votre première boutique" text="Recherchez-la sur Google : l’adresse et la position GPS sont remplies automatiquement."><button className="btn primary" style={{ marginTop: 18 }} onClick={() => setCreating(true)}>Ajouter une boutique</button></Empty></div>
          : shop && <>
            <section className="band" aria-label={shop.name}>
              <div>
                <div className="band-label"><span className={`state-dot ${published ? 'on' : ''}`} style={{ display: 'inline-block', marginRight: 8 }}/>{published ? 'Publiée dans l’application' : 'Non publiée'}</div>
                <h1 className="band-title">{shop.name}</h1>
                <div className="band-sub">{[shop.address, shop.city].filter(Boolean).join(', ') || 'Adresse non renseignée'}</div>
                <div className="band-actions">
                  <button className={`btn ${published ? 'ghost' : 'primary'}`} disabled={!!busy || (!published && shop.status !== 'active')} onClick={() => void togglePublish()}>{published ? 'Suspendre les réservations' : 'Publier la boutique'}</button>
                  <button type="button" className="btn ghost" onClick={() => setPlacing(true)}><Icon name="pin" size={17}/>{shop.latitude != null && shop.longitude != null ? 'Modifier la position' : 'Placer sur la carte'}</button>
                </div>
              </div>
              <div className="metrics">
                <Metric alert={!!activity?.pending} value={activity ? activity.pending : '…'} label="Demandes en attente"/>
                <Metric value={activity ? activity.today : '…'} label={activity ? `Aujourd’hui · ${activity.arrived} accueilli(s)` : 'Aujourd’hui'}/>
                <Metric value={slots ? `${fillRate} %` : '…'} label="Remplissage 7 jours"/>
                <Metric value={agents ? agents.length : '…'} label="Agent(s)"/>
              </div>
            </section>
            {shop.status !== 'active' && <div className="notice info">Cette fiche est inactive dans Robia : elle ne peut pas être publiée.</div>}

            <div className="section-head">
              <div className="tabs" role="tablist">{[['overview', 'Aperçu'], ['slots', 'Créneaux'], ['team', 'Équipe']].map(([key, label]) =>
                <button key={key} role="tab" aria-selected={tab === key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>{label}</button>)}</div>
            </div>

              {tab === 'overview' && <div className="grid-2">
                <section className="panel">
                  <div className="meter">
                    <div className="meter-head"><span>Remplissage des 7 prochains jours</span><strong>{fillRate} %</strong></div>
                    <div className={`bar ${fillRate >= 100 ? 'full' : ''}`}><span style={{ width: `${Math.min(100, fillRate)}%` }}/></div>
                    <small>{week.length} créneau(x), {fill.capacity - fill.reserved} place(s) encore libre(s)</small>
                  </div>
                  <h2 style={{ margin: '26px 0 6px' }}>Prête à recevoir des clients ?</h2>
                  <div className="steps">{checklist.map((item, index) => <div key={item.label} className={`step ${item.done ? 'done' : ''}`}>
                    <span className="step-mark" aria-label={item.done ? 'Fait' : 'À faire'}>{item.done ? <Icon name="check" size={17}/> : index + 1}</span>
                    <span><strong>{item.label}</strong><small>{item.hint}</small></span>
                    {!item.done && item.action ? <button className="btn soft small" onClick={item.action}>Configurer</button> : <span/>}
                  </div>)}</div>
                </section>
                <div className="stack">
                  <div className="panel"><h2>Activité récente</h2>
                    {activity === null ? <div className="skeleton" style={{ height: 120, marginTop: 12 }}/> : !activity.recent.length ? <p style={{ marginTop: 8 }}>Aucune réservation pour le moment.</p>
                      : <div className="list" style={{ marginTop: 14 }}>{activity.recent.map(item => <div key={item.id} className="row-item">
                        <span className="avatar soft" style={{ width: 36, height: 36, fontSize: '.8rem' }}>{initials(item.customerName)}</span>
                        <span className="row-copy"><strong>{item.customerName}</strong><small>{formatDate(item.slot?.startsAt)}</small></span>
                        <span className={`tag ${item.checkedInAt ? 'arrived' : item.status}`}>{item.checkedInAt ? 'Arrivé' : { pending: 'En attente', confirmed: 'Confirmé', rejected: 'Refusé', cancelled: 'Annulé' }[item.status]}</span>
                      </div>)}</div>}
                  </div>
                  <div className="panel"><h3>Lundi au samedi, de 08:00 à 16:00</h3><p className="hint">Appliqués par le serveur : aucun créneau ne peut être créé en dehors.</p></div>
                </div>
              </div>}

              {tab === 'slots' && <SlotsTab base={base} slots={slots} busy={busy} run={run} confirm={confirm} reload={() => loadDetails(selected)}/>}
              {tab === 'team' && <TeamTab base={base} agents={agents} busy={busy} run={run} confirm={confirm} reload={() => loadDetails(selected)} shopName={shop.name} owner={user}/>}
          </>}
    </div>
    {placing && shop && <PositionDialog shop={shop} onClose={() => setPlacing(false)} onSaved={async () => { setPlacing(false); await loadShops(); toast('Position enregistrée. Elle est visible dans l’application.', 'success'); }}/>}
    {creating && <CreateShop onClose={() => setCreating(false)} onCreated={async (item, positionSaved) => { setCreating(false); await loadShops(); setSelected(item.id); setTab(positionSaved ? 'slots' : 'overview'); toast(positionSaved ? 'Boutique créée. Ouvrez maintenant des créneaux.' : 'Boutique créée, mais la position n’a pas pu être enregistrée. Placez-la depuis l’aperçu.', positionSaved ? 'success' : 'error'); }}/>}
    {confirmDialog}
  </Shell>;
}

function SlotsTab({ base, slots, busy, run, confirm, reload }) {
  const today = dayKey(Date.now());
  const [plan, setPlan] = useState({ from: today, to: dayKey(addDays(today, 13)), weekdays: [1, 2, 3, 4, 5, 6], startTime: '08:00', endTime: '16:00', intervalMinutes: 30, capacity: 3 });
  const [weekOf, setWeekOf] = useState(weekStart(today));
  const [planning, setPlanning] = useState(false);
  const set = (key, value) => setPlan(current => ({ ...current, [key]: value }));
  const preview = useMemo(() => previewPlan(plan, Date.now()), [plan]);
  const weekEnd = dayKey(addDays(weekOf, 7));
  const groups = useMemo(() => {
    const map = new Map();
    for (const slot of slots || []) { const key = dayKey(slot.startsAt); if (key >= weekOf && key < weekEnd) map.set(key, [...(map.get(key) || []), slot]); }
    return [...map.entries()];
  }, [slots, weekOf, weekEnd]);
  const lastSlotDay = slots?.length ? dayKey(slots[slots.length - 1].startsAt) : today;

  const generate = event => {
    event.preventDefault();
    void run('plan', async () => {
      const result = await post(`${base}/slots/plan`, { ...plan, intervalMinutes: Number(plan.intervalMinutes), capacity: Number(plan.capacity) });
      await reload();
      setWeekOf(weekStart(plan.from));
      setPlanning(false);
      return result;
    }, 'Créneaux publiés. Les doublons éventuels ont été ignorés.');
  };
  const changeCapacity = (slot, capacity) => run(slot.id, async () => { await request(`${base}/slots/${e(slot.id)}`, { method: 'PATCH', body: JSON.stringify({ capacity }) }); await reload(); });
  const remove = async slot => {
    if (!await confirm({ title: `Supprimer le créneau de ${formatTime(slot.startsAt)} ?`, text: formatDate(slot.startsAt), confirm: 'Supprimer', danger: true })) return;
    void run(slot.id, async () => { await request(`${base}/slots/${e(slot.id)}`, { method: 'DELETE' }); await reload(); }, 'Créneau supprimé.');
  };
  /** Holiday or exceptional closure: empty slots are deleted, booked ones stop selling new places. */
  const closeDay = async (key, items) => {
    const booked = items.filter(slot => slot.reserved > 0);
    if (!await confirm({ eyebrow: 'Fermeture exceptionnelle', title: `Fermer le ${formatDay(items[0].startsAt)} ?`, text: booked.length ? `${items.length - booked.length} créneau(x) vide(s) seront supprimés. ${booked.length} créneau(x) déjà réservé(s) sont conservés mais n’acceptent plus de nouvelles réservations : prévenez ces clients.` : `Les ${items.length} créneaux de la journée seront supprimés.`, confirm: 'Fermer la journée', danger: true })) return;
    void run(`day-${key}`, async () => {
      for (const slot of items) {
        if (slot.reserved === 0) await request(`${base}/slots/${e(slot.id)}`, { method: 'DELETE' });
        else if (slot.capacity > slot.reserved) await request(`${base}/slots/${e(slot.id)}`, { method: 'PATCH', body: JSON.stringify({ capacity: slot.reserved }) });
      }
      await reload();
    }, 'Journée fermée aux nouvelles réservations.');
  };

  return <section className="panel">
    <div className="section-head">
      <div><h2>Semaine du {formatDay(addDays(weekOf, 0), { day: 'numeric', month: 'long' })}</h2><p>Ajustez la capacité, supprimez un créneau vide ou fermez une journée.</p></div>
      <div className="week-nav">
        <button className="icon-button" aria-label="Semaine précédente" disabled={weekOf <= weekStart(today)} onClick={() => setWeekOf(dayKey(addDays(weekOf, -7)))}><Icon name="back" size={17}/></button>
        <button className="btn ghost small" onClick={() => setWeekOf(weekStart(today))}>Cette semaine</button>
        <button className="icon-button" aria-label="Semaine suivante" disabled={weekEnd > lastSlotDay && weekOf >= weekStart(lastSlotDay)} onClick={() => setWeekOf(dayKey(addDays(weekOf, 7)))}><Icon name="arrow" size={17}/></button>
        <button className="btn primary" onClick={() => setPlanning(true)}><Icon name="plus" size={18}/>Ouvrir des créneaux</button>
      </div>
    </div>
    {slots === null ? <div className="skeleton" style={{ height: 240 }}/> : !groups.length ? <Empty icon="calendar" title={slots.length ? 'Aucun créneau cette semaine' : 'Aucun créneau à venir'} text={slots.length ? 'Changez de semaine ou ouvrez de nouveaux créneaux.' : 'Ouvrez une période : seuls des créneaux pendant les heures d’ouverture sont créés.'}><button className="btn primary" style={{ marginTop: 18 }} onClick={() => setPlanning(true)}>Ouvrir des créneaux</button></Empty>
      : <div className="slot-week">{groups.map(([key, items]) => {
        const reserved = items.reduce((n, slot) => n + slot.reserved, 0); const capacity = items.reduce((n, slot) => n + slot.capacity, 0);
        return <div key={key} className="slot-col">
          <div className="slot-col-head">
            <strong>{formatDay(items[0].startsAt, { weekday: 'long', day: 'numeric' })}</strong>
            <small>{reserved}/{capacity} places réservées</small>
            <button className="link-button danger" disabled={!!busy} onClick={() => void closeDay(key, items)}>Fermer la journée</button>
          </div>
          {items.map(slot => {
            const ratio = slot.capacity ? Math.min(1, slot.reserved / slot.capacity) : 1;
            return <div key={slot.id} className={`slot ${ratio >= 1 ? 'full-slot' : ''}`} aria-busy={busy === slot.id}>
              <div className="slot-head"><strong>{formatTime(slot.startsAt)}</strong>{slot.reserved === 0 ? <button className="icon-button" disabled={!!busy} onClick={() => void remove(slot)} aria-label={`Supprimer le créneau de ${formatTime(slot.startsAt)}`}><Icon name="trash" size={15}/></button> : <span className={`tag ${ratio >= 1 ? 'rejected' : 'pending'}`}>{ratio >= 1 ? 'Complet' : `${slot.available} libre(s)`}</span>}</div>
              <div className={`bar ${ratio >= 1 ? 'full' : ''}`}><span style={{ width: `${ratio * 100}%` }}/></div>
              <div className="stepper">
                <button disabled={!!busy || slot.capacity <= slot.reserved} onClick={() => void changeCapacity(slot, slot.capacity - 1)} aria-label="Retirer une place">−</button>
                <span>{slot.reserved}/{slot.capacity} places</span>
                <button disabled={!!busy || slot.capacity >= 1000} onClick={() => void changeCapacity(slot, slot.capacity + 1)} aria-label="Ajouter une place">+</button>
              </div>
            </div>;
          })}
        </div>;
      })}</div>}
    {planning && <Modal as="form" wide onClose={() => setPlanning(false)} label="Ouvrir des créneaux" onSubmit={generate}>
      <h2>Ouvrir des créneaux</h2>
      <p>Seuls les créneaux du lundi au samedi, entre 08:00 et 16:00, sont créés. Ceux qui existent déjà sont conservés.</p>
      <div className="form-grid">
        <label>Du<input type="date" required min={today} value={plan.from} onChange={event => set('from', event.target.value)}/></label>
        <label>Au<input type="date" required min={plan.from} value={plan.to} onChange={event => set('to', event.target.value)}/></label>
      </div>
      <div className="chips" style={{ marginTop: 10 }}>{[[6, '1 semaine'], [13, '2 semaines'], [27, '4 semaines']].map(([days, label]) => <button type="button" key={label} className="chip" onClick={() => setPlan(current => ({ ...current, to: dayKey(addDays(current.from, days)) }))}>{label}</button>)}</div>
      <label>Jours d’ouverture</label>
      <div className="weekday-picker">{WEEKDAYS.map(([value, label]) => <button type="button" key={value} className={plan.weekdays.includes(value) ? 'on' : ''} aria-pressed={plan.weekdays.includes(value)} onClick={() => set('weekdays', plan.weekdays.includes(value) ? plan.weekdays.filter(day => day !== value) : [...plan.weekdays, value].sort())}>{label}</button>)}</div>
      <div className="form-grid">
        <label>De<input type="time" min="08:00" max="16:00" step="900" required value={plan.startTime} onChange={event => set('startTime', event.target.value)}/></label>
        <label>À<input type="time" min="08:00" max="16:00" step="900" required value={plan.endTime} onChange={event => set('endTime', event.target.value)}/></label>
        <label>Durée d’un créneau<select value={plan.intervalMinutes} onChange={event => set('intervalMinutes', Number(event.target.value))}>{[15, 20, 30, 45, 60].map(value => <option key={value} value={value}>{value} min</option>)}</select></label>
        <label>Places par créneau<input type="number" min="1" max="1000" required value={plan.capacity} onChange={event => set('capacity', event.target.value)}/></label>
      </div>
      <div className="preview" aria-live="polite">{preview.error || (preview.count ? `${preview.count} créneaux sur ${preview.days} jour(s), soit ${preview.count * Number(plan.capacity || 0)} places` : 'Aucun créneau dans cette sélection.')}</div>
      <div className="dialog-actions"><button type="button" className="btn ghost" onClick={() => setPlanning(false)}>Annuler</button><button className="btn primary" disabled={!!busy || !!preview.error || !preview.count || !plan.weekdays.length || Number(plan.capacity) < 1}>{busy === 'plan' ? 'Création…' : `Publier ${preview.count || ''} créneaux`}</button></div>
    </Modal>}
  </section>;
}

function TeamTab({ base, agents, busy, run, confirm, reload, shopName, owner }) {
  const [email, setEmail] = useState('');
  const add = event => {
    event.preventDefault();
    const value = email.trim();
    if ((agents || []).some(agent => agent.email?.toLowerCase() === value.toLowerCase())) { setEmail(''); return; }
    void run('agent', async () => { await post(`${base}/agents`, { email: value }); setEmail(''); await reload(); }, 'Agent ajouté à la boutique.');
  };
  const remove = async agent => {
    if (!await confirm({ title: `Retirer ${agent.name || agent.email} ?`, text: `Il n’aura plus accès aux rendez-vous de ${shopName}.`, confirm: 'Retirer', danger: true })) return;
    void run(agent.id, async () => { await request(`${base}/agents/${e(agent.id)}`, { method: 'DELETE' }); await reload(); }, 'Agent retiré.');
  };
  return <section className="panel">
    <div className="section-head"><div><h2>Qui accueille les clients ?</h2><p>Les agents confirment les demandes et accueillent les clients depuis l’espace boutique.</p></div></div>
    <form className="inline-form" onSubmit={add}>
      <label>Ajouter un agent par son adresse e-mail<input type="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="agent@exemple.mg"/></label>
      <button className="btn primary" disabled={!!busy || !email.trim()}>{busy === 'agent' ? 'Ajout…' : 'Ajouter à l’équipe'}</button>
    </form>
    <div className="list">
      <div className="row-item"><span className="avatar">{initials(owner?.name || owner?.email)}</span><span className="row-copy"><strong>{owner?.name || owner?.email} (vous)</strong><small>Propriétaire, accès à toutes vos boutiques</small></span><span className="tag on">Propriétaire</span></div>
      {agents === null ? <div className="skeleton" style={{ height: 64 }}/> : agents.map(agent => <div key={agent.id} className="row-item">
        <span className="avatar soft">{initials(agent.name || agent.email)}</span>
        <span className="row-copy"><strong>{agent.name || agent.email}</strong><small>{agent.email}, depuis le {formatDay(agent.assignedAt, { day: 'numeric', month: 'long' })}</small></span>
        <button className="btn danger small" disabled={!!busy} onClick={() => void remove(agent)}>Retirer</button>
      </div>)}
    </div>
    <p className="hint">L’agent doit déjà avoir un compte Robia. {agents && !agents.length ? 'Sans agent, vous pouvez accueillir vous-même les clients depuis l’espace boutique.' : 'Il retrouve la boutique à sa prochaine connexion.'}</p>
  </section>;
}

function CreateShop({ onClose, onCreated }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [place, setPlace] = useState(null);
  const [point, setPoint] = useState(null);
  const [name, setName] = useState(''); const [address, setAddress] = useState(''); const [city, setCity] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (query.trim().length < 2 || place) { setResults([]); setSearchError(''); return undefined; }
    let active = true;
    const timer = setTimeout(async () => {
      setSearching(true);
      // Google first (it knows the shops by name); OpenStreetMap as a free fallback for streets and districts.
      const google = await request(`/locations/search-places?query=${e(query.trim())}`)
        .then(items => items.filter(item => item.latitude != null && item.longitude != null).map(item => ({ ...item, id: item.placeId })))
        .catch(() => []);
      const items = google.length ? google : await searchAddress(query.trim()).catch(() => []);
      if (!active) return;
      setResults(items); setSearching(false);
      setSearchError(items.length ? '' : 'Aucun résultat. Placez la boutique directement sur la carte ci-dessous.');
    }, 500);
    return () => { active = false; clearTimeout(timer); };
  }, [query, place]);
  const choose = item => {
    setPlace(item); setQuery(item.name); setResults([]);
    setPoint({ lat: item.latitude, lng: item.longitude });
    if (!name.trim()) setName(item.name);
    setAddress(item.formattedAddress || '');
    const parts = (item.formattedAddress || '').split(',').map(part => part.trim());
    if (!city && parts.length > 1) setCity(parts[parts.length - 2].replace(/\d+/g, '').trim());
  };
  const move = async (next, source) => {
    setPoint(next);
    if (source !== 'map' || address.trim()) return;
    const found = await addressAt(next);
    if (found) { setAddress(current => current || found.address); setCity(current => current || found.city); }
  };
  const submit = async event => {
    event.preventDefault();
    if (!inMadagascar(point)) { setError('Placez la boutique sur la carte : sans position, elle n’apparaît pas dans l’application.'); return; }
    setBusy(true); setError('');
    try {
      const item = await post('/locations', { name: name.trim(), ...(address.trim() && { address: address.trim() }), ...(city.trim() && { city: city.trim() }), ...(place?.placeId && { placeId: place.placeId }) });
      // The pin confirmed on the map always wins over what Google returned.
      let positionSaved = true;
      try { await request(`/appointments/admin/shops/${e(item.id)}/position`, { method: 'PATCH', body: JSON.stringify({ latitude: point.lat, longitude: point.lng, ...(address.trim() && { address: address.trim() }), ...(city.trim() && { city: city.trim() }) }) }); }
      catch { positionSaved = false; }
      await onCreated(item, positionSaved);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <Modal as="form" wide onClose={onClose} label="Nouvelle boutique" onSubmit={submit}>
    <span className="eyebrow">Nouvelle boutique · étape 1 sur 2</span>
    <h2>Où se trouve-t-elle ?</h2>
    <p>Recherchez la boutique ou son adresse, puis vérifiez le repère sur la carte. C’est cette position que les clients verront et vers laquelle l’itinéraire les guidera.</p>
    <label>Rechercher<div style={{ position: 'relative' }}><input value={query} onChange={event => { setQuery(event.target.value); setPlace(null); }} placeholder="Ex. Orange Analakely, ou Rue Rainitovo Antananarivo" autoFocus/>{searching && <small style={{ position: 'absolute', right: 14, top: 22 }}>Recherche…</small>}</div></label>
    {!!results.length && <div className="list" style={{ marginTop: 10 }}>{results.map(item => <button type="button" key={item.id} className="row-item" onClick={() => choose(item)}>
      <span className="icon-tile"><Icon name="pin" size={18}/></span><span className="row-copy"><strong>{item.name}</strong><small>{item.formattedAddress}</small></span>
    </button>)}</div>}
    {searchError && !results.length && <p className="hint">{searchError}</p>}
    <MapPicker value={point} onChange={move}/>
    {point && <div className="notice success" style={{ marginTop: 12, marginBottom: 0 }}>✓ Position placée : la boutique sera visible sur la carte de l’application.</div>}
    <div className="form-grid">
      <label>Nom affiché aux clients<input required maxLength={200} value={name} onChange={event => setName(event.target.value)} placeholder="Orange Analakely"/></label>
      <label>Ville<input value={city} maxLength={120} onChange={event => setCity(event.target.value)} placeholder="Antananarivo"/></label>
    </div>
    <label>Adresse<input value={address} maxLength={300} onChange={event => setAddress(event.target.value)} placeholder="Lot, rue, quartier"/></label>
    {error && <div className="notice" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}
    <div className="dialog-actions"><button type="button" className="btn ghost" onClick={onClose}>Annuler</button><button className="btn primary" disabled={busy || !name.trim() || !point}>{busy ? 'Création…' : 'Créer puis ouvrir des créneaux'}</button></div>
  </Modal>;
}

function App() {
  const session = useSession();
  return <ToastProvider>{session.user
    ? <AdminDashboard {...session}/>
    : <Login title="Administration" subtitle="Utilisez le compte Robia propriétaire de votre organisation et de ses boutiques." login={session.login}/>}</ToastProvider>;
}
createRoot(document.getElementById('root')).render(<App/>);
