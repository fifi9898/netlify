// functions/site-config.js
const { getKV, setKV } = require('./supabase');

const JSON_HEADERS = { 'content-type': 'application/json' };
const DEFAULT_CONF = { access_code: '1234', welcome: '', info: '' };

exports.handler = async (event) => {
  try {
    const m = event.httpMethod;

    if (m === 'HEAD') return { statusCode: 200, headers: JSON_HEADERS };
    if (m === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };

    if (m === 'GET') {
      const conf = await getKV('site_config');
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(conf ?? DEFAULT_CONF) };
    }

    if (m === 'POST') {
      let conf;
      try { conf = JSON.parse(event.body || '{}'); }
      catch { return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Bad JSON' }) }; }
      await setKV('site_config', conf);
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Internal error', details: String(err?.message || err) }) };
  }
};
