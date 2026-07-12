// ── PUDO Bob Box size tiers — SINGLE SOURCE OF TRUTH ──────────────────────
// This is the ONE place to edit when moving to a production Bob Go / PUDO
// account, or when you want to use more/different Bob Box sizes.
//
// Each product size tier maps to a Bob Box. We don't send Bob Go a "box name" —
// we send a PARCEL (length/width/height/weight) and Bob Go returns every box
// the parcel fits into, cheapest first. So the parcel dimensions below are
// chosen to land squarely in the intended box tier (its height sits above the
// next-smaller box's max and at/under its own), which makes the cheapest
// pickup-point rate Bob Go returns equal to that box's real price.
//
// Real values discovered from the LIVE Bob Go sandbox API (provider 'demo',
// 2026-07-12) via locker-to-locker rate requests. The service_level object
// reports each box's own limits (parcel_size_max_*):
//   Bob Box Small  (BOXL-S)  max 56×32×12 cm,  6 kg  → rate R44.61
//   Bob Box Medium (BOXL-M)  max 56×32×26 cm, 12 kg  → rate R49.57
//   Bob Box Large  (BOXL-L)  max 56×32×53 cm, 22 kg  → rate R54.52
// (This sandbox account only offers these 3 tiers — no XS/XL. A production
// account may expose more; if so, add them here and to the admin selector.)
//
// TO RE-MAP FOR PRODUCTION: change the box/dims below. To add a tier, add an
// entry here, append its key to TIER_ORDER (smallest→largest), and add the
// matching <option> in admin-dashboard.html's product editor. Nothing else
// needs to change — pricing.js, bobgo.js and the checkout all read this table.
export const SIZE_TIERS = {
  standard: {
    label: 'Standard',
    boxName: 'Small',            // the Bob Box we expect Bob Go to quote
    parcel: { length_cm: 30, width_cm: 22, height_cm: 10, weight_kg: 2 },
    lockerable: true,            // false = this tier is too big for any locker → door-only
    approxLockerRate: 44.61      // indicative only — used by MOCK_DELIVERY, never in real mode
  },
  medium: {
    label: 'Medium',
    boxName: 'Medium',
    parcel: { length_cm: 30, width_cm: 22, height_cm: 24, weight_kg: 3 },
    lockerable: true,
    approxLockerRate: 49.57
  },
  large: {
    label: 'Large',
    boxName: 'Large',
    parcel: { length_cm: 45, width_cm: 30, height_cm: 50, weight_kg: 5 },
    lockerable: true,
    approxLockerRate: 54.52
  }
};

// Smallest → largest. Used to pick the largest tier in a mixed cart and to
// validate/normalise a stored size_tier value.
export const TIER_ORDER = ['standard', 'medium', 'large'];

export const DEFAULT_TIER = 'standard';

// Coerce any stored/legacy value to a known tier (defensive — a bad DB value
// must never break checkout).
export function normalizeTier(tier) {
  return TIER_ORDER.indexOf(tier) !== -1 ? tier : DEFAULT_TIER;
}

// The largest tier among a set of tier keys (for "everything ships in one box,
// sized to the biggest item"). Empty/uknown → DEFAULT_TIER.
export function largestTier(tiers) {
  let bestIdx = -1;
  (tiers || []).forEach(t => {
    const i = TIER_ORDER.indexOf(normalizeTier(t));
    if (i > bestIdx) bestIdx = i;
  });
  return bestIdx === -1 ? DEFAULT_TIER : TIER_ORDER[bestIdx];
}

// Parcel array (Bob Go's `parcels` shape) for a given tier.
export function parcelForTier(tier) {
  const t = SIZE_TIERS[normalizeTier(tier)];
  return [{
    submitted_length_cm: t.parcel.length_cm,
    submitted_width_cm: t.parcel.width_cm,
    submitted_height_cm: t.parcel.height_cm,
    submitted_weight_kg: t.parcel.weight_kg
  }];
}
