// Faux serveur Notion (API 2025-09-03) pour les tests : bases en mémoire, pagination, 429 simulés.
import http from 'node:http';

// Horloge des pages : part de J-2 et avance d'une minute par écriture, sans jamais être en retard
// sur l'heure réelle (le serveur renvoie aussi l'en-tête Date réel, comme Notion).
let clock = Date.now() - 2 * 86_400_000;
export const tick = () => {
  clock = Math.max(clock + 60_000, Math.floor(Date.now() / 60_000) * 60_000);
  return new Date(clock).toISOString();
};

const P = {
  title: (s) => ({ type: 'title', title: [{ plain_text: s }] }),
  text: (s) => ({ type: 'rich_text', rich_text: [{ plain_text: s }] }),
  rel: (...ids) => ({ type: 'relation', relation: ids.filter(Boolean).map((id) => ({ id })) }),
  select: (s) => ({ type: 'select', select: s ? { name: s } : null }),
  multi: (...s) => ({ type: 'multi_select', multi_select: s.map((name) => ({ name })) }),
  num: (n) => ({ type: 'number', number: n }),
  date: (d) => ({ type: 'date', date: d ? { start: d, end: null } : null }),
  people: (...emails) => ({ type: 'people', people: emails.map((email) => ({ object: 'user', person: { email } })) }),
};
export { P };

const SCHEMAS = {
  topics: { Name: 'title', Sujet: 'rich_text' },
  subtopics: {
    Nom: 'title',
    'Tags géographique': 'select',
    'Tags statut projet ITL': 'select',
    'Tags CIR/CII': 'multi_select',
  },
  tasks: {
    'Nom de la tâche': 'title',
    'Sous-sujet': 'relation',
    'Sujet FT': 'relation',
    'Tag géographique (tâche)': 'select',
    'Tag statut projet ITL (tâche)': 'select',
    'Tag CIR/CII (tâche)': 'multi_select',
    'Dernière modif.': 'last_edited_time',
  },
  timeLogs: {
    Description: 'title',
    Date: 'date',
    'Temps passé': 'number',
    Personne: 'people',
    Tasks: 'relation',
    Étiquettes: 'multi_select',
  },
};

