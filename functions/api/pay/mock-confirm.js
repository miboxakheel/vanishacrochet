// POST /api/pay/mock-confirm — MOCK_MODE-only. Body: { reference }.
// This is the target of the checkout's "Simulate Payment Success" button
// (spec Task 3: "the webhook path is exercised by a simulate-success
// button"). Runs the exact same mark-paid-and-notify path a real Paystack
// webhook would, so the mocked flow proves out the same code the real one
// uses. Refuses to run outside MOCK_MODE so it can never be used to
// free-confirm a real order.
import { markOrderConfirmedAndNotify } from '../../_lib/order.js';

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestPost({ request, env }) {
  if (env.MOCK_MODE !== 'true') {
    return json({ ok: false, error: 'mock-confirm is only available in MOCK_MODE' }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.reference) return json({ ok: false, error: 'reference required' }, 400);

  try {
    const result = await markOrderConfirmedAndNotify(env, body.reference);
    if (!result.ok) return json(result, 404);
    return json({ ok: true, status: result.order.status });
  } catch (err) {
    console.error('[pay/mock-confirm] error:', err && err.message);
    return json({ ok: false, error: err && err.message || 'Server error' }, 500);
  }
}
