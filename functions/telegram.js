// functions/telegram.js
const { getKV, setKV } = require('./supabase');

const JSON_HEADERS = { 'content-type': 'application/json' };

// Admins : ADMIN_IDS (1+ IDs séparés par virgule) ou fallback ADMIN_CHAT_ID
const ADMIN_IDS = (process.env.ADMIN_IDS || process.env.ADMIN_CHAT_ID || '')
  .split(',').map(x => x.trim()).filter(Boolean);
const isAdmin = id => ADMIN_IDS.includes(String(id));

// --- Utils Telegram ---
async function tgFetch(method, body, TOKEN) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await r.text().catch(()=> '');
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

// --- Menu principal (reply keyboard) ---
function mainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["➕ Ajouter", "📝 Modifier", "🗑️ Supprimer"],
        ["🔑 Code d'accès", "🏠 Message bienvenue", "ℹ️ Info & consignes"]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}
async function showMainMenu(TOKEN, chatId) {
  await sendMsg(TOKEN, chatId, "Que veux-tu faire ?", mainKeyboard());
}

// --- Wizard produit (mêmes étapes que ta version) ---
const productSteps = [
  { key: 'name',   ask: (v)=>`Envoie le *NOM* du produit${v?` (ou /skip pour garder "${v}")`:""}` },
  { key: 'cat',    ask: (v)=>`Catégorie ?${v?` (ou /skip pour garder "${v}")`:""}` },
  { key: 'desc',   ask: (v)=>`Description ?${v?` (ou /skip pour garder "${v}")`:""}` },
  { key: 'thclvl', ask: (v)=>`Taux THC (%) ?${v?` (ou /skip pour garder "${v}")`:""}` },
  { key: 'prices', ask: (v)=>`Prix (format : 1g:10,2g:18)\n${Array.isArray(v)&&v.length?`Valeur actuelle : ${v.map(x=>x.qte+":"+x.price).join(', ')}`:""}\nEnvoie ou /skip pour garder.` },
  { key: 'img',    ask: (v)=>`URL image ? (ou /skip pour garder "${v||'(aucune)'}")` },
  { key: 'video',  ask: (v)=>`URL vidéo ? (ou /skip pour garder "${v||'(aucune)'}")` },
];

// --- Inline pour lister les produits ---
function inlineEditRow(idx) {
  return { inline_keyboard: [[ { text: "✏️ Modifier", callback_data: `edit_${idx}` } ]] };
}
function inlineDeleteRow(idx) {
  return { inline_keyboard: [[ { text: "🗑️ Supprimer", callback_data: `delete_${idx}` } ]] };
}
function inlineConfirmDelete(idx) {
  return {
    inline_keyboard: [[
      { text: "❌ Annuler",  callback_data: "cancel_del" },
      { text: "✅ Confirmer", callback_data: `confirmdel_${idx}` }
    ]]
  };
}

