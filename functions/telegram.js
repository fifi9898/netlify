// functions/telegram.js
const { getKV, setKV } = require('./supabase');

const JSON_HEADERS = { 'content-type': 'application/json' };

// Admins : mets ADMIN_IDS (plusieurs IDs séparés par des virgules) ou à défaut ADMIN_CHAT_ID
const ADMIN_IDS = (process.env.ADMIN_IDS || process.env.ADMIN_CHAT_ID || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);
const isAdmin = id => ADMIN_IDS.includes(String(id));

async function sendMsg(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  });
}

exports.handler = async (event) => {
  try {
    const m = event.httpMethod;

    // évite les 405 parasites
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

    if (!chatId) return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };

    // commande publique utile
    if (txt === '/whoami') {
      await sendMsg(TOKEN, chatId, `Votre chat_id: \`${chatId}\``);
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // dès ici : admin uniquement
    if (!isAdmin(chatId)) {
      await sendMsg(TOKEN, chatId, '⛔ Accès admin requis.');
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // charge données
    const stateKey = `state:${chatId}`;
    let state = (await getKV(stateKey)) || { mode: null, step: 0, prod: null };
    let menu = (await getKV('menu')) || [];
    let conf = (await getKV('site_config')) || { access_code: '1234', welcome: '', info: '' };

    // --- aide ---
    if (txt === '/start' || txt === '/help') {
      await sendMsg(TOKEN, chatId, [
        '*Admin*',
        '• /menu — voir le menu',
        '• /add — ajouter un produit (assistant)',
        '• /del N — supprimer l’item N (1,2,3...)',
        '• /edit N champ valeur — éditer un item',
        '   champs: name, cat, desc, thclvl, prices, img, video',
        '   ex: /edit 2 prices 1g:10,2g:18',
        '• /config — modifier welcome/info/access_code (mode guidé)',
        '• /cancel — annuler',
        '• /done — enregistrer',
        '• /whoami — afficher votre chat_id'
      ].join('\n'));
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // --- liste ---
    if (txt === '/menu') {
      const list = menu.length
        ? menu.map((p, i) => `${i + 1}. *${p.name || '(sans nom)'}* ${p.cat ? `— ${p.cat}` : ''}`).join('\n')
        : '(vide)';
      await sendMsg(TOKEN, chatId, `Menu:\n${list}`);
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // --- suppression ---
    if (txt.startsWith('/del ')) {
      const n = parseInt(txt.split(/\s+/)[1], 10);
      if (!Number.isInteger(n) || n < 1 || n > menu.length) {
        await sendMsg(TOKEN, chatId, 'Format: `/del N` avec N entre 1 et la longueur du menu.');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }
      const removed = menu.splice(n - 1, 1)[0];
      await setKV('menu', menu);
      await sendMsg(TOKEN, chatId, `🗑️ Supprimé: *${removed?.name || '(sans nom)'}* (#${n})`);
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // --- édition ---
    if (txt.startsWith('/edit ')) {
      const parts = txt.split(' ');
      if (parts.length < 4) {
        await sendMsg(TOKEN, chatId, 'Format: `/edit N champ valeur...`\nchamps: name, cat, desc, thclvl, prices, img, video');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }
      const n = parseInt(parts[1], 10);
      const field = parts[2];
      const value = txt.split(' ').slice(3).join(' ');
      if (!Number.isInteger(n) || n < 1 || n > menu.length) {
        await sendMsg(TOKEN, chatId, 'Index N invalide.');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }
      const allowed = ['name','cat','desc','thclvl','prices','img','video'];
      if (!allowed.includes(field)) {
        await sendMsg(TOKEN, chatId, `Champ invalide. Utilise: ${allowed.join(', ')}`);
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }

      const item = menu[n - 1];
      if (field === 'thclvl') {
        const num = Number(value);
        if (isNaN(num)) { await sendMsg(TOKEN, chatId, 'thclvl doit être un nombre (ex: 18)'); }
        else item.thclvl = num;
      } else if (field === 'prices') {
        // 1g:10,2g:18
        const arr = value
          ? value.split(',').map(x => {
              const [qte, price] = x.split(':');
              return { qte: qte?.trim(), price: Number(price) };
            }).filter(x => x.qte && !isNaN(x.price))
          : [];
        item.prices = arr;
      } else {
        item[field] = value;
      }
      menu[n - 1] = item;
      await setKV('menu', menu);
      await sendMsg(TOKEN, chatId, `✏️ Édité #${n} \`${field}\`.`);
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // --- config guidée ---
    if (txt === '/config') {
      state = { mode: 'config', step: 0, prod: null };
      await setKV(stateKey, state);
      await sendMsg(TOKEN, chatId, 'Mode config.\nEnvoie `welcome ...` ou `info ...` ou `access_code ...`');
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }
    if (state.mode === 'config' && txt) {
      const space = txt.indexOf(' ');
      if (space > 0) {
        const key = txt.slice(0, space);
        const val = txt.slice(space + 1);
        if (['welcome','info','access_code'].includes(key)) {
          conf[key] = val;
          await setKV('site_config', conf);
          await sendMsg(TOKEN, chatId, `✅ Mis à jour *${key}*.`);
          return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
        }
      }
      await sendMsg(TOKEN, chatId, 'Format: `welcome Votre message`');
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // --- assistant d'ajout ---
    if (txt === '/add') {
      state = { mode: 'add', step: 0, prod: {} };
      await setKV(stateKey, state);
      await sendMsg(TOKEN, chatId, 'Ajout produit. Nom ? (ou /cancel)');
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    if (state.mode === 'add') {
      const steps = [
        { key: 'name',   ask: 'Nom ?' },
        { key: 'cat',    ask: 'Catégorie ?' },
        { key: 'desc',   ask: 'Description ?' },
        { key: 'thclvl', ask: 'Taux THC (%) ?' },
        { key: 'prices', ask: 'Prix (ex: 1g:10,2g:18)' },
        { key: 'img',    ask: 'URL image (ou vide)' },
        { key: 'video',  ask: 'URL vidéo (ou vide)' },
      ];
      const prod = state.prod || {};
      const prev = steps[state.step - 1];

      if (prev) {
        if (prev.key === 'prices') {
          prod.prices = txt
            ? txt.split(',').map(x => {
                const [qte, price] = x.split(':');
                return { qte: qte?.trim(), price: Number(price) };
              }).filter(x => x.qte && !isNaN(x.price))
            : [];
        } else if (prev.key === 'thclvl') {
          const num = Number(txt);
          if (!isNaN(num)) prod.thclvl = num;
        } else {
          prod[prev.key] = txt;
        }
      }

      const next = steps[state.step];
      if (next) {
        state = { mode: 'add', step: state.step + 1, prod };
        await setKV(stateKey, state);
        await sendMsg(TOKEN, chatId, next.ask + '\n(/cancel pour annuler, /done pour finir)');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      } else {
        await sendMsg(TOKEN, chatId, 'Tape /done pour enregistrer, ou /cancel pour annuler.');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }
    }

    if (txt === '/done') {
      if (state.mode !== 'add' || !state.prod) {
        await sendMsg(TOKEN, chatId, 'Rien à enregistrer. Tape /add pour commencer.');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }
      const prod = state.prod;
      if (!prod.name) {
        await sendMsg(TOKEN, chatId, 'Nom manquant.');
        return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
      }
      menu.push(prod);
      await setKV('menu', menu);
      state = { mode: null, step: 0, prod: null };
      await setKV(stateKey, state);
      await sendMsg(TOKEN, chatId, `✅ Produit *${prod.name}* ajouté !`);
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    if (txt === '/cancel') {
      state = { mode: null, step: 0, prod: null };
      await setKV(stateKey, state);
      await sendMsg(TOKEN, chatId, 'Annulé.');
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // par défaut
    await sendMsg(TOKEN, chatId, 'Commande inconnue. Utilise /help.');
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Internal error', details: String(err?.message || err) }) };
  }
};
