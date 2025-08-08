// functions/telegram.js
const { getKV, setKV } = require('./supabase');

const JSON_HEADERS = { 'content-type': 'application/json' };

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

    const stateKey = `state:${chatId}`;
    const state = (await getKV(stateKey)) || { mode: null, step: 0, prod: null };

    const menu = (await getKV('menu')) || [];
    const conf = (await getKV('site_config')) || { access_code: '1234', welcome: '', info: '' };

    // --- Commandes ---
    if (txt === '/start') {
      await sendMsg(TOKEN, chatId, [
        'Bienvenue !',
        '• /menu — voir le menu',
        '• /add — ajouter un produit',
        '• /config — modifier texte du site (welcome/info/access_code)',
        '• /cancel — annuler',
        '• /done — enregistrer'
      ].join('\n'));
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    if (txt === '/menu') {
      const list = menu.length
        ? menu.map((p, i) => `${i + 1}. *${p.name}* ${p.cat ? `— ${p.cat}` : ''}`).join('\n')
        : '(vide)';
      await sendMsg(TOKEN, chatId, `Menu:\n${list}`);
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    if (txt === '/cancel') {
      await setKV(stateKey, { mode: null, step: 0, prod: null });
      await sendMsg(TOKEN, chatId, 'Annulé.');
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    if (txt === '/config') {
      await setKV(stateKey, { mode: 'config', step: 0, prod: null });
      await sendMsg(TOKEN, chatId, 'Mode config.\nEnvoie `welcome ...` ou `info ...` ou `access_code ...`');
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // Mode config: "clé valeur..."
    if (state.mode === 'config' && txt) {
      const space = txt.indexOf(' ');
      if (space > 0) {
        const key = txt.slice(0, space);
        const val = txt.slice(space + 1);
        if (['welcome', 'info', 'access_code'].includes(key)) {
          conf[key] = val;
          await setKV('site_config', conf);
          await sendMsg(TOKEN, chatId, `✅ Mis à jour *${key}*.`);
          return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
        }
      }
      await sendMsg(TOKEN, chatId, 'Format: `welcome Votre message`');
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // Mode ajout produit
    if (txt === '/add') {
      await setKV(stateKey, { mode: 'add', step: 0, prod: {} });
      await sendMsg(TOKEN, chatId, 'Ajout produit. Nom ? (ou /cancel)');
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    if (state.mode === 'add') {
      const prod = state.prod || {};
      const steps = [
        { key: 'name',   ask: 'Nom ?' },
        { key: 'cat',    ask: 'Catégorie ?' },
        { key: 'desc',   ask: 'Description ?' },
        { key: 'thclvl', ask: 'Taux THC (%) ?' },
        { key: 'prices', ask: 'Prix (ex: 1g:10,2g:18)' },
        { key: 'img',    ask: 'URL image (ou vide)' },
        { key: 'video',  ask: 'URL vidéo (ou vide)' },
      ];

      const prev = steps[state.step - 1];
      if (prev) {
        if (prev.key === 'prices') {
          prod.prices = txt
            ? txt.split(',').map(x => {
                const [qte, price] = x.split(':');
                return { qte: qte?.trim(), price: Number(price) };
              }).filter(x => x.qte && !isNaN(x.price))
            : [];
        } else if (prev.key) {
          prod[prev.key] = txt;
        }
      }

      const next = steps[state.step];
      if (next) {
        await setKV(stateKey, { mode: 'add', step: state.step + 1, prod });
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
      const list = (await getKV('menu')) || [];
      list.push(prod);
      await setKV('menu', list);
      await setKV(stateKey, { mode: null, step: 0, prod: null });
      await sendMsg(TOKEN, chatId, `✅ Produit *${prod.name}* ajouté !`);
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // Par défaut
    await sendMsg(TOKEN, chatId, 'Commande inconnue. Utilise /menu, /add, /config, /cancel, /done.');
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Internal error', details: String(err?.message || err) }) };
  }
};
