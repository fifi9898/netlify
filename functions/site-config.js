// netlify/functions/config.js
const JSON_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

// Si tu as déjà ce helper (utilisé par telegram.js)
let getKV = async () => null;
try {
  ({ getKV } = require('./supabase'));
} catch {}

exports.handler = async (event) => {
  try {
    const m = event.httpMethod;
    if (m === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };
    if (m !== 'GET') return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

    // Valeurs par défaut (fallback ENV si tu préfères)
    const defaults = {
      access_code: process.env.ACCESS_CODE || '1234',
      welcome: process.env.WELCOME || '',
      info: process.env.INFO || '',
      loyalty: {
        threshold: Number(process.env.LOYALTY_THRESHOLD) || 5,
        reward: process.env.LOYALTY_REWARD || '🎁 Cadeau',
      },
    };

    // Si tu utilises Supabase KV: on lit la clé 'site_config'
    let kvConf = {};
    if (typeof getKV === 'function') {
      kvConf = (await getKV('site_config')) || {};
    }

    // Merge propre (loyalty imbriqué)
    const finalConf = {
      ...defaults,
      ...kvConf,
      loyalty: { ...defaults.loyalty, ...(kvConf?.loyalty || {}) },
    };

    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(finalConf) };
  } catch (err) {
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Internal error', details: String(err?.message || err) }) };
  }
};

