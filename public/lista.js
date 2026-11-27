// Página do responsável do alojamento (lista semanal): marca quem está, quem já não está e quem chegou.
// Sem login: o link tem um código único, válido 7 dias, só deste alojamento. Sem innerHTML.
(function () {
  const token = location.pathname.split('/').pop();
  const app = document.getElementById('app');
  const T = {
    es: { hi: (n) => (new Date().getHours() < 12 ? 'Buenos días' : 'Buenas tardes') + (n ? `, ${n}` : ''), intro: (h) => `Indica quién está contigo en el alojamiento «${h}» esta semana.`, here: 'Está', gone: 'Ya no está',
      newT: '¿Hay alguien nuevo que no aparece?', newP: 'Nombre y apellidos', add: '+ Añadir otra persona', note: 'Comentario (opcional)', send: 'Enviar lista', sending: 'Enviando…',
      thanks: '¡Gracias! La lista se ha enviado. Puedes cerrar esta página.', thanksT: '¡Gracias!', thanksP: 'Hemos recibido la lista. Ya puedes cerrar esta página.', again: 'Ya enviaste esta lista. Si cambias algo, vuelve a enviarla.', err: 'No se pudo enviar. Inténtalo de nuevo.', none: 'No hay nadie registrado en este alojamiento.' },
    pt: { hi: (n) => (new Date().getHours() < 12 ? 'Bom dia' : 'Boa tarde') + (n ? `, ${n}` : ''), intro: (h) => `Indica quem está contigo no alojamento «${h}» esta semana.`, here: 'Está', gone: 'Já não está',
      newT: 'Há alguém novo que não aparece?', newP: 'Nome e apelido', add: '+ Acrescentar outra pessoa', note: 'Comentário (opcional)', send: 'Enviar lista', sending: 'A enviar…',
      thanks: 'Obrigado! A lista foi enviada. Pode fechar esta página.', thanksT: 'Obrigado!', thanksP: 'Recebemos a lista. Já podes fechar esta página.', again: 'Já enviaste esta lista. Se mudares algo, volta a enviar.', err: 'Não foi possível enviar. Tenta de novo.', none: 'Não há ninguém registado neste alojamento.' },
  };
  const el = (tag, attrs, ...kids) => {
    // sem atributos: o 2.º argumento já é conteúdo (texto, elemento ou lista)
    if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { kids.unshift(attrs); attrs = {}; }
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'class') e.className = v; else e.setAttribute(k, v === true ? '' : v); }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
    return e;
  };
  const brand = el('div', { class: 'brand' }, el('img', { src: '/logo.jpg', alt: '' }), 'Fonsat');
  fetch(`/api/lista/${token}`).then(async (r) => {
    const d = await r.json();
    if (!r.ok) { app.replaceChildren(brand, el('div', { class: 'panel' }, el('div', { class: 'msg bad' }, d.error || 'Link no válido.'))); return; }
    const t = T[d.language] || T.es;
    document.documentElement.lang = d.language;
    const present = new Set(d.answer ? d.answer.present : d.occupants.map((o) => o.id));
    const rows = d.occupants.map((o) => {
      const yes = el('button', { type: 'button', class: 'yes' }, t.here), no = el('button', { type: 'button', class: 'no' }, t.gone);
      const sync = () => { yes.setAttribute('aria-pressed', String(present.has(o.id))); no.setAttribute('aria-pressed', String(!present.has(o.id))); };
      yes.addEventListener('click', () => { present.add(o.id); sync(); }); no.addEventListener('click', () => { present.delete(o.id); sync(); });
      sync();
      return el('div', { class: 'p' }, el('b', o.name), el('div', { class: 'tg', role: 'group', 'aria-label': o.name }, yes, no));
    });
    const news = el('div');
    const addNew = (v = '') => news.append(el('input', { type: 'text', maxlength: 120, placeholder: t.newP, value: v, 'aria-label': t.newP }));
    (d.answer?.new_names?.length ? d.answer.new_names : ['']).forEach(addNew);
    const note = el('textarea', { rows: 2, maxlength: 500, placeholder: t.note, 'aria-label': t.note });
    note.value = d.answer?.note ?? '';
    const msg = el('div');
    const btn = el('button', { class: 'btn', type: 'button' }, t.send);
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = t.sending;
      try {
        const r2 = await fetch(`/api/lista/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ present: [...present], new_names: [...news.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean), note: note.value }) });
        if (!r2.ok) throw new Error();
        // enviado: a página inteira dá lugar ao agradecimento (sem botão para voltar a enviar)
        app.replaceChildren(brand, el('div', { class: 'panel done' }, el('div', { class: 'check', 'aria-hidden': 'true' }, '✓'), el('h1', t.thanksT), el('p', t.thanksP)));
        window.scrollTo(0, 0);
        return;
      } catch { msg.replaceChildren(el('div', { class: 'msg bad' }, t.err)); }
      btn.disabled = false; btn.textContent = t.send;
    });
    app.replaceChildren(brand,
      el('div', { class: 'panel' }, el('h1', t.hi(d.responsible ? d.responsible.charAt(0) + d.responsible.slice(1).toLowerCase() : '')), el('p', t.intro(d.house)), d.answered_at ? el('div', { class: 'msg ok' }, t.again) : null,
        rows.length ? rows : el('p', t.none)),
      el('div', { class: 'panel' }, el('p', el('b', t.newT)), news, el('button', { class: 'btn ghost', type: 'button', onclick: () => addNew() }, t.add)),
      el('div', { class: 'panel' }, note, msg, btn));
  }).catch(() => app.replaceChildren(brand, el('div', { class: 'msg bad' }, 'Error / Erro')));
})();
