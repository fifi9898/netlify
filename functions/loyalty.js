// netlify/functions/loyalty.js
const JSON_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

// On réutilise ton util KV (même que dans telegram.js)
const { getKV, setKV } = require('./supabase');

exports.handler = async (event) => {
  try {
    const m = event.httpMethod;
    if (m === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };

    if (m === 'GET') {
      const user = String((event.queryStringParameters?.user || '')).trim().toLowerCase();
      if (!user) return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'missing user' }) };

      const key = `loyalty:${user}`;
      const count = (await getKV(key)) || 0;

      const conf = (await getKV('site_config')) || {};
      const threshold =
        (conf.loyalty && Number(conf.loyalty.threshold)) ||
        (process.env.LOYALTY_THRESHOLD ? Number(process.env.LOYALTY_THRESHOLD) : 5);

      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ user, count, threshold, eligible: count >= threshold }) };
    }

    if (m === 'POST') {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch {}
      const user = String(body.user || '').trim().toLowerCase();
      const inc = Number(body.inc || 1);
      if (!user) return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'missing user' }) };

      const key = `loyalty:${user}`;
      let count = (await getKV(key)) || 0;
      count += inc;
      await setKV(key, count);

      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true, user, count }) };
    }

    return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Internal error', details: String(err?.message || err) }) };
  }
};
