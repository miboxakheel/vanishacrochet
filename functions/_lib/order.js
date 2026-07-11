import { sbSelect, sbUpdate } from './supabase.js';
import { sendMail } from './sendEmail.js';
import { buildCustomerEmail, buildVanishaEmail } from './orderEmail.js';

// Shared by the real Paystack webhook, /api/pay/verify's belt-and-braces
// fallback, and the MOCK_MODE "simulate success" button — one code path so
// "mark paid + notify" only ever happens once, however it's triggered.
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
  const rows = await sbSelect(
    env,
    'orders',
    `order_number=eq.${encodeURIComponent(orderNumber)}&select=*,order_items(*)`
  );
  const order = rows[0];
  if (!order) return { ok: false, error: 'order_not_found' };

  if (order.status !== 'pending') {
    // Idempotent: webhook retries, verify-fallback races, and the mock
    // button can all land on an already-processed order.
    return { ok: true, alreadyProcessed: true, order };
  }

  const updatedRows = await sbUpdate(env, 'orders', `id=eq.${order.id}`, { status: 'confirmed' });
  const finalOrder = updatedRows[0] || Object.assign({}, order, { status: 'confirmed' });
  finalOrder.order_items = order.order_items;

  await notifyOrder(env, finalOrder);
  return { ok: true, order: finalOrder };
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
