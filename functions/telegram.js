// functions/telegram.js
// Bot admin avec wizard + boutons + upload auto Catbox pour photo/vidéo
// ➜ À utiliser avec Netlify Functions (webhook), pas de polling.
// ➜ Nécessite les variables d'env: BOT_TOKEN, ADMIN_CHAT_ID (ou ADMIN_IDS)

const { getKV, setKV } = require('./supabase');

const JSON_HEADERS = { 'content-type': 'application/json' };

// Admins: ADMIN_IDS (liste virgules) sinon fallback ADMIN_CHAT_ID
const ADMIN_IDS = (process.env.ADMIN_IDS || process.env.ADMIN_CHAT_ID || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);
const isAdmin = id => ADMIN_IDS.includes(String(id));

// ---- Utils Telegram HTTP ----
async function tgCall(method, body, TOKEN) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const text = await r.text().catch(()=> '');
  let json = null; try { json = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, text, json };
}
async function sendMsg(TOKEN, chatId, text, extra = {}) {
  return tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra }, TOKEN);
}
async function answerCb(TOKEN, cbId, text = '') {
  return tgCall('answerCallbackQuery', { callback_query_id: cbId, text, show_alert: false }, TOKEN);
}
async function getFilePath(TOKEN, file_id) {
  const r = await tgCall('getFile', { file_id }, TOKEN);
  if (!r.json?.ok) throw new Error('getFile failed: ' + (r.text || r.status));
  return r.json.result.file_path;
}

// ---- Upload Catbox (sans fs, compatible serverless) ----
// Basé sur ton flux Render : download Telegram -> Catbox (tu l’as dans index.js). :contentReference[oaicite:1]{index=1}
async function downloadAsBlob(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const ab = await r.arrayBuffer();
  const ct = r.headers.get('content-type') || 'application/octet-stream';
  return new Blob([ab], { type: ct });
}
async function uploadToCatbox(blob, filename) {
  const fd = new FormData();
  fd.append('reqtype', 'fileupload');
  // Important: donner un filename pour Catbox
  fd.append('fileToUpload', blob, filename);
  const r = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
  const text = await r.text().catch(()=> '');
  if (!r.ok) throw new Error(`catbox ${r.status}: ${text}`);
  const url = (text || '').trim();
  if (!/^https?:\/\//.test(url)) throw new Error(`catbox bad response: ${url}`);
  return url;
}

// ---- UI: reply keyboard + inline ----
function mainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ['➕ Ajouter', '📝 Modifier', '🗑️ Supprimer'],
        ['🔑 Code d\'accès', '🏠 Message bienvenue', 'ℹ️ Info & consignes']
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}
function inlineEditRow(idx)  { return { reply_markup: { inline_keyboard: [[{ text:'✏️ Modifier',  callback_data:`edit_${idx}` }]] } }; }
function inlineDeleteRow(idx){ return { reply_markup: { inline_keyboard: [[{ text:'🗑️ Supprimer', callback_data:`delete_${idx}` }]] } }; }
function inlineConfirmDelete(idx) {
  return { reply_markup: { inline_keyboard: [[
    { text:'❌ Annuler',  callback_data:'cancel_del' },
    { text:'✅ Confirmer', callback_data:`confirmdel_${idx}` }
  ]] } };
}
async function showMainMenu(TOKEN, chatId) { await sendMsg(TOKEN, chatId, 'Que veux-tu faire ?', mainKeyboard()); }

// ---- Wizard produit ----
const productSteps = [
  { key: 'name',   ask: v => `Envoie le *NOM* du produit${v?` (ou /skip pour garder "${v}")`:""}` },
  { key: 'cat',    ask: v => `Catégorie ?${v?` (ou /skip pour garder "${v}")`:""}` },
  { key: 'desc',   ask: v => `Description ?${v?` (ou /skip pour garder "${v}")`:""}` },
  { key: 'thclvl', ask: v => `Taux THC (%) ?${v?` (ou /skip pour garder "${v}")`:""}` },
  { key: 'prices', ask: v => `Prix (format 1g:10,2g:18)\n${Array.isArray(v)&&v.length?`Actuel: ${v.map(x=>x.qte+':'+x.price).join(', ')}`:""}\nEnvoie ou /skip pour garder.` },
  { key: 'img',    ask: v => `*Image produit* — envoie une *photo Telegram* ou *un lien http* (ou /skip pour garder "${v||'(aucune)'}")` },
  { key: 'video',  ask: v => `*Vidéo produit* — envoie une *vidéo Telegram* ou *un lien http* (ou /skip pour garder "${v||'(aucune)'}")` },
];

