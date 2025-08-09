// netlify/functions/tg-webhook.js
// npm i @supabase/supabase-js
const fetch = global.fetch;
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // pas l’ANON
    if (!TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return { statusCode: 500, body: 'Missing env vars' };
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const update = JSON.parse(event.body);
    const msg = update.message || update.edited_message;
    if (!msg) return { statusCode: 200, body: 'No message' };

    // 1) Détecter media (photo/vidéo)
    let fileId = null, mediaType = null;
    if (msg.photo && msg.photo.length) {
      fileId = msg.photo[msg.photo.length - 1].file_id;
      mediaType = 'img';
    } else if (msg.video && msg.video.file_id) {
      fileId = msg.video.file_id;
      mediaType = 'video';
    } else {
      // rien à faire si pas de media
      return ok();
    }

    // 2) Récupérer file_path Telegram
    const gf = await fetch(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`).then(r=>r.json());
    const filePath = gf?.result?.file_path;
    if (!filePath) return ok();

    const tgFileUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

    // 3) Upload vers Catbox par URL (pas besoin de re-téléverser)
    const form = new URLSearchParams();
    form.append('reqtype', 'urlupload');
    form.append('url', tgFileUrl);
    const cat = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    }).then(r=>r.text());
    if (!cat.startsWith('https://')) {
      await reply(msg.chat.id, TOKEN, `Erreur Catbox: ${cat}`);
      return ok();
    }
    const mediaUrl = cat.trim();

    // 4) Parser la légende pour remplir le produit (simple key=value; séparées par ";")
    // Ex: name=Fleur XYZ; cat=Fleurs; desc=Top qualité; promo=2g offerts; thclvl=18; effet=Relax;
    //     prices=[{"qte":"1g","price":10},{"qte":"3.5g","price":30}]
    const prod = fromCaption(msg.caption || '');
    prod[mediaType] = mediaUrl;

    // 5) Insérer dans la table 'menu' de Supabase
    const { error } = await supabase.from('menu').insert([prod]);
    if (error) {
      await reply(msg.chat.id, TOKEN, `Lien: ${mediaUrl}\n❗️Erreur insert: ${error.message}`);
      return ok();
    }

    await reply(msg.chat.id, TOKEN, `✅ Ajouté au menu.\n${mediaUrl}`);
    return ok();
  } catch (e) {
    return { statusCode: 200, body: 'OK' }; // Telegram veut un 200 même en cas d’erreur
  }
};

function ok() { return { statusCode: 200, body: 'OK' }; }

async function reply(chatId, token, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

function fromCaption(c) {
  const prod = {};
  if (!c) return prod;
  // split by ;  then key=value
  c.split(';').forEach(part => {
    const [k, ...rest] = part.split('=');
    if (!k || !rest.length) return;
    const key = k.trim().toLowerCase();
    const val = rest.join('=').trim();
    if (['name','cat','desc','promo','effet'].includes(key)) prod[key] = val;
    else if (key === 'thclvl') prod.thclvl = parseFloat(val) || null;
    else if (key === 'prices') {
      try { prod.prices = JSON.parse(val); } catch {}
    }
  });
  return prod;
}
