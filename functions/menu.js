// functions/menu.js
const { getKV, setKV } = require('./supabase');

const JSON_HEADERS = { 'content-type': 'application/json' };

exports.handler = async (event) => {
  try {
    const m = event.httpMethod;

    if (m === 'HEAD')    return { statusCode: 200, headers: JSON_HEADERS };
    if (m === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };

    if (m === 'GET') {
      const menu = await getKV('menu');
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(menu ?? []) };
    }

    if (m === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '[]'); }
      catch { return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Bad JSON' }) }; }
      await setKV('menu', body);
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Internal error', details: String(err?.message || err) }) };
  }
};
