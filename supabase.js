const { SUPABASE_URL, SUPABASE_SERVICE_ROLE } = process.env;

const base = `${SUPABASE_URL}/rest/v1/kv`;
const headers = {
  'apikey': SUPABASE_SERVICE_ROLE,
  'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
  'Content-Type': 'application/json'
};

async function getKV(key) {
  const url = `${base}?key=eq.${encodeURIComponent(key)}&select=value`;
  const r = await fetch(url, { headers });
  const arr = await r.json();
  return arr[0]?.value ?? null;
}

async function setKV(key, value) {
  const r = await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify([{ key, value }])
  });
  if (r.status === 409) {
    // update
    const url = `${base}?key=eq.${encodeURIComponent(key)}`;
    await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ value }) });
  }
}

module.exports = { getKV, setKV };
