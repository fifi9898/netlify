// netlify/functions/get-menu.js
const { createClient } = require('@supabase/supabase-js');

exports.handler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const { data, error } = await supabase
    .from('menu')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  return { statusCode: 200, headers: { 'Content-Type':'application/json' }, body: JSON.stringify(data || []) };
};
