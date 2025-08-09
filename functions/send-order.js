// functions/send-order.js
const JSON_HEADERS = { 'content-type': 'application/json' };

exports.handler = async (event) => {
  try {
    const m = event.httpMethod;

    if (m === 'HEAD') return { statusCode: 200, headers: JSON_HEADERS };
    if (m === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };

    if (m !== 'POST') {
      return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let payload;
    try { payload = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Bad JSON' }) }; }

    const text = payload?.text || '';
    const { BOT_TOKEN, ADMIN_CHAT_ID } = process.env;
    if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
      return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Missing env (BOT_TOKEN/ADMIN_CHAT_ID)' }) };
    }

    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text })
    });

    if (!r.ok) {
      const t = await r.text().catch(()=> '');
      return { statusCode: 502, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Telegram failed', details: t }) };
    }

    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Internal error', details: String(err?.message || err) }) };
  }
};




