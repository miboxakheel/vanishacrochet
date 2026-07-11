// POST /api/pay/init
// Body: { customer:{firstName,lastName,email,phone}, delivery:{type,street,city,province,postalCode,country},
//         notes, items:[{kind,id,size,color,qty}], accessToken }
// Recomputes the order total from Supabase (never trusts the client's numbers),
// creates the order server-side, then either returns a MOCK_MODE fake-success
// payload or a real Paystack authorization_url to redirect the browser to.
import { sbSelect, sbInsert, sbUpsert, sbGetUserFromToken } from '../../_lib/supabase.js';
import { computeOrderTotals } from '../../_lib/pricing.js';
import { paystackInitialize } from '../../_lib/paystack.js';

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function generateOrderNum() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `VC-${yy}${mm}${dd}-${rand}`;
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const customer = body.customer || {};
  const delivery = body.delivery || {};
  const items = Array.isArray(body.items) ? body.items : [];

  if (!items.length) return json({ ok: false, error: 'Basket is empty' }, 400);
  if (!customer.email || customer.email.indexOf('@') === -1) return json({ ok: false, error: 'Valid email required' }, 400);
  if (!customer.firstName) return json({ ok: false, error: 'Name required' }, 400);
  if (delivery.type === 'delivery' && (!delivery.street || !delivery.city)) {
    return json({ ok: false, error: 'Street and city required for delivery' }, 400);
  }

  try {
    const productIds = items.filter(x => x.kind !== 'pattern').map(x => x.id);
    const patternIds = items.filter(x => x.kind === 'pattern').map(x => x.id);

    // Batch every Supabase read in parallel — one round-trip set, not five
    // sequential ones (handoff §6: eu-west adds ~150-200ms per hop for SA users).
    const [settingsRes, productsRes, patternsRes, promotionsRes, user] = await Promise.all([
      sbSelect(env, 'settings', 'id=eq.1&select=data'),
      productIds.length ? sbSelect(env, 'products', `local_id=in.(${productIds.map(id => encodeURIComponent(id)).join(',')})&select=*`) : Promise.resolve([]),
      patternIds.length ? sbSelect(env, 'patterns', `local_id=in.(${patternIds.map(id => encodeURIComponent(id)).join(',')})&select=*`) : Promise.resolve([]),
      sbSelect(env, 'promotions', 'active=eq.true&select=*'),
      sbGetUserFromToken(env, body.accessToken)
    ]);

    const settings = (settingsRes[0] && settingsRes[0].data) || {};

    if (patternIds.length && !user) {
      return json({ ok: false, error: 'Please sign in to check out a basket containing patterns' }, 401);
    }

    const totals = computeOrderTotals({
      cartLines: items,
      products: productsRes,
      patterns: patternsRes,
      promotions: promotionsRes,
      settings,
      deliveryType: delivery.type
    });

    const orderNumber = generateOrderNum();
    const currency = env.CURRENCY || settings.currency || 'R';
    const currencyCode = env.CURRENCY_CODE || 'ZAR';

    const orderRow = {
      user_id: user ? user.id : null,
      order_number: orderNumber,
      status: 'pending',
      first_name: customer.firstName || '',
      last_name: customer.lastName || '',
      email: customer.email,
      mobile: customer.phone || '',
      address_line1: totals.isDigitalOnly ? '' : (delivery.street || ''),
      city: totals.isDigitalOnly ? '' : (delivery.city || ''),
      province: delivery.province || '',
      postal_code: delivery.postalCode || '',
      country: delivery.country || '',
      subtotal: totals.subtotal,
      shipping_fee: totals.shipping,
      discount: totals.discount,
      total: totals.total,
      notes: body.notes || ''
    };

    const insertedOrders = await sbInsert(env, 'orders', [orderRow]);
    const order = insertedOrders[0];

    const itemRows = totals.lineItems.map(x => ({
      order_id: order.id,
      product_name: x.kind === 'pattern' ? `${x.name} (Pattern)` : x.name,
      size: x.size,
      color: x.color,
      qty: x.qty,
      unit_price: x.price
    }));
    if (itemRows.length) await sbInsert(env, 'order_items', itemRows);

    // Pattern purchases — same shape/semantics as the old client-side
    // saveOrderToDB: free patterns unlock immediately, paid ones link to
    // this order and unlock once the order's status leaves 'pending'.
    const patternLines = totals.lineItems.filter(x => x.kind === 'pattern');
    if (patternLines.length && user) {
      const purchaseRows = patternLines.map(x => ({
        user_id: user.id,
        local_pattern_id: x.id,
        pattern_name: x.name,
        order_id: x.price > 0 ? order.id : null
      }));
      await sbUpsert(env, 'pattern_purchases', purchaseRows, 'user_id,local_pattern_id');
    }

    const mock = env.MOCK_MODE === 'true';
    const responseBase = {
      ok: true,
      mock,
      orderNumber,
      currency,
      currencyCode,
      subtotal: totals.subtotal,
      discount: totals.discount,
      discountLines: totals.discountLines,
      shipping: totals.shipping,
      total: totals.total
    };

    if (mock) {
      return json(responseBase);
    }

    const origin = new URL(request.url).origin;
    const callbackUrl = `${origin}/?pay_reference=${encodeURIComponent(orderNumber)}`;
    const amountCents = Math.round(totals.total * 100);

    const paystackData = await paystackInitialize(env, {
      email: customer.email,
      amountCents,
      reference: orderNumber,
      callbackUrl,
      currencyCode
    });

    return json(Object.assign({}, responseBase, { authorizationUrl: paystackData.authorization_url }));
  } catch (err) {
    console.error('[pay/init] error:', err && err.message);
    return json({ ok: false, error: err && err.message || 'Server error' }, 500);
  }
}
