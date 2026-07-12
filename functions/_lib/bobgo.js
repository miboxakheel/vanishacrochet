// Bob Go / PUDO ("Bob Box") locker + rate integration.
// deploy-marker: 2026-07-12b (forces a fresh deploy so newly-saved dashboard
// env vars — SHIP_FROM_* — actually get baked into the live Function;
// Cloudflare Pages snapshots vars at deploy time, not read live per-request)
//
// REAL API — VERIFIED against the live sandbox (2026-07-11, using a real
// BOBGO_API_KEY in .dev.vars). Their docs site (api-docs.bob.co.za) is a
// JS-rendered SPA that couldn't be scraped, so this was reverse-engineered by
// making real calls and reading the validation errors/responses:
//
// - Base URLs: https://api.sandbox.bobgo.co.za/v2 (sandbox),
//   https://api.bobgo.co.za/v2 (production). Auth: `Authorization: Bearer <key>`.
// - `GET /locations?lat=&lng=` → { locations: [{id, name, human_name, lat, lng,
//   address, full_address, trading_hours, active, compartment_errors}], count }.
//   Requires lat/lng — there is NO free-text search on this endpoint.
// - `POST /rates` creates an ASYNC rate request and returns immediately, often
//   with provider statuses still "pending" (responses: []). Body:
//   { collection_address: {street_address, local_area, city, zone, code, country},
//     delivery_address: {...same shape...}, parcels: [{submitted_length_cm,
//     submitted_width_cm, submitted_height_cm, submitted_weight_kg}],
//     pickup_point_location_id?: <locker id, for locker quotes> }.
//   lat/lng in the address objects are optional — Bob Go geocodes the text
//   fields itself.
// - `GET /rates?id=<id>` polls the same request until every entry in
//   provider_rate_requests[].status is no longer "pending". Each resolved
//   provider has responses: [{service_level_code, service_level:{delivery_type:
//   'door'|'pickup-point', name, parcel_size_name, ...}, rate_amount,
//   rate_amount_excl_vat, status}]. Locker vs door is filtered by
//   service_level.delivery_type, not a request parameter — a single rate
//   request can return both if pickup_point_location_id is omitted.
// - Oversized parcels naturally come back with ONLY delivery_type:"door"
//   responses (tested 100x80x60cm/15kg — zero pickup-point options) — Bob Go
//   itself enforces locker size limits once real dimensions are submitted.
//   We size the parcel per product tier (functions/_lib/sizes.js); if a tier
//   ever exceeds every locker box, Bob Go simply returns no pickup-point
//   option and the order falls back to door-only.
// - No endpoint exposes a pre-configured warehouse/collection address for the
//   account (checked /accounts) — the store's collection address must be
//   configured here via env vars (SHIP_FROM_*, see wrangler.toml).
// - The collection side can ALSO be a locker, via `collection_pickup_point_
//   location_id` + a required `pickup_point_provider_slug` (verified) — this
//   is what makes a genuine Locker-to-Locker quote (Bob Box, priced by parcel
//   size, not distance) rather than an address-to-locker quote. The slug
//   scopes the quote to ONE courier (only couriers that support locker
//   collection will respond — confirmed one sandbox provider explicitly
//   rejects it with "does not support collection pickup points"), so which
//   slug to use is an account-specific fact, not something to guess — see
//   SHIP_FROM_LOCKER_ID / SHIP_FROM_LOCKER_PROVIDER_SLUG in wrangler.toml.
//   Tried also giving Locker→Locker's collection point a real DOOR delivery
//   address (no pickup_point_location_id) hoping for a distinct "locker
//   collected, delivered to door" product — Bob Go still only returned the
//   same Bob Box/pickup-point rate, so that combination doesn't appear to
//   exist as a real product on this account. Door deliveries stay
//   address-to-address (unchanged) rather than guessing further.

import { SIZE_TIERS, normalizeTier, parcelForTier } from './sizes.js';

const BOBGO_BASE = {
  sandbox: 'https://api.sandbox.bobgo.co.za/v2',
  production: 'https://api.bobgo.co.za/v2'
};

