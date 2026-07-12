import { sbSelect, sbUpdate } from './supabase.js';
import { sendMail } from './sendEmail.js';
import { buildCustomerEmail, buildVanishaEmail } from './orderEmail.js';

// Shared by the real Paystack webhook, /api/pay/verify's belt-and-braces
// fallback, and the MOCK_PAYMENTS "simulate success" button — one code path
// so "mark paid + notify" only ever happens once, however it's triggered.
//
// NOTE on status value: the spec draft said mark status:'paid', but
// admin-dashboard.html's actual order-management UI (renderAdminOrders/
// setOrderStatus, ~line 3161-3216) is built entirely around the lifecycle
// pending -> confirmed -> shipped -> completed (with a dedicated
// "Confirm Payment" button and "customer download unlocked" copy tied to
// status === 'confirmed'). Using 'paid' would leave a paid order
// unrecognised by every status branch in that UI. Using 'confirmed' here
// instead, to match the dashboard that already exists.
export async function markOrderConfirmedAndNotify(env, orderNumber) {
  // Atomic claim-and-confirm. A single conditional PATCH flips the row from
  // pending -> confirmed *only if it is still pending*, and returns the full
  // row + items in the same round trip. Postgres serialises concurrent UPDATEs
  // on a row, so of the callers that can race here — the Paystack webhook,
  // /api/pay/verify's fallback, and the MOCK_PAYMENTS button — exactly ONE
  // sees status still 'pending' and gets a row back; every other caller
  // matches zero rows. notifyOrder() below runs only for that single winner,
  // so the customer can never receive two confirmation emails.
  //
  // (The `status:'confirmed'` value, not 'paid', matches admin-dashboard.html's
  // pending -> confirmed -> shipped -> completed lifecycle — see note above.)
  const claimed = await sbUpdate(
    env,
    'orders',
    `order_number=eq.${encodeURIComponent(orderNumber)}&status=eq.pending&select=*,order_items(*)`,
    { status: 'confirmed' }
  );

  if (claimed.length) {
    // We won the claim — the only path that emails.
    const order = claimed[0];
    await notifyOrder(env, order);
    return { ok: true, won: true, order };
  }

  // We did not win: the row was already non-pending (someone else confirmed it)
  // or the order number doesn't exist. One extra read — only on this rare,
  // deliberately email-free path — tells those two cases apart. notifyOrder()
  // is intentionally NOT called here.
  const rows = await sbSelect(
    env,
    'orders',
    `order_number=eq.${encodeURIComponent(orderNumber)}&select=*,order_items(*)`
  );
  if (rows.length) return { ok: true, won: false, alreadyProcessed: true, order: rows[0] };
  return { ok: false, error: 'order_not_found' };
}

async function notifyOrder(env, order) {
  const storeName = env.STORE_NAME || 'Vanisha Crochet';
  const cur = env.CURRENCY || 'R';
  const vanishaEmail = env.VANISHA_NOTIFY_EMAIL;

  const customer = buildCustomerEmail(order, storeName, cur);
  const vanisha = buildVanishaEmail(order, storeName, cur);

  const results = await Promise.allSettled([
    sendMail(env, { toEmail: order.email, toName: `${order.first_name || ''} ${order.last_name || ''}`.trim(), ...customer }),
    vanishaEmail
      ? sendMail(env, { toEmail: vanishaEmail, toName: storeName, ...vanisha })
      : Promise.resolve({ ok: false, error: 'VANISHA_NOTIFY_EMAIL not configured' })
  ]);

  results.forEach((r, i) => {
    if (r.status === 'rejected' || (r.value && r.value.ok === false)) {
      console.error('[order email]', i === 0 ? 'customer' : 'vanisha', 'send issue:', r.reason || (r.value && r.value.error));
    }
  });
}
