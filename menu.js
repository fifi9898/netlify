const { getKV, setKV } = require('./supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    const menu = await getKV('menu') || [];
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(menu) };
  }
  if (event.httpMethod === 'POST') {
    const body = JSON.parse(event.body || '[]');
    await setKV('menu', body);
    return { statusCode: 200, body: 'ok' };
  }
  return { statusCode: 405, body: 'Method not allowed' };
};
