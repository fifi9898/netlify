exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const { text } = JSON.parse(event.body || '{}');
  const { BOT_TOKEN, ADMIN_CHAT_ID } = process.env;
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return { statusCode: 500, body: 'Missing env' };

  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text })
  });
  return { statusCode: r.ok ? 200 : 500, body: r.ok ? 'ok' : 'fail' };
};