export function createFakeNotion(dbIds) {
  const pages = Object.fromEntries(Object.keys(dbIds).map((k) => [k, new Map()]));
  const kindByDb = Object.fromEntries(Object.entries(dbIds).map(([k, id]) => [id, k]));
  const state = { requests: 0, fail429: 0, cap: 10_000, queries: 0 };

  const put = (kind, id, properties) => {
    const page = { object: 'page', id, url: `https://notion.so/${id}`, last_edited_time: tick(), properties };
    pages[kind].set(id, page);
    return page;
  };
  const del = (kind, id) => pages[kind].delete(id);

  function matches(page, filter) {
    if (!filter) return true;
    if (filter.or) return filter.or.some((f) => matches(page, f));
    if (filter.and) return filter.and.every((f) => matches(page, f));
    if (filter.timestamp === 'last_edited_time') return page.last_edited_time >= filter.last_edited_time.on_or_after;
    if (filter.property) {
      const d = page.properties[filter.property]?.date?.start ?? null;
      if (filter.date.is_empty) return d == null;
      if (filter.date.after) return d != null && d > filter.date.after;
    }
    throw new Error('filtre non géré ' + JSON.stringify(filter));
  }

  const server = http.createServer(async (req, res) => {
    state.requests++;
    let body = '';
    for await (const c of req) body += c;
    const send = (code, obj, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== 'Bearer secret') return send(401, { code: 'unauthorized', message: 'API token is invalid.' });
    const url = new URL(req.url, 'http://x');
    let m;
    if ((m = url.pathname.match(/^\/v1\/databases\/([^/]+)$/))) {
      const kind = kindByDb[m[1]];
      if (!kind) return send(404, { code: 'object_not_found', message: 'Could not find database' });
      return send(200, { object: 'database', title: [{ plain_text: kind }], data_sources: [{ id: 'ds-' + m[1] }] });
    }
    if ((m = url.pathname.match(/^\/v1\/data_sources\/ds-([^/]+)$/))) {
      const kind = kindByDb[m[1]];
      const properties = Object.fromEntries(
        Object.entries(SCHEMAS[kind]).map(([name, type], i) => [name, { id: `p${i}`, name, type }]),
      );
      return send(200, { object: 'data_source', id: 'ds-' + m[1], properties });
    }
    if ((m = url.pathname.match(/^\/v1\/data_sources\/ds-([^/]+)\/query$/))) {
      if (state.fail429 > 0) {
        state.fail429--;
        return send(429, { code: 'rate_limited', message: 'slow down' }, { 'retry-after': '0' });
      }
      const kind = kindByDb[m[1]];
      const q = JSON.parse(body || '{}');
      if (!q.start_cursor) state.queries++;
      let list = [...pages[kind].values()].filter((p) => matches(p, q.filter));
      list.sort((a, b) => a.last_edited_time.localeCompare(b.last_edited_time) || a.id.localeCompare(b.id));
      list = list.slice(0, state.cap); // Notion : 10 000 résultats max par requête
      const startIdx = q.start_cursor ? Number(q.start_cursor) : 0;
      const size = q.page_size ?? 100;
      const slice = list.slice(startIdx, startIdx + size);
      const more = startIdx + size < list.length;
      return send(200, { object: 'list', results: slice, has_more: more, next_cursor: more ? String(startIdx + size) : null });
    }
    send(404, { code: 'not_found', message: req.url });
  });

  return {
    state,
    put,
    del,
    pages,
    listen: () =>
      new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}/v1`))),
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  };
}

// Jeu de données de démonstration : 2 sujets, 3 sous-sujets, 6 tâches, 451 temps passés.
export function seed(fake) {
  // Référentiel : 2 sujets, 3 sous-sujets, 6 tâches
  fake.put('topics', 'tp1', { Name: P.title('T1'), Sujet: P.text('Sujet A') });
  fake.put('topics', 'tp2', { Name: P.title('T2'), Sujet: P.text('Sujet B') });
  fake.put('subtopics', 's1', { Nom: P.title('SS1'), 'Tags géographique': P.select('France'), 'Tags statut projet ITL': P.select(null), 'Tags CIR/CII': P.multi('CIR') });
  fake.put('subtopics', 's2', { Nom: P.title('SS2'), 'Tags géographique': P.select('Espagne'), 'Tags statut projet ITL': P.select('En cours'), 'Tags CIR/CII': P.multi() });
  fake.put('subtopics', 's3', { Nom: P.title('SS3 "guillemets" l\'apostrophe'), 'Tags géographique': P.select(null), 'Tags statut projet ITL': P.select(null), 'Tags CIR/CII': P.multi('CII', 'cir') });
  for (let i = 1; i <= 6; i++) {
    fake.put('tasks', `t${i}`, {
      'Nom de la tâche': P.title(`Tâche ${i}`),
      'Sous-sujet': P.rel(`s${((i - 1) % 3) + 1}`),
      'Sujet FT': P.rel(i % 2 ? 'tp1' : 'tp2'),
      'Tag géographique (tâche)': P.select(null),
      'Tag statut projet ITL (tâche)': P.select(null),
      'Tag CIR/CII (tâche)': P.multi(...(i === 6 ? ['CII'] : [])),
      'Dernière modif.': { type: 'last_edited_time', last_edited_time: null },
    });
  }
  // 450 temps passés de janvier à mars (5 pages de 100 côté API)
  for (let i = 0; i < 450; i++) {
    const month = (i % 3) + 1; // l0, l3 : janvier ; l1 : février ; l2 : mars
    const day = (i % 28) + 1;
    fake.put('timeLogs', `l${i}`, {
      Description: P.title(''),
      Date: P.date(`2026-0${month}-${String(day).padStart(2, '0')}`),
      'Temps passé': P.num(((i % 8) + 1) * 0.25),
      Personne: P.people(i % 2 ? 'alice@x.fr' : 'bob@x.fr'),
      Tasks: P.rel(`t${(Math.floor(i / 3) % 6) + 1}`),
      Étiquettes: P.multi(),
    });
  }
  fake.put('timeLogs', 'nodate', { Description: P.title(''), Date: P.date(null), 'Temps passé': P.num(1), Personne: P.people('bob@x.fr'), Tasks: P.rel('t1'), Étiquettes: P.multi() });

}
