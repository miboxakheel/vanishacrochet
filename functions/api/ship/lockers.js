// GET /api/ship/lockers?near=<suburb/town/query>
// Returns the Bob Box/PUDO locker list (optionally filtered by a free-text
// search). Never hardcoded into the site — this always comes from here (mock
// data in MOCK_MODE, Bob Go's daily-cached full list otherwise).
import { fetchLockers } from '../../_lib/bobgo.js';

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const near = url.searchParams.get('near') || '';

  try {
    const lockers = await fetchLockers(env, near);
    return json({ ok: true, lockers });
  } catch (err) {
    console.error('[ship/lockers] error:', err && err.message);
    return json({ ok: false, error: err && err.message || 'Could not load lockers' }, 500);
  }
}
