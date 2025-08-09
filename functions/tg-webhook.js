// netlify/functions/tg-webhook.js
// npm i @supabase/supabase-js
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // Service Role (serveur)
  if (!TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: 'Missing env vars' };
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const update = JSON.parse(event.body || '{}');
  const msg = update.message || update.edited_message;
  if (!msg) return ok();

  // 0) Si l’utilisateur tape /new → on lui demande un média (image/vidéo)
  const text = (msg.text || '').trim();
  if (text === '/new') {
    await reply(TOKEN, msg.chat.id,
      'Envoie-moi une *photo* ou une *vidéo* avec en légende :\n' +
      'name=Nom; cat=Catégorie; desc=Description; promo=Texte; thclvl=18; effet=Relax;\n' +
      'prices=[{"qte":"1g","price":10},{"qte":"3.5g","price":30}]'
    );
    return ok();
  }

  // 1) Détecter un média
  let fileId = null, mediaType = null;
  if (msg.photo && msg.photo.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
    mediaType = 'img';
  } else if (msg.video && msg.video.file_id) {
    fileId = msg.video.file_id;
    mediaType = 'video';
  } else if (!text) {
    // message sans texte ni media
    await reply(TOKEN, msg.chat.id, 'Envoie une *photo* ou une *vidéo* (tu peux mettre les infos en légende).');
    return ok();
  } else {
    // texte seul → rappeler la consigne
    await reply(TOKEN, msg.chat.id, 'Je besoin d’une *photo* ou *vidéo*. Utilise /new pour l’aide.');
    return ok();
  }

  try {
    // 2) Récupérer le file_path Telegram
    const gf = await fetch(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`).then(r => r.json());
    const filePath = gf?.result?.file_path;
    if (!filePath) {
      await reply(TOKEN, msg.chat.id, 'Désolé, impossible de récupérer le fichier.');
      return ok();
    }
    const tgFileUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

    // 3) Upload vers Catbox (urlupload)
    const form = new URLSearchParams();
    form.append('reqtype', 'urlupload');
    form.append('url', tgFileUrl);
    const cat = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    }).then(r => r.text());
    if (!cat.startsWith('https://')) {
      await reply(TOKEN, msg.chat.id, `❗️Erreur Catbox: ${cat}`);
      return ok();
    }
    const mediaUrl = cat.trim();

    // 4) Construire l’objet produit depuis la légende
    const prod = fromCaption(msg.caption || '');
    prod[mediaType] = mediaUrl;            // img OU video
    prod.created_at = new Date().toISOString();

    // minimum requis (tu peux adapter)
    if (!prod.name) prod.name = 'Sans nom';
    if (!prod.cat)  prod.cat  = 'Divers';
    if (!Array.isArray(prod.prices)) prod.prices = [];

    // 5) Insert Supabase
    const { error } = await supabase.from('menu').insert([prod]);
    if (error) {
      await reply(TOKEN, msg.chat.id, `Lien: ${mediaUrl}\n❗️Erreur insert: ${error.message}`);
      return ok();
    }

    await reply(TOKEN, msg.chat.id, `✅ Ajouté au menu.\n${mediaUrl}`);
  } catch (e) {
    await reply(TOKEN, msg.chat.id, '❗️Erreur interne. Réessaie.');
  }
  return ok();
};

function ok() { return { statusCode: 200, body: 'OK' }; }

async function reply(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  });
}

function fromCaption(c) {
  const prod = {};
  if (!c) return prod;
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

