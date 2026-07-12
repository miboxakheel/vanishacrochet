// Authoritative, server-side order total computation — mirrors the site's
// client-side renderCheckout()/calcPromoDiscount()/getShipping() math, but
// reads prices/promotions fresh from Supabase so a tampered client total can
// never be trusted (per spec Task 3: "compute/verify total from source data").
import { largestTier, normalizeTier, DEFAULT_TIER } from './sizes.js';
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

// NOTE on shipping: this function only computes cart/promo math (subtotal,
// discount, whether the order is digital-only, whether it contains an
// oversize item). Shipping is resolved separately in init.js via bobgo.js —
// getting a Bob Go rate is an async network call, so it doesn't belong in
// this otherwise-synchronous pure computation. See computeShipping() below
// for the (synchronous, flat-fee) fallback path only.
export function computeOrderTotals({ cartLines, products, patterns, promotions, settings, isDigitalOnlyOverride }) {
  const lineItems = [];
  let subtotal = 0;
  let hasPhysical = false;
  // Collect the PUDO size tier of every physical line; the parcel is sized to
  // the largest (everything ships in one box). See functions/_lib/sizes.js.
  const physicalTiers = [];

  for (const line of cartLines) {
    const qty = Math.max(1, parseInt(line.qty, 10) || 1);
    let row, unitPrice, name, kind;

    if (line.kind === 'pattern') {
      row = patterns.find(p => String(p.local_id) === String(line.id));
      if (!row || row.active === false) throw new Error('Unknown or inactive pattern in cart: ' + line.id);
      const data = row.data || {};
      unitPrice = Number(row.price) || 0;
      name = data.name || 'Pattern';
      kind = 'pattern';
    } else if (line.kind === 'kit') {
      // A kit is a physical add-on tied to a pattern (index.html's
      // addKitToCart), not a row in `products` — its price/availability live
      // in the parent pattern's data.kit, keyed by line.patternId.
      row = patterns.find(p => String(p.local_id) === String(line.patternId));
      if (!row || row.active === false) throw new Error('Unknown or inactive pattern for kit in cart: ' + line.patternId);
      const data = row.data || {};
      const kit = data.kit || {};
      if (!kit.enabled) throw new Error('Kit is not available for this pattern: ' + line.patternId);
      unitPrice = Number(kit.price) || 0;
      name = (data.name || 'Pattern') + ' — Kit';
      kind = 'kit';
      hasPhysical = true;
      // Kits (yarn + materials) aren't rows in `products`, so they have no
      // size_tier of their own — default them to the standard box.
      physicalTiers.push(DEFAULT_TIER);
    } else {
      row = products.find(p => String(p.local_id) === String(line.id));
      if (!row || row.active === false) throw new Error('Unknown or inactive product in cart: ' + line.id);
      unitPrice = row.sale_price != null ? Number(row.sale_price) : Number(row.price);
      name = row.name;
      kind = 'product';
      hasPhysical = true;
      physicalTiers.push(normalizeTier(row.size_tier));
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

  // The whole order ships in one box, sized to the largest item present.
  const cartSizeTier = largestTier(physicalTiers);

  return { lineItems, subtotal, discount, discountLines, isDigitalOnly, cartSizeTier };
}

// Combines cart totals with a resolved shipping fee (from resolveShipping()
// in init.js — a live Bob Go rate for locker/door, 0 for pickup/digital, or
// the flat settings.shippingFee fallback) into the final signed total.
export function applyShipping(cartTotals, shipping) {
  const total = Math.max(0, Math.round((cartTotals.subtotal - cartTotals.discount + shipping) * 100) / 100);
  return Object.assign({}, cartTotals, { shipping, total });
}

// Synchronous flat-fee fallback — used only when a live Bob Go rate couldn't
// be resolved (network/API failure), or for the 'pickup' case. NOT used for
// the normal locker/door path, which goes through bobgo.js's fetchRate().
export function flatFallbackShipping(settings) {
  return Number((settings || {}).shippingFee != null ? settings.shippingFee : 80);
}
