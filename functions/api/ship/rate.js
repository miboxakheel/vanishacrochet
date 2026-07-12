// GET /api/ship/rate?method=locker|door&dest=<locker_id|address>&sizeTier=standard|medium|large
// Returns Bob Go's live rate for the chosen method/destination/box size,
// passed through at cost (no markup). This is a checkout-time PREVIEW so the
// customer sees a price before committing — the authoritative recompute
// (which re-derives the size tier from the products, so a tampered client
// value can't lower the box) happens again server-side in /api/pay/init
// right before the total is signed.
import { fetchRate } from '../../_lib/bobgo.js';

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const method = url.searchParams.get('method');
  const dest = url.searchParams.get('dest');
  const sizeTier = url.searchParams.get('sizeTier') || 'standard';
  const destCity = url.searchParams.get('destCity') || '';
  const destProvince = url.searchParams.get('destProvince') || '';

  if (method !== 'locker' && method !== 'door') {
    return json({ ok: false, error: 'method must be "locker" or "door"' }, 400);
  }

  try {
    const result = await fetchRate(env, { method, dest, sizeTier, destCity, destProvince });
    return json(result, result.ok ? 200 : 400);
  } catch (err) {
    console.error('[ship/rate] error:', err && err.message);
    return json({ ok: false, error: err && err.message || 'Could not get a rate' }, 500);
  }
}
