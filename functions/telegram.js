// functions/telegram.js (DEBUG)
const JSON_HEADERS = { 'content-type': 'application/json' };

async function sendMsg(token, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const t = await r.text().catch(()=> '');
  console.log('sendMessage ->', r.status, t.slice(0,200));
  return r.ok;
}

exports.handler = async (event) => {
  try {
    const m = event.httpMethod;
    if (m === 'HEAD') return { statusCode: 200, headers: JSON_HEADERS };
    if (m === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };
    if (m !== 'POST') return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

    const TOKEN = process.env.BOT_TOKEN;
    if (!TOKEN) return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Missing BOT_TOKEN' }) };

    let update;
    try { update = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Bad JSON' }) }; }

    const msg = update?.message;
    const chatId = msg?.chat?.id;
    const txt = (msg?.text || '').trim();

    console.log('incoming:', { chatId, txt });

    if (!chatId) return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };

    // Réponds systématiquement pour le debug
    const ok = await sendMsg(TOKEN, chatId, `👋 Bot en ligne.\nchat_id=${chatId}\nmessage="${txt || '(vide)'}"`);
    if (!ok) {
      // En cas d’échec d’envoi (403/401…), on renvoie quand même 200 pour que Telegram ne spam pas
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: false, note: 'sendMessage failed (voir logs)' }) };
    }
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.log('ERR', err);
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Internal error', details: String(err?.message || err) }) };
  }
};