// ---- Handler principal ----
exports.handler = async (event) => {
  try {
    const m = event.httpMethod;
    if (m === 'HEAD')    return { statusCode: 200, headers: JSON_HEADERS };
    if (m === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };
    if (m !== 'POST')    return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error:'Method not allowed' }) };

    const TOKEN = process.env.BOT_TOKEN;
    if (!TOKEN) return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error:'Missing BOT_TOKEN' }) };

    let update; try { update = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error:'Bad JSON' }) }; }

    // ---- Inline boutons (callback_query) ----
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id;
      const data = cb.data || '';
      await answerCb(TOKEN, cb.id);

      if (!isAdmin(chatId)) {
        await sendMsg(TOKEN, chatId, '⛔ Accès admin requis.');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
      }

      let menu = (await getKV('menu')) || [];

      if (data.startsWith('delete_')) {
        const idx = parseInt(data.split('_')[1], 10);
        if (!menu[idx]) { await sendMsg(TOKEN, chatId, 'Produit introuvable.'); }
        else { await sendMsg(TOKEN, chatId, `⚠️ Supprimer "*${menu[idx].name}*"?`, inlineConfirmDelete(idx)); }
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
      }

      if (data === 'cancel_del') {
        await sendMsg(TOKEN, chatId, 'Suppression annulée.');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
      }

      if (data.startsWith('confirmdel_')) {
        const idx = parseInt(data.split('_')[1], 10);
        if (!menu[idx]) { await sendMsg(TOKEN, chatId, 'Produit introuvable.'); }
        else {
          const name = menu[idx].name || '(sans nom)';
          menu.splice(idx, 1);
          await setKV('menu', menu);
          await sendMsg(TOKEN, chatId, `✅ Produit "*${name}*" supprimé !`);
        }
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
      }

      if (data.startsWith('edit_')) {
        const idx = parseInt(data.split('_')[1], 10);
        if (!menu[idx]) { await sendMsg(TOKEN, chatId, 'Produit introuvable.'); }
        else {
          const stateKey = `state:${chatId}`;
          await setKV(stateKey, { mode:'add', submode:'edit', idx, step:0, prod: { ...menu[idx] } });
          const first = productSteps[0]; await sendMsg(TOKEN, chatId, `Modification "*${menu[idx].name}*"\n${first.ask(menu[idx].name)}`);
        }
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
      }

      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
    }

    // ---- Messages
    const msg = update.message;
    const chatId = msg?.chat?.id;
    const txt = (msg?.text || '').trim();

    if (!chatId) return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };

    // Publique utile
    if (txt === '/whoami') {
      await sendMsg(TOKEN, chatId, `Votre chat_id: \`${chatId}\``, mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
    }

    // Admin gate
    if (!isAdmin(chatId)) {
      await sendMsg(TOKEN, chatId, '⛔ Accès admin requis.');
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
    }

    const stateKey = `state:${chatId}`;
    let state = (await getKV(stateKey)) || { mode:null, step:0, prod:null };
    let menu = (await getKV('menu')) || [];
    let conf = (await getKV('site_config')) || { access_code:'1234', welcome:'', info:'' };

    // Entrée menu
    if (txt === '/start' || txt === '/help') {
      await showMainMenu(TOKEN, chatId);
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
    }

    // Boutons principaux
    if (txt === '➕ Ajouter') {
      state = { mode:'add', submode:'create', step:0, prod:{ prices:[] } };
      await setKV(stateKey, state);
      const s = productSteps[0]; await sendMsg(TOKEN, chatId, s.ask(''), mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
    }
    if (txt === '📝 Modifier') {
      if (!menu.length) { await sendMsg(TOKEN, chatId, 'Aucun produit à modifier.', mainKeyboard()); }
      else {
        for (let i=0;i<menu.length;i++) {
          const p = menu[i];
          await sendMsg(TOKEN, chatId, `#${i+1} - ${p.name || '(sans nom)'} ${p.cat?`(${p.cat})`:''}`, inlineEditRow(i));
        }
      }
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
    }
    if (txt === '🗑️ Supprimer') {
      if (!menu.length) { await sendMsg(TOKEN, chatId, 'Aucun produit à supprimer.', mainKeyboard()); }
      else {
        for (let i=0;i<menu.length;i++) {
          const p = menu[i];
          await sendMsg(TOKEN, chatId, `#${i+1} - ${p.name || '(sans nom)'} ${p.cat?`(${p.cat})`:''}`, inlineDeleteRow(i));
        }
      }
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
    }

    if (txt === '🔑 Code d\'accès') {
      state = { mode:'config_set', key:'access_code' };
      await setKV(stateKey, state);
      await sendMsg(TOKEN, chatId, `Code actuel : ${conf.access_code}\nEnvoie le *nouveau code* (2–16 alphanum).`, mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
    }
    if (txt === '🏠 Message bienvenue') {
      state = { mode:'config_set', key:'welcome' };
      await setKV(stateKey, state);
      await sendMsg(TOKEN, chatId, `Message actuel :\n${conf.welcome || '(vide)'}\n\nEnvoie le *nouveau message*.`, mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
    }
    if (txt === 'ℹ️ Info & consignes') {
      state = { mode:'config_set', key:'info' };
      await setKV(stateKey, state);
      await sendMsg(TOKEN, chatId, `Texte actuel :\n${conf.info || '(vide)'}\n\nEnvoie les *nouvelles infos*.`, mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
    }

    if (txt === '/cancel' || txt === '/annuler') {
      state = { mode:null, step:0, prod:null };
      await setKV(stateKey, state);
      await sendMsg(TOKEN, chatId, 'Annulé.', mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
    }

    // --- Mode config_set (depuis boutons)
    if (state.mode === 'config_set' && state.key) {
      const key = state.key;
      if (key === 'access_code' && !/^\w{2,16}$/.test(txt)) {
        await sendMsg(TOKEN, chatId, 'Le code doit faire 2–16 caractères alphanumériques. Réessaie ou /annuler.');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
      }
      conf[key] = txt;
      await setKV('site_config', conf);
      await setKV(stateKey, { mode:null, step:0, prod:null });
      await sendMsg(TOKEN, chatId, `✅ ${key} mis à jour !`, mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
    }

    // --- Wizard produit (avec upload Catbox auto)
    if (state.mode === 'add') {
      const step = state.step || 0;
      const prod = state.prod || {};
      const current = productSteps[step];

      // Fin (plus d'étape)
      if (!current) {
        if (state.submode === 'create') menu.push(prod);
        if (state.submode === 'edit')   menu[state.idx] = prod;
        await setKV('menu', menu);
        await setKV(stateKey, { mode:null, step:0, prod:null });
        await sendMsg(TOKEN, chatId, state.submode === 'create' ? '✅ Produit ajouté !' : `✅ Produit "${prod.name}" modifié !`, mainKeyboard());
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
      }

      // 1) /skip
      if (txt === '/skip') {
        const nextStep = step + 1;
        await setKV(stateKey, { ...state, step: nextStep, prod });
        const next = productSteps[nextStep];
        if (next) {
          const q = typeof next.ask === 'function' ? next.ask(prod[next.key]) : next.ask;
          await sendMsg(TOKEN, chatId, q);
        } else {
          await sendMsg(TOKEN, chatId, 'Tape /done pour enregistrer, ou /annuler pour annuler.');
        }
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
      }

      // 2) Étapes "simples"
      if (current.key === 'prices' && txt) {
        prod.prices = txt.split(',').map(s => {
          const [qte, price] = s.split(':');
          return { qte: (qte||'').trim(), price: Number((price||'').trim()) };
        }).filter(x => x.qte && !isNaN(x.price));
      } else if (current.key === 'thclvl' && txt) {
        const num = Number(txt); if (!isNaN(num)) prod.thclvl = num;
      }

      // 3) Étape IMAGE (upload auto si photo)
      if (current.key === 'img') {
        try {
          if (msg.photo && msg.photo.length) {
            const best = msg.photo[msg.photo.length - 1];
            const filePath = await getFilePath(TOKEN, best.file_id);
            const fileUrl  = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
            const blob     = await downloadAsBlob(fileUrl);
            const url      = await uploadToCatbox(blob, `photo_${Date.now()}.jpg`);
            prod.img = url;
          } else if (msg.document && /^image\//i.test(msg.document.mime_type||'')) {
            const filePath = await getFilePath(TOKEN, msg.document.file_id);
            const fileUrl  = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
            const blob     = await downloadAsBlob(fileUrl);
            const filename = msg.document.file_name || `image_${Date.now()}`;
            const url      = await uploadToCatbox(blob, filename);
            prod.img = url;
          } else if (txt && /^https?:\/\//i.test(txt)) {
            // lien direct fourni
            prod.img = txt.trim();
          }
        } catch (err) {
          await sendMsg(TOKEN, chatId, `❌ Upload image échoué : ${String(err.message||err)}`);
          // on reste sur la même étape
          return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
        }
      }

      // 4) Étape VIDEO (upload auto si vidéo)
      if (current.key === 'video') {
        try {
          if (msg.video) {
            const filePath = await getFilePath(TOKEN, msg.video.file_id);
            const fileUrl  = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
            const blob     = await downloadAsBlob(fileUrl);
            const filename = msg.video.file_name || `video_${Date.now()}.mp4`;
            const url      = await uploadToCatbox(blob, filename);
            prod.video = url;
          } else if (msg.document && /^video\//i.test(msg.document.mime_type||'')) {
            const filePath = await getFilePath(TOKEN, msg.document.file_id);
            const fileUrl  = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
            const blob     = await downloadAsBlob(fileUrl);
            const filename = msg.document.file_name || `video_${Date.now()}.mp4`;
            const url      = await uploadToCatbox(blob, filename);
            prod.video = url;
          } else if (txt && /^https?:\/\//i.test(txt)) {
            // lien direct fourni
            prod.video = txt.trim();
          }
        } catch (err) {
          await sendMsg(TOKEN, chatId, `❌ Upload vidéo échoué : ${String(err.message||err)}`);
          // on reste sur la même étape
          return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
        }
      }

      // 5) Étapes texte génériques (si pas déjà gérées)
      if (!['img','video','prices','thclvl'].includes(current.key) && txt) {
        prod[current.key] = txt;
      }

      // Étape suivante
      const nextStep = step + 1;
      await setKV(stateKey, { ...state, step: nextStep, prod });
      const next = productSteps[nextStep];
      if (next) {
        const q = typeof next.ask === 'function' ? next.ask(prod[next.key]) : next.ask;
        await sendMsg(TOKEN, chatId, q);
      } else {
        await sendMsg(TOKEN, chatId, 'Tape /done pour enregistrer, ou /annuler pour annuler.');
      }
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
    }

    // Finir l’assistant
    if (txt === '/done') {
      if (state.mode !== 'add' || !state.prod) {
        await sendMsg(TOKEN, chatId, 'Rien à enregistrer. Tape "➕ Ajouter" pour commencer.', mainKeyboard());
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
      }
      const prod = state.prod;
      if (!prod.name) {
        await sendMsg(TOKEN, chatId, 'Nom manquant. /annuler pour quitter.');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
      }
      if (state.submode === 'create') menu.push(prod);
      if (state.submode === 'edit')   menu[state.idx] = prod;
      await setKV('menu', menu);
      await setKV(stateKey, { mode:null, step:0, prod:null });
      await sendMsg(TOKEN, chatId, state.submode === 'create' ? '✅ Produit ajouté !' : `✅ Produit "${prod.name}" modifié !`, mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };
    }

    // Fallback: réafficher le menu
    await showMainMenu(TOKEN, chatId);
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:true }) };

  } catch (err) {
    // On renvoie 200 pour éviter que Telegram relance en boucle,
    // mais on logue l'erreur dans la réponse JSON
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok:false, error:String(err?.message||err) }) };
  }
};
