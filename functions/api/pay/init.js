// POST /api/pay/init
// Body: { customer:{firstName,lastName,email,phone},
//         delivery:{type:'pickup'|'locker'|'door', lockerId, street,city,province,postalCode,country},
//         notes, items:[{kind,id,size,color,qty}], accessToken }
// Recomputes the order total from Supabase (never trusts the client's numbers),
// resolves shipping (Bob Go live rate for locker/door, 0 for pickup — gated by
// MOCK_DELIVERY inside bobgo.js), creates the order server-side, then either
// returns a MOCK_PAYMENTS fake-success payload or a real Paystack
// authorization_url to redirect the browser to.
import { sbSelect, sbInsert, sbUpsert, sbGetUserFromToken } from '../../_lib/supabase.js';
import { computeOrderTotals, applyShipping, flatFallbackShipping } from '../../_lib/pricing.js';
import { fetchRate } from '../../_lib/bobgo.js';
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
  if (delivery.type === 'door' && (!delivery.street || !delivery.city)) {
    return json({ ok: false, error: 'Street and city required for door delivery' }, 400);
  }
  if (delivery.type === 'locker' && !delivery.lockerId) {
    return json({ ok: false, error: 'Please choose a locker' }, 400);
  }

  try {
    const productIds = items.filter(x => x.kind === 'product').map(x => x.id);
    const patternIds = items.filter(x => x.kind === 'pattern').map(x => x.id);
    // Kit lines aren't rows in `products` — they need their parent pattern's
    // data.kit for price/availability, so fetch those pattern rows too even
    // though the kit itself never appears in `patternIds`.
    const kitPatternIds = items.filter(x => x.kind === 'kit').map(x => x.patternId);
    const neededPatternIds = Array.from(new Set(patternIds.concat(kitPatternIds).map(String)));

    // Batch every Supabase read in parallel — one round-trip set, not five
    // sequential ones (handoff §6: eu-west adds ~150-200ms per hop for SA users).
    const [settingsRes, productsRes, patternsRes, promotionsRes, user] = await Promise.all([
      sbSelect(env, 'settings', 'id=eq.1&select=data'),
      productIds.length ? sbSelect(env, 'products', `local_id=in.(${productIds.map(id => encodeURIComponent(id)).join(',')})&select=*`) : Promise.resolve([]),
      neededPatternIds.length ? sbSelect(env, 'patterns', `local_id=in.(${neededPatternIds.map(id => encodeURIComponent(id)).join(',')})&select=*`) : Promise.resolve([]),
      sbSelect(env, 'promotions', 'active=eq.true&select=*'),
      sbGetUserFromToken(env, body.accessToken)
    ]);

    const settings = (settingsRes[0] && settingsRes[0].data) || {};

    if (patternIds.length && !user) {
      return json({ ok: false, error: 'Please sign in to check out a basket containing patterns' }, 401);
    }

    const cartTotals = computeOrderTotals({
      cartLines: items,
      products: productsRes,
      patterns: patternsRes,
      promotions: promotionsRes,
      settings
    });

    // ── Resolve shipping — Bob Go's live rate for locker/door, authoritative
    // and re-derived server-side (never trust a client-submitted rate),
    // matching the same "never trust client" principle as pricing above.
    // Shipping MUST resolve before the total is signed (handoff §6/Task 4).
    let shipping = 0;
    let lockerDetails = null;
    if (!cartTotals.isDigitalOnly && delivery.type !== 'pickup') {
      const dest = delivery.type === 'locker' ? delivery.lockerId : [delivery.street, delivery.city, delivery.province, delivery.postalCode].filter(Boolean).join(', ');
      try {
        const rateResult = await fetchRate(env, { method: delivery.type, dest, sizeTier: cartTotals.cartSizeTier, destCity: delivery.lockerCity, destProvince: delivery.lockerProvince });
        if (!rateResult.ok) {
          return json({ ok: false, error: rateResult.error || 'Could not get a shipping rate' }, 400);
        }
        shipping = rateResult.rate;
        if (delivery.type === 'locker') lockerDetails = delivery.lockerName ? `PUDO Locker: ${delivery.lockerName} (${delivery.lockerId})` : `PUDO Locker: ${delivery.lockerId}`;
      } catch (err) {
        // Bob Go network/API failure (not the customer's fault) — fall back
        // to the flat rate rather than blocking the sale entirely.
        console.warn('[pay/init] Bob Go rate fetch failed, using flat fallback:', err && err.message);
        shipping = flatFallbackShipping(settings);
      }
    }
    const totals = applyShipping(cartTotals, shipping);

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
      // orders has no delivery-method column — for locker orders the locker's
      // name/id is encoded into address_line1 so it reads naturally in the
      // admin order view (city/province/postal left blank for locker orders).
      address_line1: totals.isDigitalOnly ? '' : (delivery.type === 'locker' ? lockerDetails : (delivery.street || '')),
      city: totals.isDigitalOnly || delivery.type === 'locker' ? '' : (delivery.city || ''),
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

    // Pattern purchases — same shape/semantics as the old client-side
    // saveOrderToDB: free patterns unlock immediately, paid ones link to
    // this order and unlock once the order's status leaves 'pending'.
    const patternLines = totals.lineItems.filter(x => x.kind === 'pattern');
    const purchaseRows = (patternLines.length && user)
      ? patternLines.map(x => ({
          user_id: user.id,
          local_pattern_id: x.id,
          pattern_name: x.name,
          order_id: x.price > 0 ? order.id : null
        }))
      : [];

    // order_items and pattern_purchases both depend only on order.id (just
    // inserted) and not on each other — fire them together so it's one
    // SA->eu-west round trip instead of two sequential ones.
    await Promise.all([
      itemRows.length ? sbInsert(env, 'order_items', itemRows) : Promise.resolve(),
      purchaseRows.length ? sbUpsert(env, 'pattern_purchases', purchaseRows, 'user_id,local_pattern_id') : Promise.resolve()
    ]);

    const mock = env.MOCK_PAYMENTS === 'true';
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