// Bare `fetch()` never times out on its own — a stalled Bob Go sandbox call
// used to hang the whole checkout indefinitely with no way to recover. Every
// Bob Go/geocoding call below goes through this so a stall fails fast enough
// for the caller's existing flat-rate fallback (see init.js) to kick in.
async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`Request to ${url} timed out after ${ms}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function bobgoBase(env) {
  return env.BOBGO_ENV === 'production' ? BOBGO_BASE.production : BOBGO_BASE.sandbox;
}

// ── Mock data — realistic Bob Box/PUDO lockers across SA metros ───────────
const MOCK_LOCKERS = [
  { id: 'pudo-ctn-001', name: 'PUDO Locker - Canal Walk', address: 'Canal Walk Shopping Centre, Century City', suburb: 'Century City', city: 'Cape Town', province: 'Western Cape', lat: -33.8934, lng: 18.5107, hours: '24/7' },
  { id: 'pudo-ctn-002', name: 'PUDO Locker - Cavendish Square', address: 'Cavendish Square, Claremont', suburb: 'Claremont', city: 'Cape Town', province: 'Western Cape', lat: -33.9814, lng: 18.4665, hours: '06:00-22:00' },
  { id: 'pudo-ctn-003', name: 'PUDO Locker - V&A Waterfront', address: 'Victoria Wharf, V&A Waterfront', suburb: 'V&A Waterfront', city: 'Cape Town', province: 'Western Cape', lat: -33.9036, lng: 18.4201, hours: '24/7' },
  { id: 'pudo-jhb-001', name: 'PUDO Locker - Sandton City', address: 'Sandton City Shopping Centre, Sandton', suburb: 'Sandton', city: 'Johannesburg', province: 'Gauteng', lat: -26.1076, lng: 28.0567, hours: '24/7' },
  { id: 'pudo-jhb-002', name: 'PUDO Locker - Rosebank Mall', address: 'The Zone @ Rosebank, Rosebank', suburb: 'Rosebank', city: 'Johannesburg', province: 'Gauteng', lat: -26.1467, lng: 28.0436, hours: '06:00-22:00' },
  { id: 'pudo-jhb-003', name: 'PUDO Locker - Eastgate', address: 'Eastgate Shopping Centre, Bedfordview', suburb: 'Bedfordview', city: 'Johannesburg', province: 'Gauteng', lat: -26.1808, lng: 28.1225, hours: '24/7' },
  { id: 'pudo-dbn-001', name: 'PUDO Locker - Gateway Theatre of Shopping', address: 'Gateway Theatre of Shopping, Umhlanga', suburb: 'Umhlanga', city: 'Durban', province: 'KwaZulu-Natal', lat: -29.7263, lng: 31.0699, hours: '24/7' },
  { id: 'pudo-dbn-002', name: 'PUDO Locker - Pavilion Shopping Centre', address: 'Pavilion Shopping Centre, Westville', suburb: 'Westville', city: 'Durban', province: 'KwaZulu-Natal', lat: -29.8271, lng: 30.9214, hours: '06:00-21:00' },
  { id: 'pudo-pta-001', name: 'PUDO Locker - Menlyn Park', address: 'Menlyn Park Shopping Centre, Menlyn', suburb: 'Menlyn', city: 'Pretoria', province: 'Gauteng', lat: -25.7825, lng: 28.2775, hours: '24/7' }
];

function matchesQuery(locker, q) {
  if (!q || !q.trim()) return true;
  const needle = q.trim().toLowerCase();
  return [locker.name, locker.address, locker.suburb, locker.city, locker.province].some(
    field => field && field.toLowerCase().indexOf(needle) !== -1
  );
}

// ── Real mode: /locations needs lat/lng, there's no free-text search ──────
// Verified directly (2026-07-11): passing an `address` param alongside/without
// lat/lng does nothing — Bob Go's /locations always follows the literal
// coordinates. So an arbitrary suburb/town search needs real geocoding first.
// Using OpenStreetMap's Nominatim (free, no signup/API key) rather than a
// hand-maintained coordinate table — a short list can only ever cover a
// handful of named metros, and fabricating coordinates for hundreds of real
// SA suburbs from memory risked silently wrong entries with no way to verify
// them. Nominatim's usage policy requires a real identifying User-Agent (the
// default one gets an "Access denied" — confirmed while testing) and caps
// at ~1 request/sec, which client-side debouncing plus this cache comfortably
// stays under at this store's volume.
const NOMINATIM_USER_AGENT = 'VanishaCrochet/1.0 (+https://vanishacrochet.co.za; orders@vanishacrochet.co.za)';

async function geocodeQuery(env, near) {
  const cache = caches.default;
  const cacheKey = new Request(`https://internal.cache/geocode-${encodeURIComponent(near.trim().toLowerCase())}-v1`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const text = await cached.text();
    return text ? JSON.parse(text) : null;
  }

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=za&q=${encodeURIComponent(near)}`;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': NOMINATIM_USER_AGENT, 'Accept-Language': 'en' } }, 8000);
  if (!res.ok) throw new Error('Geocoding request failed: ' + res.status);
  const results = await res.json();
  const coords = results.length ? { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) } : null;

  // Cache both hits and misses for 30 days — place coordinates (or the fact
  // that a typo'd query has no match) don't change, and this is what keeps
  // repeat/common searches from re-hitting Nominatim at all.
  const cacheResponse = new Response(JSON.stringify(coords), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=2592000' }
  });
  await cache.put(cacheKey, cacheResponse.clone());
  return coords;
}

function normalizeLocker(l) {
  return {
    id: l.id,
    name: l.human_name || l.name,
    address: l.full_address || l.address || '',
    suburb: '',
    city: '',
    province: '',
    lat: l.lat,
    lng: l.lng,
    hours: l.trading_hours || '24/7'
  };
}

async function fetchLockersAt(env, lat, lng) {
  const cache = caches.default;
  // Round to ~1.1km grid so nearby searches (different suburbs a few blocks
  // apart) share a cache entry instead of each making their own Bob Go call.
  const gridKey = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  // v4: bumped because v3 entries were cached with pre-dedupe duplicate data —
  // this forces a clean refetch instead of serving the stale cached response.
  const cacheKey = new Request(`https://internal.cache/bobgo-lockers-${gridKey}-v4`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const res = await fetchWithTimeout(`${bobgoBase(env)}/locations?lat=${lat}&lng=${lng}`, {
    headers: { Authorization: `Bearer ${env.BOBGO_API_KEY}`, Accept: 'application/json' }
  }, 8000);
  if (!res.ok) throw new Error('Bob Go locations fetch failed: ' + res.status);
  const data = await res.json();
  // Bob Go can list the same physical locker once per provider offering it
  // (verified: your sandbox account has both a "demo" and "sandbox" provider
  // serving the same locker, returned as two identical entries) — dedupe by id.
  const seen = new Set();
  const lockers = (data.locations || [])
    .filter(l => l.active !== false && (!l.compartment_errors || !l.compartment_errors.length))
    .filter(l => { if (seen.has(l.id)) return false; seen.add(l.id); return true; })
    .map(normalizeLocker);

  // Daily cache — never hardcoded, never hit per keystroke.
  const cacheResponse = new Response(JSON.stringify(lockers), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' }
  });
  await cache.put(cacheKey, cacheResponse.clone());
  return lockers;
}

