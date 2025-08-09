// netlify/functions/telegram.js
const { getKV, setKV } = require('./supabase');

const JSON_HEADERS = { 'content-type': 'application/json' };

// --- Admins ---
const ADMIN_IDS = (process.env.ADMIN_IDS || process.env.ADMIN_CHAT_ID || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);
const isAdmin = id => ADMIN_IDS.includes(String(id));

// ---------- Utils Telegram ----------
async function tgFetch(method, body, TOKEN) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await r.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, text, json };
}
async function sendMsg(TOKEN, chatId, text, extra = {}) {
  return tgFetch('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra }, TOKEN);
}
async function answerCb(TOKEN, cbId, text = '') {
  return tgFetch('answerCallbackQuery', { callback_query_id: cbId, text, show_alert: false }, TOKEN);
}

// ---------- Catbox helpers (réhébergement auto) ----------
async function catboxUrlUpload(url) {
  const body = new URLSearchParams();
  body.set('reqtype', 'urlupload');
  body.set('url', url);
  const r = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body });
  const out = (await r.text()).trim();
  if (!r.ok || !/^https?:\/\//.test(out)) {
    throw new Error('Catbox upload failed: ' + out.slice(0, 200));
  }
  return out;
}
async function telegramFileToCatbox(TOKEN, file_id) {
  const f = await tgFetch('getFile', { file_id }, TOKEN);
  const path = f?.json?.result?.file_path;
  if (!path) throw new Error('getFile failed');
  const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${path}`;
  return catboxUrlUpload(fileUrl);
}

// ---------- UI clavier principal ----------
function mainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["➕ Ajouter", "📝 Modifier", "🗑️ Supprimer"],
        ["🔑 Code d'accès", "🏠 Message bienvenue", "ℹ️ Info & consignes"],
        ["🎁 Fidélité", "📢 Bandeau promo"] // nouveaux
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}
async function showMainMenu(TOKEN, chatId) {
  await sendMsg(TOKEN, chatId, 'Que veux-tu faire ?', mainKeyboard());
}

// ---------- Wizard produit (texte mis à jour pour fichiers TG) ----------
const productSteps = [
  { key: 'name',   ask: v => `Envoie le *NOM* du produit${v ? ` (ou /skip pour garder "${v}")` : ''}` },
  { key: 'cat',    ask: v => `Catégorie ?${v ? ` (ou /skip pour garder "${v}")` : ''}` },
  { key: 'desc',   ask: v => `Description (courte) ?${v ? ` (ou /skip pour garder "${v}")` : ''}` },
  { key: 'effet',  ask: v => `Effet ?${v ? ` (ou /skip pour garder "${v}")` : ''}` },
  { key: 'arome',  ask: v => `Arôme ?${v ? ` (ou /skip pour garder "${v}")` : ''}` },
  { key: 'thclvl', ask: v => `Taux THC (%) ?${v ? ` (ou /skip pour garder "${v}")` : ''}` },
  { key: 'prices', ask: v => `Prix (format : 1g:10,2g:18)\n${Array.isArray(v) && v.length ? `Actuel : ${v.map(x => x.qte + ':' + x.price).join(', ')}` : ''}\nEnvoie la liste, ou /skip pour garder.` },
  { key: 'img',    ask: v => `*Image produit* — envoie une *photo Telegram* ou un *lien http*\n(ou /skip pour garder "${v || '(aucune)'}")` },
  { key: 'video',  ask: v => `*Vidéo produit* — envoie une *vidéo Telegram* ou un *lien http*\n(ou /skip pour garder "${v || '(aucune)'}")` },
];

// ---------- Inline (éditer / supprimer) ----------
function inlineEditRow(idx) {
  return { reply_markup: { inline_keyboard: [[{ text: '✏️ Modifier', callback_data: `edit_${idx}` }]] } };
}
function inlineDeleteRow(idx) {
  return { reply_markup: { inline_keyboard: [[{ text: '🗑️ Supprimer', callback_data: `delete_${idx}` }]] } };
}
function inlineConfirmDelete(idx) {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: '❌ Annuler',   callback_data: 'cancel_del' },
        { text: '✅ Confirmer', callback_data: `confirmdel_${idx}` }
      ]]
    }
  };
}

// ---------- Aides parsing ----------
function isHttpUrl(t) { return /^https?:\/\//i.test(t || ''); }
function parsePrices(s) {
  return s
    ? s.split(',').map(z => {
        const [qte, price] = z.split(':');
        return { qte: (qte || '').trim(), price: Number((price || '').trim()) };
      }).filter(x => x.qte && !isNaN(x.price))
    : [];
}

// ========== HANDLER ==========
exports.handler = async (event) => {
  try {
    const m = event.httpMethod;
    if (m === 'HEAD')    return { statusCode: 200, headers: JSON_HEADERS };
    if (m === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };
    if (m !== 'POST')    return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

    const TOKEN = process.env.BOT_TOKEN;
    if (!TOKEN) return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Missing BOT_TOKEN' }) };

    let update;
    try { update = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Bad JSON' }) }; }

    // ----- CALLBACK QUERY -----
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id;
      const data = cb.data || '';
      await answerCb(TOKEN, cb.id);

      if (!isAdmin(chatId)) {
        await sendMsg(TOKEN, chatId, '⛔ Accès admin requis.');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }

      let menu = (await getKV('menu')) || [];

      if (data.startsWith('delete_')) {
        const idx = parseInt(data.split('_')[1], 10);
        if (!menu[idx]) {
          await sendMsg(TOKEN, chatId, 'Produit introuvable.');
        } else {
          await sendMsg(TOKEN, chatId, `⚠️ Supprimer "*${menu[idx].name}*" ?`, inlineConfirmDelete(idx));
        }
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }

      if (data === 'cancel_del') {
        await sendMsg(TOKEN, chatId, 'Suppression annulée.');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }

      if (data.startsWith('confirmdel_')) {
        const idx = parseInt(data.split('_')[1], 10);
        if (!menu[idx]) {
          await sendMsg(TOKEN, chatId, 'Produit introuvable.');
        } else {
          const name = menu[idx].name || '(sans nom)';
          menu.splice(idx, 1);
          await setKV('menu', menu);
          await sendMsg(TOKEN, chatId, `✅ Produit "*${name}*" supprimé !`);
        }
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }

      if (data.startsWith('edit_')) {
        const idx = parseInt(data.split('_')[1], 10);
        if (!menu[idx]) {
          await sendMsg(TOKEN, chatId, 'Produit introuvable.');
        } else {
          const stateKey = `state:${chatId}`;
          await setKV(stateKey, { mode: 'add', submode: 'edit', idx, step: 0, prod: { ...menu[idx] } });
          const first = productSteps[0];
          await sendMsg(TOKEN, chatId, `Modification "*${menu[idx].name}*"\n${first.ask(menu[idx].name)}`);
        }
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }

      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // ----- MESSAGE -----
    const msg   = update.message || {};
    const chatId = msg.chat?.id;
    const txt    = (msg.text || '').trim();

    if (!chatId) return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };

    // publique
    if (txt === '/whoami') {
      await sendMsg(TOKEN, chatId, `Votre chat_id: \`${chatId}\``, mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // admin only
    if (!isAdmin(chatId)) {
      await sendMsg(TOKEN, chatId, '⛔ Accès admin requis.');
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // données
    const stateKey = `state:${chatId}`;
    let state = (await getKV(stateKey)) || { mode: null, step: 0, prod: null };
    let menu  = (await getKV('menu')) || [];
    let conf  = (await getKV('site_config')) || {
      access_code: '1234',
      welcome: '',
      info: '',
      loyalty: { enabled: false, required_orders: 8, users: {} },
      promo:   { enabled: false, text: '', speed: 60 }
    };

    // accueil
    if (txt === '/start' || txt === '/help') {
      await showMainMenu(TOKEN, chatId);
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // ===== Boutons principal =====
    if (txt === '➕ Ajouter') {
      state = { mode: 'add', submode: 'create', step: 0, prod: { prices: [] } };
      await setKV(stateKey, state);
      const s = productSteps[0];
      await sendMsg(TOKEN, chatId, s.ask(''), mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    if (txt === '📝 Modifier') {
      if (!menu.length) {
        await sendMsg(TOKEN, chatId, 'Aucun produit à modifier.', mainKeyboard());
      } else {
        for (let i = 0; i < menu.length; i++) {
          const p = menu[i];
          const line = `#${i + 1} - ${p.name || '(sans nom)'} ${p.cat ? `(${p.cat})` : ''}`;
          await sendMsg(TOKEN, chatId, line, inlineEditRow(i));
        }
      }
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    if (txt === '🗑️ Supprimer') {
      if (!menu.length) {
        await sendMsg(TOKEN, chatId, 'Aucun produit à supprimer.', mainKeyboard());
      } else {
        for (let i = 0; i < menu.length; i++) {
          const p = menu[i];
          const line = `#${i + 1} - ${p.name || '(sans nom)'} ${p.cat ? `(${p.cat})` : ''}`;
          await sendMsg(TOKEN, chatId, line, inlineDeleteRow(i));
        }
      }
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    if (txt === '🔑 Code d\'accès') {
      state = { mode: 'config_set', key: 'access_code' };
      await setKV(stateKey, state);
      await sendMsg(TOKEN, chatId, `Code actuel : ${conf.access_code}\nEnvoie le *nouveau code* (2–16 alphanum).`, mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    if (txt === '🏠 Message bienvenue') {
      state = { mode: 'config_set', key: 'welcome' };
      await setKV(stateKey, state);
      await sendMsg(TOKEN, chatId, `Message actuel :\n${conf.welcome || '(vide)'}\n\nEnvoie le *nouveau message de bienvenue*.`, mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    if (txt === 'ℹ️ Info & consignes') {
      state = { mode: 'config_set', key: 'info' };
      await setKV(stateKey, state);
      await sendMsg(TOKEN, chatId, `Texte actuel :\n${conf.info || '(vide)'}\n\nEnvoie les *nouvelles infos & consignes*.`, mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    if (txt === '🎁 Fidélité') {
      state = { mode: 'loyalty' };
      await setKV(stateKey, state);
      await sendMsg(
        TOKEN,
        chatId,
        `Fidélité: *${conf.loyalty.enabled ? 'ON' : 'OFF'}* — seuil: *${conf.loyalty.required_orders}*\n` +
        `• *on / off* pour activer.\n` +
        `• *seuil 8* pour fixer le nombre de commandes.\n` +
        `• *@user +1* (ou -1 / =5) pour incrémenter/décrémenter/poser la valeur.\n` +
        `• *@user ?* pour voir le compteur.\n` +
        `Tape /annuler pour quitter.`
      , mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    if (txt === '📢 Bandeau promo') {
      state = { mode: 'promo' };
      await setKV(stateKey, state);
      await sendMsg(
        TOKEN,
        chatId,
        `Bandeau promo: *${conf.promo.enabled ? 'ON' : 'OFF'}*\n` +
        `Texte actuel: ${conf.promo.text ? '`'+conf.promo.text+'`' : '(vide)'}\n` +
        `• *on* / *off*\n` +
        `• *texte Votre message de promo...*\n` +
        `• *vitesse 60* (facultatif)\n` +
        `Tape /annuler pour quitter.`
      , mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // cancel
    if (txt === '/cancel' || txt === '/annuler') {
      state = { mode: null, step: 0, prod: null };
      await setKV(stateKey, state);
      await sendMsg(TOKEN, chatId, 'Annulé.', mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // ===== Mode config_set =====
    if (state.mode === 'config_set' && state.key) {
      const key = state.key;
      if (key === 'access_code') {
        if (!/^\w{2,16}$/.test(txt)) {
          await sendMsg(TOKEN, chatId, 'Le code doit faire 2–16 caractères alphanumériques. Réessaie ou /annuler.');
          return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
        }
      }
      conf[key] = txt;
      await setKV('site_config', conf);
      await setKV(stateKey, { mode: null, step: 0, prod: null });
      await sendMsg(TOKEN, chatId, `✅ ${key} mis à jour !`, mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // ===== Mode loyalty =====
    if (state.mode === 'loyalty') {
      const t = txt.toLowerCase();
      if (t === 'on' || t === 'off') {
        conf.loyalty.enabled = (t === 'on');
        await setKV('site_config', conf);
        await sendMsg(TOKEN, chatId, `Fidélité: *${conf.loyalty.enabled ? 'ON' : 'OFF'}*`);
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }
      if (t.startsWith('seuil ')) {
        const n = parseInt(t.split(' ')[1], 10);
        if (!Number.isFinite(n) || n < 1) {
          await sendMsg(TOKEN, chatId, 'Nombre invalide.');
        } else {
          conf.loyalty.required_orders = n;
          await setKV('site_config', conf);
          await sendMsg(TOKEN, chatId, `Seuil mis à jour: *${n}*.`);
        }
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }
      // @user +1 / -1 / =5 / ? / 5
      const mUser = txt.match(/^@([A-Za-z0-9_]{3,})\s*([+\-=?])?\s*(\d+)?$/);
      if (mUser) {
        const user = '@' + mUser[1];
        const op   = mUser[2] || '=';
        const val  = mUser[3] ? parseInt(mUser[3], 10) : 1;
        const map  = conf.loyalty.users || {};
        const cur  = Number(map[user] || 0);

        if (op === '?') {
          await sendMsg(TOKEN, chatId, `${user}: *${cur}* commandes.`);
        } else if (op === '+') {
          map[user] = cur + val;
          await sendMsg(TOKEN, chatId, `${user}: *${map[user]}* ( +${val} )`);
        } else if (op === '-') {
          map[user] = Math.max(0, cur - val);
          await sendMsg(TOKEN, chatId, `${user}: *${map[user]}* ( -${val} )`);
        } else { // '=' (ou pas d'opérateur)
          map[user] = val;
          await sendMsg(TOKEN, chatId, `${user}: fixé à *${map[user]}*`);
        }
        conf.loyalty.users = map;
        await setKV('site_config', conf);
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }

      await sendMsg(TOKEN, chatId, 'Commande inconnue. Ex: `@user +1`, `@user ?`, `seuil 8`, `on`/`off`.');
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // ===== Mode promo =====
    if (state.mode === 'promo') {
      const t = txt.toLowerCase();
      if (t === 'on' || t === 'off') {
        conf.promo.enabled = (t === 'on');
        await setKV('site_config', conf);
        await sendMsg(TOKEN, chatId, `Bandeau promo: *${conf.promo.enabled ? 'ON' : 'OFF'}*`);
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }
      if (t.startsWith('vitesse ')) {
        const n = parseInt(t.split(' ')[1], 10);
        if (!Number.isFinite(n) || n < 10 || n > 200) {
          await sendMsg(TOKEN, chatId, 'Vitesse invalide (10–200).');
        } else {
          conf.promo.speed = n;
          await setKV('site_config', conf);
          await sendMsg(TOKEN, chatId, `Vitesse: *${n}*`);
        }
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }
      if (t.startsWith('texte ')) {
        conf.promo.text = txt.slice(6).trim();
        await setKV('site_config', conf);
        await sendMsg(TOKEN, chatId, `Texte du bandeau mis à jour.`);
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }
      await sendMsg(TOKEN, chatId, 'Utilise: `on`/`off`, `texte ...`, `vitesse 60`.');
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // ===== Wizard d'ajout / édition =====
    if (state.mode === 'add') {
      const step = state.step || 0;
      const prod = state.prod || {};
      const current = productSteps[step];

      // helper pour avancer d'un step
      async function nextStep() {
        const nextIdx = step + 1;
        const next = productSteps[nextIdx];
        await setKV(stateKey, { ...state, step: nextIdx, prod });
        if (next) {
          const val = prod[next.key];
          const question = typeof next.ask === 'function' ? next.ask(val) : next.ask;
          await sendMsg(TOKEN, chatId, question);
        } else {
          await sendMsg(TOKEN, chatId, 'Tape /done pour enregistrer, ou /annuler pour annuler.');
        }
      }

      if (!current) {
        // fin
        if (state.submode === 'create') menu.push(prod);
        if (state.submode === 'edit')   menu[state.idx] = prod;
        await setKV('menu', menu);
        await setKV(stateKey, { mode: null, step: 0, prod: null });
        await sendMsg(TOKEN, chatId, state.submode === 'create' ? '✅ Produit ajouté !' : `✅ Produit "${prod.name}" modifié !`, mainKeyboard());
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }

      // /skip -> garder valeur et avancer
      if (txt === '/skip') {
        await nextStep();
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }

      // Étapes "img" / "video": accepter médias Telegram OU URL
      if (current.key === 'img' || current.key === 'video') {
        try {
          let url = null;

          if (current.key === 'img') {
            // photo Telegram
            if (Array.isArray(msg.photo) && msg.photo.length) {
              const largest = msg.photo[msg.photo.length - 1];
              url = await telegramFileToCatbox(TOKEN, largest.file_id);
            }
            // document image/*
            else if (msg.document?.mime_type?.startsWith('image/')) {
              url = await telegramFileToCatbox(TOKEN, msg.document.file_id);
            }
          }

          if (current.key === 'video' && !url) {
            if (msg.video?.file_id) {
              url = await telegramFileToCatbox(TOKEN, msg.video.file_id);
            } else if (msg.document?.mime_type?.startsWith('video/')) {
              url = await telegramFileToCatbox(TOKEN, msg.document.file_id);
            }
          }

          // lien http -> réhéberge aussi sur catbox pour uniformiser
          if (!url && isHttpUrl(txt)) {
            url = await catboxUrlUpload(txt);
          }

          if (!url) {
            await sendMsg(TOKEN, chatId, `Envoie un *${current.key === 'img' ? 'fichier image' : 'fichier vidéo'}* Telegram ou un lien http.\nOu /skip pour passer.`);
            return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
          }

          prod[current.key] = url;
          await nextStep();
          return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };

        } catch (err) {
          await sendMsg(TOKEN, chatId, `⛔ Upload Catbox échoué. Réessaie ou /skip.\n_${String(err.message || err)}_`);
          return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
        }
      }

      // Étape prices
      if (current.key === 'prices') {
        prod.prices = parsePrices(txt);
        await nextStep();
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }

      // Étape thclvl
      if (current.key === 'thclvl') {
        const num = Number(txt);
        if (!isNaN(num)) prod.thclvl = num;
        await nextStep();
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }

      // champs texte simples
      prod[current.key] = txt;
      await nextStep();
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // /done explicite (si l’admin préfère)
    if (txt === '/done') {
      if (state.mode !== 'add' || !state.prod) {
        await sendMsg(TOKEN, chatId, 'Rien à enregistrer. Tape "➕ Ajouter" pour commencer.', mainKeyboard());
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }
      const prod = state.prod;
      if (!prod.name) {
        await sendMsg(TOKEN, chatId, 'Nom manquant. /annuler pour quitter.');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }
      if (state.submode === 'create') menu.push(prod);
      if (state.submode === 'edit')   menu[state.idx] = prod;
      await setKV('menu', menu);
      await setKV(stateKey, { mode: null, step: 0, prod: null });
      await sendMsg(TOKEN, chatId, state.submode === 'create' ? '✅ Produit ajouté !' : `✅ Produit "${prod.name}" modifié !`, mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // ----- /menu (liste simple) -----
    if (txt === '/menu') {
      const list = menu.length
        ? menu.map((p, i) => `${i + 1}. *${p.name || '(sans nom)'}* ${p.cat ? `— ${p.cat}` : ''}`).join('\n')
        : '(vide)';
      await sendMsg(TOKEN, chatId, `Menu:\n${list}`);
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // ----- /edit N champ valeur...  (inclut effet + arome) -----
    if (txt.startsWith('/edit ')) {
      const parts = txt.split(' ');
      if (parts.length < 4) {
        await sendMsg(TOKEN, chatId, 'Format: `/edit N champ valeur...`\nchamps: name, cat, desc, effet, arome, thclvl, prices, img, video');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }
      const n = parseInt(parts[1], 10);
      const field = parts[2];
      const value = txt.split(' ').slice(3).join(' ');
      if (!Number.isInteger(n) || n < 1 || n > menu.length) {
        await sendMsg(TOKEN, chatId, 'Index N invalide.');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }
      const item = menu[n - 1];
      const allowed = ['name','cat','desc','effet','arome','thclvl','prices','img','video'];
      if (!allowed.includes(field)) {
        await sendMsg(TOKEN, chatId, `Champ invalide. Utilise: ${allowed.join(', ')}`);
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }
      if (field === 'thclvl') {
        const num = Number(value);
        if (isNaN(num)) {
          await sendMsg(TOKEN, chatId, 'thclvl doit être un nombre (ex: 18)');
          return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
        }
        item.thclvl = num;
      } else if (field === 'prices') {
        item.prices = parsePrices(value);
      } else {
        // Pour /edit img http..., on réhéberge aussi
        if ((field === 'img' || field === 'video') && isHttpUrl(value)) {
          try {
            item[field] = await catboxUrlUpload(value);
          } catch {
            item[field] = value; // fallback
          }
        } else {
          item[field] = value;
        }
      }
      menu[n - 1] = item;
      await setKV('menu', menu);
      await sendMsg(TOKEN, chatId, `✏️ Édité #${n} \`${field}\`.`);
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // défaut
    await showMainMenu(TOKEN, chatId);
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Internal error', details: String(err?.message || err) }) };
  }
};

