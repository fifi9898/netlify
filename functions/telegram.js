const { getKV, setKV } = require('./supabase');

async function sendMsg(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const TOKEN = process.env.BOT_TOKEN;
  const update = JSON.parse(event.body || '{}');
  const msg = update.message;
  const chatId = msg?.chat?.id;
  const txt = (msg?.text || '').trim();

  if (!chatId) return { statusCode: 200, body: 'ok' };

  // charge états
  const state = await getKV(`state:${chatId}`) || { mode:null, prod:null };

  // helpers
  const menu = await getKV('menu') || [];
  const conf = await getKV('site_config') || { access_code:'1234', welcome:'', info:'' };

  // commandes
  if (txt === '/start') {
    await sendMsg(TOKEN, chatId, `Bienvenue !\n• /menu — voir le menu\n• /add — ajouter un produit\n• /config — modifier texte du site`);
    return { statusCode: 200, body: 'ok' };
  }

  if (txt === '/menu') {
    const list = menu.length ? menu.map((p,i)=>`${i+1}. *${p.name}* — ${p.cat||''}`).join('\n') : '(vide)';
    await sendMsg(TOKEN, chatId, `Menu:\n${list}`);
    return { statusCode: 200, body: 'ok' };
  }

  if (txt === '/add') {
    await setKV(`state:${chatId}`, { mode:'add', step:0, prod:{} });
    await sendMsg(TOKEN, chatId, `Ajout produit.\nNom du produit ? (ou /cancel)`);
    return { statusCode: 200, body: 'ok' };
  }

  if (txt === '/cancel') {
    await setKV(`state:${chatId}`, { mode:null, step:0, prod:null });
    await sendMsg(TOKEN, chatId, `Annulé.`);
    return { statusCode: 200, body: 'ok' };
  }

  if (txt === '/config') {
    await setKV(`state:${chatId}`, { mode:'config', step:0 });
    await sendMsg(TOKEN, chatId, `Mode config.\nEnvoie *welcome* ou *info* ou *access_code* puis le texte.\nEx: welcome Bonjour !`);
    return { statusCode: 200, body: 'ok' };
  }

  // mode config: "clé valeur..."
  if (state.mode === 'config' && txt) {
    const space = txt.indexOf(' ');
    if (space > 0) {
      const key = txt.slice(0, space);
      const val = txt.slice(space+1);
      if (['welcome','info','access_code'].includes(key)) {
        conf[key] = val;
        await setKV('site_config', conf);
        await sendMsg(TOKEN, chatId, `✅ Mis à jour *${key}*.`);
        return { statusCode: 200, body: 'ok' };
      }
    }
    await sendMsg(TOKEN, chatId, `Format: \`welcome Votre message\``);
    return { statusCode: 200, body: 'ok' };
  }

  // mode add (wizard ultra simple)
  if (state.mode === 'add') {
    const prod = state.prod || {};
    const steps = [
      { key:'name', ask:'Nom ?' },
      { key:'cat', ask:'Catégorie ?' },
      { key:'desc', ask:'Description ?' },
      { key:'thclvl', ask:'Taux THC (%) ?' },
      { key:'prices', ask:'Prix (ex: 1g:10,2g:18)' },
      { key:'img', ask:'URL image (ou vide)' },
      { key:'video', ask:'URL vidéo (ou vide)' },
    ];
    const s = steps[state.step] || null;

    if (s) {
      // enregistrement étape précédente avec txt
      if (state.step >= 0) {
        const prev = steps[state.step-1];
        if (prev) {
          if (prev.key === 'prices') {
            prod.prices = txt ? txt.split(',').map(x=>{
              const [qte, price]=x.split(':'); return { qte:qte?.trim(), price: Number(price) };
            }).filter(x=>x.qte && !isNaN(x.price)) : [];
          } else if (prev.key) {
            prod[prev.key] = txt;
          }
        }
      }
      // poser question suivante
      const next = steps[state.step];
      await setKV(`state:${chatId}`, { mode:'add', step: state.step+1, prod });
      await sendMsg(TOKEN, chatId, next.ask + `\n(/cancel pour annuler, /done pour finir)`);
      return { statusCode: 200, body: 'ok' };
    } else {
      await sendMsg(TOKEN, chatId, `Tape /done pour enregistrer, ou /cancel pour annuler.`);
      return { statusCode: 200, body: 'ok' };
    }
  }

  if (txt === '/done') {
    if (state.mode !== 'add' || !state.prod) {
      await sendMsg(TOKEN, chatId, `Rien à enregistrer. Tape /add pour commencer.`);
      return { statusCode: 200, body: 'ok' };
    }
    const prod = state.prod;
    if (!prod.name) { await sendMsg(TOKEN, chatId, `Nom manquant.`); return { statusCode: 200, body: 'ok' }; }
    menu.push(prod);
    await setKV('menu', menu);
    await setKV(`state:${chatId}`, { mode:null, step:0, prod:null });
    await sendMsg(TOKEN, chatId, `✅ Produit *${prod.name}* ajouté !`);
    return { statusCode: 200, body: 'ok' };
  }

  // par défaut
  await sendMsg(TOKEN, chatId, `Commande inconnue. Utilise /menu, /add, /config, /cancel.`);
  return { statusCode: 200, body: 'ok' };
};