export async function fetchLockers(env, near) {
  if (env.MOCK_DELIVERY === 'true') {
    return MOCK_LOCKERS.filter(l => matchesQuery(l, near));
  }
  if (!near || !near.trim()) return [];

  const coords = await geocodeQuery(env, near);
  if (!coords) return []; // Nominatim couldn't place it — ask the customer to be more specific
  return fetchLockersAt(env, coords.lat, coords.lng);
}

// ── Rates ───────────────────────────────────────────────────────────────
// Deterministic (not random) so the same destination always quotes the same
// mock rate on repeat calls within a session — realistic without flickering.
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}

function originAddress(env) {
  return {
    street_address: env.SHIP_FROM_STREET || '',
    local_area: env.SHIP_FROM_SUBURB || '',
    city: env.SHIP_FROM_CITY || '',
    zone: env.SHIP_FROM_PROVINCE || '',
    code: env.SHIP_FROM_POSTAL || '',
    country: env.SHIP_FROM_COUNTRY || 'ZA'
  };
}

// Set once Vanisha has chosen her own regular drop-off locker — until then,
// Locker quotes fall back to address-based collection (SHIP_FROM_*), which
// returns the same Bob Box pricing anyway since it's sized-based not
// distance-based, so nothing breaks while this is unset.
function hasCollectionLockerConfig(env) {
  return !!(env.SHIP_FROM_LOCKER_ID && env.SHIP_FROM_LOCKER_PROVIDER_SLUG);
}

