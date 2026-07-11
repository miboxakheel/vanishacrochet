// Authoritative, server-side order total computation — mirrors the site's
// client-side renderCheckout()/calcPromoDiscount()/getShipping() math, but
// reads prices/promotions fresh from Supabase so a tampered client total can
// never be trusted (per spec Task 3: "compute/verify total from source data").
//
// NOTE on promotions: the `products` table has NO promotion-linkage column
// (confirmed against Supabase_database/step 1.txt — products is fully
// normalized, no jsonb `data`). The site's client-side calcPromoDiscount()
// checks `product.promotionIds`, which can only ever be populated from the
// local embedded-seed fallback, never from a real Supabase-loaded product —
// so product-targeted promos (percent_off/buy3get1) silently never apply
// once the site is reading from the live database. That looks like a
// pre-existing bug, unrelated to payments. This function uses the *correct*
// direction instead — promotions.data.productIds (the column that actually
// exists) — because a payment total has to be right regardless. See the
// build summary for the one-line client-side fix this implies.

export function computeOrderTotals({ cartLines, products, patterns, promotions, settings, deliveryType, isDigitalOnlyOverride }) {
  const lineItems = [];
  let subtotal = 0;
  let hasPhysical = false;

  for (const line of cartLines) {
    const qty = Math.max(1, parseInt(line.qty, 10) || 1);
    let row, unitPrice, name, kind, promotionIds;

    if (line.kind === 'pattern') {
      row = patterns.find(p => String(p.local_id) === String(line.id));
      if (!row || row.active === false) throw new Error('Unknown or inactive pattern in cart: ' + line.id);
      const data = row.data || {};
      unitPrice = Number(row.price) || 0;
      name = data.name || 'Pattern';
      kind = 'pattern';
      promotionIds = [];
    } else {
      row = products.find(p => String(p.local_id) === String(line.id));
      if (!row || row.active === false) throw new Error('Unknown or inactive product in cart: ' + line.id);
      unitPrice = row.sale_price != null ? Number(row.sale_price) : Number(row.price);
      name = row.name;
      kind = 'product';
      hasPhysical = true;
      promotionIds = [row.local_id]; // used below to test promo.productIds membership
    }

    subtotal += unitPrice * qty;
    lineItems.push({
      kind, id: line.id, name,
      size: line.size || null, color: line.color || null,
      qty, price: unitPrice, localId: row.local_id
    });
  }

  const isDigitalOnly = isDigitalOnlyOverride != null ? isDigitalOnlyOverride : !hasPhysical;

  // ── Promo discount — percent_off and buy3get1, mirrors calcPromoDiscount() ──
  const today = new Date().toISOString().split('T')[0];
  let discount = 0;
  const discountLines = [];

  (promotions || []).forEach(promoRow => {
    const promo = promoRow.data || {};
    if (!promoRow.active || promo.discountType === 'sale') return;
    if (promo.startDate && promo.startDate > today) return;
    if (promo.endDate && promo.endDate < today) return;
    const targetIds = (promo.productIds || []).map(String);
    if (!targetIds.length) return;

    const enrolled = lineItems.filter(x => x.kind === 'product' && targetIds.indexOf(String(x.localId)) !== -1);
    if (!enrolled.length) return;

    if (promo.discountType === 'percent_off' && promo.discountValue > 0) {
      const disc = enrolled.reduce((s, x) => s + x.price * x.qty * promo.discountValue / 100, 0);
      if (disc > 0) {
        discount += disc;
        discountLines.push({ label: promo.badgeLabel || promo.text || 'Promotion', detail: promo.discountValue + '% off', amount: disc });
      }
    } else if (promo.discountType === 'buy3get1') {
      const units = [];
      enrolled.forEach(x => { for (let q = 0; q < x.qty; q++) units.push(x.price); });
      if (units.length >= 3) {
        units.sort((a, b) => a - b);
        const freeCount = Math.floor(units.length / 3);
        const disc = units.slice(0, freeCount).reduce((s, v) => s + v, 0);
        if (disc > 0) {
          discount += disc;
          discountLines.push({ label: promo.badgeLabel || promo.text || 'Promotion', detail: freeCount + ' item' + (freeCount > 1 ? 's' : '') + ' free', amount: disc });
        }
      }
    }
  });

  // ── Shipping — flat fee only (locker/door live-rate picker is Task 4, not built yet) ──
  const shipping = isDigitalOnly ? 0 : (deliveryType === 'pickup' ? 0 : Number((settings || {}).shippingFee != null ? settings.shippingFee : 80));

  const total = Math.max(0, Math.round((subtotal - discount + shipping) * 100) / 100);

  return { lineItems, subtotal, discount, discountLines, shipping, total, isDigitalOnly };
}
