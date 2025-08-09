const { getKV, setKV } = require('./supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    const conf = await getKV('site_config') || { access_code:'1234', welcome:'', info:'' };
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(conf) };
  }
  if (event.httpMethod === 'POST') {
    const conf = JSON.parse(event.body || '{}');
    await setKV('site_config', conf);
    return { statusCode: 200, body: 'ok' };
  }
  return { statusCode: 405, body: 'Method not allowed' };
};