async function createRateRequest(env, { deliveryAddress, pickupPointLocationId, sizeTier, useCollectionLocker }) {
  const body = {
    collection_address: originAddress(env),
    delivery_address: deliveryAddress,
    parcels: parcelForTier(sizeTier)
  };
  if (pickupPointLocationId) body.pickup_point_location_id = pickupPointLocationId;
  if (useCollectionLocker && hasCollectionLockerConfig(env)) {
    body.collection_pickup_point_location_id = Number(env.SHIP_FROM_LOCKER_ID);
    body.pickup_point_provider_slug = env.SHIP_FROM_LOCKER_PROVIDER_SLUG;
  }

  const res = await fetchWithTimeout(`${bobgoBase(env)}/rates`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.BOBGO_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  }, 8000);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Bob Go rate request failed: ${res.status} ${detail}`);
  }
  return res.json(); // { id, provider_rate_requests: [...] }
}

function isFullyResolved(rateRequest) {
  return (rateRequest.provider_rate_requests || []).every(p => p.status !== 'pending');
}

// Rates are async — poll a few times with a short gap. In sandbox testing
// this typically resolved within ~1-3s; give up after a handful of tries
// and let the caller fall back to the flat rate rather than hang the
// customer's checkout indefinitely.
async function pollRateRequest(env, id, attempts) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetchWithTimeout(`${bobgoBase(env)}/rates?id=${id}`, {
      headers: { Authorization: `Bearer ${env.BOBGO_API_KEY}`, Accept: 'application/json' }
    }, 8000);
    if (!res.ok) throw new Error('Bob Go rate poll failed: ' + res.status);
    const data = await res.json();
    const reqObj = (data.rate_requests && data.rate_requests[0]) || null;
    if (reqObj && isFullyResolved(reqObj)) return reqObj;
    if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, 900));
  }
  return null;
}

function cheapestForDeliveryType(rateRequest, wantType) {
  let best = null;
  (rateRequest.provider_rate_requests || []).forEach(p => {
    (p.responses || []).forEach(r => {
      if (r.status !== 'success') return;
      if (!r.service_level || r.service_level.delivery_type !== wantType) return;
      if (!best || r.rate_amount < best.rate_amount) best = r;
    });
  });
  return best;
}

// method: 'locker' | 'door'.
// dest: for 'locker', the Bob Go location id (from fetchLockers); for 'door',
// "street, city, province" (matches how the checkout builds it).
// destCity/destProvince: optional hints used as the delivery_address for a
// locker quote (the actual routing comes from pickup_point_location_id, but
// Bob Go's API still wants a plausible delivery_address on the request).
// sizeTier: which PUDO Bob Box the order ships in ('standard'|'medium'|'large',
// the cart's largest item — see functions/_lib/sizes.js). Determines the
// parcel dimensions we submit, so the returned rate is that box's real price.
export async function fetchRate(env, { method, dest, sizeTier, destCity, destProvince }) {
  const tier = normalizeTier(sizeTier);
  // A tier can be flagged non-lockerable in sizes.js (e.g. a future production
  // box bigger than any locker). None of the current S/M/L tiers are, so this
  // normally never triggers; door-only otherwise falls out naturally when Bob
  // Go returns no pickup-point box for the submitted parcel.
  if (method === 'locker' && !SIZE_TIERS[tier].lockerable) {
    return { ok: false, error: 'This order is too large for a PUDO locker — please choose door delivery.' };
  }
  if (!dest) {
    return { ok: false, error: method === 'locker' ? 'Please choose a locker' : 'Delivery address required' };
  }

  if (env.MOCK_DELIVERY === 'true') {
    const h = hashString(String(dest));
    if (method === 'locker') {
      // Plausible per-tier locker rate (indicative figures from sizes.js).
      const base = SIZE_TIERS[tier].approxLockerRate || 45;
      return { ok: true, rate: Math.round((base + (h % 5)) * 100) / 100, currency: 'ZAR', service: 'PUDO Bob Box (' + SIZE_TIERS[tier].boxName + ')', etaDays: '1-3' };
    }
    return { ok: true, rate: 95 + (h % 46), currency: 'ZAR', service: 'Door-to-Door', etaDays: '2-4' };
  }

  let deliveryAddress, pickupPointLocationId;
  if (method === 'locker') {
    // Bob Go requires this as a real JSON number (int64) — dest arrives here
    // as a string (it's a URL query param), so it must be converted, not
    // passed straight through, or the request is rejected as malformed JSON.
    pickupPointLocationId = Number(dest);
    if (!Number.isFinite(pickupPointLocationId)) {
      return { ok: false, error: 'Invalid locker selected' };
    }
    // Bob Go still requires *a* delivery_address on the request even though
    // pickup_point_location_id drives the actual quote — use the locker's
    // own city/province if the caller has it, else fall back to the origin.
    deliveryAddress = {
      street_address: '', local_area: '',
      city: destCity || env.SHIP_FROM_CITY || '',
      zone: destProvince || env.SHIP_FROM_PROVINCE || '',
      code: '', country: 'ZA'
    };
  } else {
    // street, city, province, postal code — postal code materially improves
    // Bob Go's own geocoding precision, so it's included even though it's not
    // required to place an order.
    const parts = String(dest).split(',').map(s => s.trim());
    deliveryAddress = { street_address: parts[0] || '', local_area: '', city: parts[1] || '', zone: parts[2] || '', code: parts[3] || '', country: 'ZA' };
  }

  const created = await createRateRequest(env, {
    deliveryAddress, pickupPointLocationId, sizeTier: tier,
    useCollectionLocker: method === 'locker'
  });
  const resolved = isFullyResolved(created) ? created : await pollRateRequest(env, created.id, 4);
  // Unlike the ok:false cases above (bad/missing input — a real error the
  // customer must fix), this is Bob Go's sandbox being transiently slow —
  // throw so init.js's existing catch falls back to flat-rate shipping
  // instead of failing the whole sale over third-party flakiness. The
  // client-side preview (api/ship/rate) still surfaces this as an error,
  // which is correct there — no need to fake a preview rate.
  if (!resolved) throw new Error('Bob Go is taking too long to quote a rate');

  const wantType = method === 'locker' ? 'pickup-point' : 'door';
  const best = cheapestForDeliveryType(resolved, wantType);
  if (!best) return { ok: false, error: 'No rate available for that destination' };

  const result = {
    ok: true,
    rate: best.rate_amount,
    currency: 'ZAR',
    service: (best.service_level && best.service_level.name) || '',
    etaDays: ''
  };

  // Door only: surface Bob Go's OWN geocoding confidence for the address the
  // customer typed, instead of silently discarding it. No live autocomplete
  // (decided against — Nominatim isn't licensed for that usage pattern), but
  // this lets the customer catch a typo before it affects their rate: a
  // 'ROOFTOP' match found the exact address; 'APPROXIMATE'/partial means Bob
  // Go could only place it roughly (street-level typo, missing suburb, etc.).
  if (method === 'door' && resolved.delivery_address) {
    const da = resolved.delivery_address;
    result.resolvedAddress = [da.street_address, da.local_area, da.city, da.zone_name].filter(Boolean).join(', ');
    result.addressPrecise = da.geo_location_type === 'ROOFTOP' && !da.geo_partial_match;
  }

  return result;
}
