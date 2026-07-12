// Minimal Supabase REST helper for Cloudflare Pages Functions.
// Uses the SERVICE ROLE KEY (server-side only, never client-side) so these
// calls bypass Row Level Security — that's the whole point: the client's
// anon key can't write an authoritative "paid" order, this can.

// Bare `fetch()` never times out on its own — a stalled Supabase call (REST
// or Auth) used to be able to hang checkout indefinitely, same class of bug
// already fixed for Bob Go in bobgo.js. Every call below goes through this
// so a stall fails within a bounded time instead of leaving the customer
// stuck on "Processing..." forever.
async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`Request to ${url} timed out after ${ms}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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
  const res = await fetchWithTimeout(url, { headers: baseHeaders(env) }, 10000);
  await checkRes(res, `select ${table}`);
  return res.json();
}

export async function sbInsert(env, table, rows, prefer) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: baseHeaders(env, prefer || 'return=representation'),
    body: JSON.stringify(rows)
  }, 10000);
  await checkRes(res, `insert ${table}`);
  return res.json();
}

export async function sbUpdate(env, table, query, patch, prefer) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetchWithTimeout(url, {
    method: 'PATCH',
    headers: baseHeaders(env, prefer || 'return=representation'),
    body: JSON.stringify(patch)
  }, 10000);
  await checkRes(res, `update ${table}`);
  return res.json();
}

export async function sbUpsert(env, table, rows, onConflict) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: baseHeaders(env, 'resolution=merge-duplicates,return=representation'),
    body: JSON.stringify(rows)
  }, 10000);
  await checkRes(res, `upsert ${table}`);
  return res.json();
}

// Resolve the logged-in customer (if any) from the Supabase access token the
// browser sends us — we NEVER trust a client-supplied user id directly.
export async function sbGetUserFromToken(env, accessToken) {
  if (!accessToken) return null;
  try {
    const res = await fetchWithTimeout(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`
      }
    }, 10000);
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch (e) {
    console.warn('[auth] token resolution failed:', e && e.message);
    return null;
  }
}
