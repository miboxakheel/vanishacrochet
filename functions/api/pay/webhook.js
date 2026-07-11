// POST /api/pay/webhook — Paystack calls this directly, never the browser.
// Verifies the HMAC-SHA512 x-paystack-signature against the RAW body, then
// on charge.success marks the matching order 'confirmed' and fires the two
// order emails. Idempotent — safe to receive the same event twice.
import { verifyPaystackSignature } from '../../_lib/paystack.js';
import { markOrderConfirmedAndNotify } from '../../_lib/order.js';

export async function onRequestPost({ request, env }) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-paystack-signature');

  const valid = await verifyPaystackSignature(rawBody, signature, env.PAYSTACK_SECRET_KEY);
  if (!valid) {
    console.warn('[webhook] invalid or missing signature');
    return new Response('Invalid signature', { status: 401 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Always ack quickly with 200 once the signature is valid — Paystack
  // retries on non-200, and we don't want retries piling up on events we
  // deliberately ignore (e.g. failed charges).
  if (event.event !== 'charge.success') {
    return new Response('ignored', { status: 200 });
  }

  const reference = event.data && event.data.reference;
  if (!reference) return new Response('missing reference', { status: 200 });

  try {
    const result = await markOrderConfirmedAndNotify(env, reference);
    if (!result.ok) console.warn('[webhook] could not confirm order', reference, result.error);
    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('[webhook] processing error for', reference, err && err.message);
    // Still 200 — Paystack would otherwise retry indefinitely on a bug we
    // need to fix server-side, not one it can solve by resending.
    return new Response('error logged', { status: 200 });
  }
}