exports.handler = async (event) => {
  try {
    const m = event.httpMethod;
    if (m === 'HEAD')   return { statusCode: 200, headers: JSON_HEADERS };
    if (m === 'OPTIONS')return { statusCode: 204, headers: JSON_HEADERS, body: '' };
    if (m !== 'POST')   return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

    const TOKEN = process.env.BOT_TOKEN;
    if (!TOKEN) return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Missing BOT_TOKEN' }) };

    let update;
    try { update = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Bad JSON' }) }; }

    // --- CALLBACK QUERY (inline boutons) ---
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id;
      const data = cb.data || '';
      await answerCb(TOKEN, cb.id);

      if (!isAdmin(chatId)) {
        await sendMsg(TOKEN, chatId, '⛔ Accès admin requis.');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }

      // Données
      let menu = (await getKV('menu')) || [];

      if (data.startsWith('delete_')) {
        const idx = parseInt(data.split('_')[1], 10);
        if (!menu[idx]) { await sendMsg(TOKEN, chatId, 'Produit introuvable.'); }
        else {
          await sendMsg(TOKEN, chatId, `⚠️ Supprimer "*${menu[idx].name}*"?`, { reply_markup: inlineConfirmDelete(idx) });
        }
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }

      if (data === 'cancel_del') {
        await sendMsg(TOKEN, chatId, 'Suppression annulée.');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
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
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }

      if (data.startsWith('edit_')) {
        const idx = parseInt(data.split('_')[1], 10);
        if (!menu[idx]) { await sendMsg(TOKEN, chatId, 'Produit introuvable.'); }
        else {
          // démarrer wizard édition
          const stateKey = `state:${chatId}`;
          await setKV(stateKey, { mode: 'add', submode: 'edit', idx, step: 0, prod: { ...menu[idx] } });
          const first = productSteps[0];
          await sendMsg(TOKEN, chatId, `Modification "*${menu[idx].name}*"\n${first.ask(menu[idx].name)}`);
        }
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }

      // Fallback
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // --- MESSAGE (reply keyboard / commandes) ---
    const msg = update.message;
    const chatId = msg?.chat?.id;
    const txt = (msg?.text || '').trim();

    if (!chatId) return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };

    // publique
    if (txt === '/whoami') {
      await sendMsg(TOKEN, chatId, `Votre chat_id: \`${chatId}\``, mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // admin uniquement
    if (!isAdmin(chatId)) {
      await sendMsg(TOKEN, chatId, '⛔ Accès admin requis.');
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // charge données
    const stateKey = `state:${chatId}`;
    let state = (await getKV(stateKey)) || { mode: null, step: 0, prod: null };
    let menu = (await getKV('menu')) || [];
    let conf = (await getKV('site_config')) || { access_code: '1234', welcome: '', info: '' };

    // /start ou /help => menu
    if (txt === '/start' || txt === '/help') {
      await showMainMenu(TOKEN, chatId);
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // === BOUTONS MENU PRINCIPAL ===
    if (txt === '➕ Ajouter') {
      state = { mode: 'add', submode: 'create', step: 0, prod: { prices: [] } };
      await setKV(stateKey, state);
      const s = productSteps[0]; await sendMsg(TOKEN, chatId, s.ask(''), mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    if (txt === '📝 Modifier') {
      if (!menu.length) { await sendMsg(TOKEN, chatId, 'Aucun produit à modifier.', mainKeyboard()); }
      else {
        for (let i=0;i<menu.length;i++) {
          const p = menu[i];
          await sendMsg(TOKEN, chatId, `#${i+1} - ${p.name || '(sans nom)'} ${p.cat?`(${p.cat})`:''}`, { reply_markup: inlineEditRow(i) });
        }
      }
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    if (txt === '🗑️ Supprimer') {
      if (!menu.length) { await sendMsg(TOKEN, chatId, 'Aucun produit à supprimer.', mainKeyboard()); }
      else {
        for (let i=0;i<menu.length;i++) {
          const p = menu[i];
          await sendMsg(TOKEN, chatId, `#${i+1} - ${p.name || '(sans nom)'} ${p.cat?`(${p.cat})`:''}`, { reply_markup: inlineDeleteRow(i) });
        }
      }
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    if (txt === '🔑 Code d\'accès') {
      state = { mode: 'config_set', key: 'access_code' };
      await setKV(stateKey, state);
      await sendMsg(TOKEN, chatId, `Code actuel : ${conf.access_code}\nEnvoie le *nouveau code* (2–16 caractères).`, mainKeyboard());
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

    // === ANNULER ===
    if (txt === '/cancel' || txt === '/annuler') {
      state = { mode: null, step: 0, prod: null };
      await setKV(stateKey, state);
      await sendMsg(TOKEN, chatId, 'Annulé.', mainKeyboard());
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // === MODE CONFIG_SET (depuis boutons) ===
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

    // === WIZARD PRODUIT (add/edit) ===
    if (state.mode === 'add') {
      const step = state.step || 0;
      const prod = state.prod || {};
      const current = productSteps[step];

      if (!current) {
        // fin
        if (state.submode === 'create') menu.push(prod);
        if (state.submode === 'edit')   menu[state.idx] = prod;
        await setKV('menu', menu);
        await setKV(stateKey, { mode: null, step: 0, prod: null });
        await sendMsg(TOKEN, chatId, state.submode === 'create' ? '✅ Produit ajouté !' : `✅ Produit "${prod.name}" modifié !`, mainKeyboard());
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }

      // Traite la réponse
      if (txt !== '/skip') {
        if (current.key === 'prices') {
          prod.prices = txt
            ? txt.split(',').map(s => {
                const [qte, price] = s.split(':');
                return { qte: (qte||'').trim(), price: Number((price||'').trim()) };
              }).filter(x => x.qte && !isNaN(x.price))
            : [];
        } else if (current.key === 'thclvl') {
          const num = Number(txt);
          if (!isNaN(num)) prod.thclvl = num;
        } else {
          prod[current.key] = txt;
        }
      }
      // étape suivante
      const nextStep = step + 1;
      const next = productSteps[nextStep];
      await setKV(stateKey, { ...state, step: nextStep, prod });

      if (next) {
        const val = prod[next.key];
        const question = typeof next.ask === 'function' ? next.ask(val) : next.ask;
        await sendMsg(TOKEN, chatId, question);
      } else {
        // la fin sera gérée au prochain tour (current === undefined)
        await sendMsg(TOKEN, chatId, 'Tape /done pour enregistrer, ou /annuler pour annuler.');
      }
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

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

    // Par défaut → réaffiche le menu
    await showMainMenu(TOKEN, chatId);
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Internal error', details: String(err?.message || err) }) };
  }
};

