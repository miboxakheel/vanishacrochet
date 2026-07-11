// GET /api/pay/verify?reference=VC-...
// Belt-and-braces check used by the confirmation page after Paystack
// redirects the browser back via callback_url. The webhook is the
// authoritative "mark paid" path; this just reads current status, and — only
// if the webhook hasn't landed yet and we're not in MOCK_PAYMENTS — double-
// checks directly with Paystack so the customer isn't stuck on "pending" for
// an order that actually succeeded.
import { sbSelect } from '../../_lib/supabase.js';
import { paystackVerify } from '../../_lib/paystack.js';
import { markOrderConfirmedAndNotify } from '../../_lib/order.js';

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const reference = url.searchParams.get('reference');
  if (!reference) return json({ ok: false, error: 'reference required' }, 400);

  try {
    // Note: `orders` has no `currency` column (single-currency store) — the
    // display currency comes from env.CURRENCY, not the row.
    const selectCols = 'order_number,status,first_name,email,mobile,subtotal,shipping_fee,discount,total,address_line1,city,order_items(product_name,size,color,qty,unit_price)';
    let rows = await sbSelect(env, 'orders', `order_number=eq.${encodeURIComponent(reference)}&select=${selectCols}`);
    let order = rows[0];
    if (!order) return json({ ok: false, error: 'order not found' }, 404);

    if (order.status === 'pending' && env.MOCK_PAYMENTS !== 'true') {
      try {
        const psData = await paystackVerify(env, reference);
        if (psData.status === 'success') {
          const result = await markOrderConfirmedAndNotify(env, reference);
          if (result.ok) order = Object.assign({}, order, { status: result.order.status });
        }
      } catch (e) {
        // Paystack verify failing here just means we fall back to whatever
        // status Supabase already has — the webhook will still land.
        console.warn('[pay/verify] Paystack verify check failed:', e && e.message);
      }
    }

    return json({
      ok: true,
      status: order.status,
      orderNumber: order.order_number,
      firstName: order.first_name,
      email: order.email,
      phone: order.mobile,
      subtotal: order.subtotal,
      shipping: order.shipping_fee,
      discount: order.discount,
      total: order.total,
      currency: env.CURRENCY || 'R',
      isDigitalOnly: !order.address_line1 && !order.city,
      items: order.order_items || []
    });
  } catch (err) {
    console.error('[pay/verify] error:', err && err.message);
    return json({ ok: false, error: err && err.message || 'Server error' }, 500);
  }
}
