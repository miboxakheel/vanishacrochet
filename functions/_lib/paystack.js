// Paystack REST calls — all server-side, using the SECRET key (never client-side).
const PAYSTACK_BASE = 'https://api.paystack.co';

export async function paystackInitialize(env, { email, amountCents, reference, callbackUrl, currencyCode }) {
  const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email,
      amount: amountCents,           // Paystack wants the smallest currency unit (cents for ZAR)
      currency: currencyCode || 'ZAR',
      reference,
      callback_url: callbackUrl
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.status) {
    throw new Error('Paystack initialize failed: ' + (data.message || res.status));
  }
  return data.data; // { authorization_url, access_code, reference }
}

export async function paystackVerify(env, reference) {
  const res = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.status) {
    throw new Error('Paystack verify failed: ' + (data.message || res.status));
  }
  return data.data; // { status: 'success'|'failed'|..., amount, currency, reference, customer }
}

// Paystack signs webhook deliveries with HMAC-SHA512 of the raw request body,
// keyed with the secret key. Must be checked against the RAW body text —
// never the re-serialized/parsed JSON, or the bytes won't match.
export async function verifyPaystackSignature(rawBody, signatureHeader, secretKey) {
  if (!signatureHeader) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secretKey), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const computedHex = [...new Uint8Array(sigBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqualHex(computedHex, signatureHeader);
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
