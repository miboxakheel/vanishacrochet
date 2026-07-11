// Bob Go / PUDO ("Bob Box") locker + rate integration.
//
// CONFIDENCE NOTE — unlike Paystack (well-known, stable, high-confidence):
// Bob Go's API reference (https://api-docs.bob.co.za/bobgo) is a JS-rendered
// docs site that couldn't be scraped for exact endpoint paths/field names.
// Confirmed from public sources: base URLs are
// https://api.sandbox.bobgo.co.za/v2/ (sandbox) and https://api.bobgo.co.za/v2/
// (production), auth is a Bearer token, there's a "Rates at Checkout" API that
// takes parcel + origin/destination details and returns rate options, and a
// "Bob Box" locker network. The exact path segments and JSON field names in
// the non-mock branches below are a BEST-EFFORT PLACEHOLDER — confirm against
// the real docs (sign into the Bob Go sandbox dashboard) before flipping
// MOCK_MODE off. MOCK_MODE doesn't depend on any of this being right.

const BOBGO_BASE = {
  sandbox: 'https://api.sandbox.bobgo.co.za/v2',
  production: 'https://api.bobgo.co.za/v2'
};

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

export async function fetchLockers(env, near) {
  if (env.MOCK_MODE === 'true') {
    return MOCK_LOCKERS.filter(l => matchesQuery(l, near));
  }

  // Real mode: fetch + daily-cache the FULL list, then filter locally so a
  // locker search never re-hits Bob Go per keystroke (handoff §6: "daily-
  // cached refresh... customer searches hit the fast cached copy").
  const full = await fetchFullLockerListCached(env);
  return full.filter(l => matchesQuery(l, near));
}

async function fetchFullLockerListCached(env) {
  const cache = caches.default;
  const cacheKey = new Request('https://internal.cache/bobgo-lockers-full-v1');
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  // NOT VERIFIED against real Bob Go docs — confirm the path/response shape.
  const res = await fetch(`${bobgoBase(env)}/bob-box/lockers`, {
    headers: { Authorization: `Bearer ${env.BOBGO_API_KEY}` }
  });
  if (!res.ok) throw new Error('Bob Go locker list fetch failed: ' + res.status);
  const data = await res.json();
  const lockers = normalizeLockerList(data);

  const cacheResponse = new Response(JSON.stringify(lockers), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' }
  });
  await cache.put(cacheKey, cacheResponse.clone());
  return lockers;
}

function normalizeLockerList(raw) {
  // Best-effort shape guess — adjust field names once the real response is seen.
  const list = Array.isArray(raw) ? raw : (raw.data || raw.lockers || []);
  return list.map(l => ({
    id: l.id || l.code,
    name: l.name || l.title,
    address: l.address || l.formatted_address || '',
    suburb: l.suburb || '',
    city: l.city || '',
    province: l.province || '',
    lat: l.lat != null ? l.lat : (l.location && l.location.lat),
    lng: l.lng != null ? l.lng : (l.location && l.location.lng),
    hours: l.hours || l.opening_hours || '24/7'
  }));
}

// ── Rates ───────────────────────────────────────────────────────────────
// Deterministic (not random) so the same destination always quotes the same
// mock rate on repeat calls within a session — realistic without flickering.
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}

// method: 'locker' | 'door'. dest: locker id (for locker) or a free-text
// address (for door). oversize: true if the cart contains an item flagged
// too large for a PUDO locker (see products.oversize, Supabase step 13).
export async function fetchRate(env, { method, dest, oversize }) {
  if (method === 'locker' && oversize) {
    return { ok: false, error: 'One or more items in your basket are too large for a PUDO locker — please choose door delivery.' };
  }
  if (!dest) {
    return { ok: false, error: method === 'locker' ? 'Please choose a locker' : 'Delivery address required' };
  }

  if (env.MOCK_MODE === 'true') {
    const h = hashString(String(dest));
    if (method === 'locker') {
      return { ok: true, rate: 60 + (h % 16), currency: 'ZAR', service: 'PUDO Locker-to-Locker', etaDays: '1-3' };
    }
    return { ok: true, rate: 95 + (h % 46), currency: 'ZAR', service: 'Door-to-Door', etaDays: '2-4' };
  }

  // NOT VERIFIED against real Bob Go docs — confirm the path/body/response
  // shape (their Rates-at-Checkout API takes parcel + origin/destination
  // details; this sends the minimum plausible body).
  const res = await fetch(`${bobgoBase(env)}/rates`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.BOBGO_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      service_type: method === 'locker' ? 'locker-to-locker' : 'door-to-door',
      destination: dest
    })
  });
  if (!res.ok) throw new Error('Bob Go rate fetch failed: ' + res.status);
  const data = await res.json();
  const cheapest = normalizeRate(data);
  if (!cheapest.rate) return { ok: false, error: 'No rate available for that destination' };
  return { ok: true, rate: cheapest.rate, currency: cheapest.currency || 'ZAR', service: cheapest.service, etaDays: cheapest.etaDays };
}

function normalizeRate(raw) {
  const options = Array.isArray(raw) ? raw : (raw.rates || raw.data || []);
  const sorted = options.slice().sort((a, b) => (a.rate || a.total || a.amount || 0) - (b.rate || b.total || b.amount || 0));
  const cheapest = sorted[0] || {};
  return {
    rate: Number(cheapest.rate || cheapest.total || cheapest.amount || 0),
    currency: cheapest.currency || 'ZAR',
    service: cheapest.service_level_name || cheapest.name || '',
    etaDays: cheapest.delivery_estimate || ''
  };
}
