// GET /api/ship/rate?method=locker|door&dest=<locker_id|address>&oversize=true|false
// Returns Bob Go's live rate for the chosen method/destination, passed
// through at cost (no markup). This is a checkout-time PREVIEW so the
// customer sees a price before committing — the authoritative recompute
// (which can't be tricked by a tampered oversize flag) happens again
// server-side in /api/pay/init right before the total is signed.
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
  const oversize = url.searchParams.get('oversize') === 'true';

  if (method !== 'locker' && method !== 'door') {
    return json({ ok: false, error: 'method must be "locker" or "door"' }, 400);
  }

  try {
    const result = await fetchRate(env, { method, dest, oversize });
    return json(result, result.ok ? 200 : 400);
  } catch (err) {
    console.error('[ship/rate] error:', err && err.message);
    return json({ ok: false, error: err && err.message || 'Could not get a rate' }, 500);
  }
}
