// Minimal Supabase REST helper for Cloudflare Pages Functions.
// Uses the SERVICE ROLE KEY (server-side only, never client-side) so these
// calls bypass Row Level Security — that's the whole point: the client's
// anon key can't write an authoritative "paid" order, this can.

function baseHeaders(env, prefer) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const h = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  };
  if (prefer) h.Prefer = prefer;
  return h;
}

async function checkRes(res, label) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} failed: ${res.status} ${body}`);
  }
  return res;
}

// query is a raw PostgREST query string, e.g. "select=*&order_number=eq.VC-123"
export async function sbSelect(env, table, query) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, { headers: baseHeaders(env) });
  await checkRes(res, `select ${table}`);
  return res.json();
}

export async function sbInsert(env, table, rows, prefer) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: baseHeaders(env, prefer || 'return=representation'),
    body: JSON.stringify(rows)
  });
  await checkRes(res, `insert ${table}`);
  return res.json();
}

export async function sbUpdate(env, table, query, patch, prefer) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: baseHeaders(env, prefer || 'return=representation'),
    body: JSON.stringify(patch)
  });
  await checkRes(res, `update ${table}`);
  return res.json();
}

export async function sbUpsert(env, table, rows, onConflict) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: baseHeaders(env, 'resolution=merge-duplicates,return=representation'),
    body: JSON.stringify(rows)
  });
  await checkRes(res, `upsert ${table}`);
  return res.json();
}

// Resolve the logged-in customer (if any) from the Supabase access token the
// browser sends us — we NEVER trust a client-supplied user id directly.
export async function sbGetUserFromToken(env, accessToken) {
  if (!accessToken) return null;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`
      }
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch (e) {
    console.warn('[auth] token resolution failed:', e && e.message);
    return null;
  }
}
