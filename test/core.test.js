import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeNotion, seed, P } from './fake-notion.js';
import { NotionClient } from '../src/core/notion.js';
import { Store } from '../src/core/store.js';
import { runSync } from '../src/core/sync.js';
import { buildReport, reportToXlsx } from '../src/core/report.js';
import { KINDS, DEFAULT_DATABASES, detectMapping, missingRequired, n8nKey } from '../src/core/mapping.js';

const ids = Object.fromEntries(KINDS.map((k) => [k, DEFAULT_DATABASES[k].id]));
let fake, client, store, dir, databases;

const sum = (rows) => Math.round(rows.reduce((s, r) => s + r.hours, 0) * 100) / 100;
const report = (start, end, extra = {}) => buildReport(store, { start, end, precision: 'task', byPerson: true, ...extra });

before(async () => {
  fake = createFakeNotion(ids);
  seed(fake);
  const baseUrl = await fake.listen();
  client = new NotionClient('secret', { baseUrl, minIntervalMs: 0 });
  dir = mkdtempSync(join(tmpdir(), 'tp-test-'));
  store = new Store(join(dir, 'cache.sqlite'));

  databases = {};
  for (const kind of KINDS) {
    const src = await client.resolveSource(ids[kind]);
    databases[kind] = { id: ids[kind], mapping: detectMapping(kind, src.properties) };
    assert.deepEqual(missingRequired(kind, databases[kind].mapping), [], kind);
  }
});

after(async () => {
  store?.close();
  await fake?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('n8nKey reproduit les noms des anciens workflows', () => {
  assert.equal(n8nKey('Temps passé'), 'temps_pass');
  assert.equal(n8nKey('Tag géographique (tâche)'), 'tag_g_ographique_t_che');
  assert.equal(n8nKey('Étiquettes'), 'tiquettes');
  assert.equal(n8nKey('Dernière modification'), 'derni_re_modification');
  assert.equal(n8nKey('Tags CIR/CII'), 'tags_cir_cii');
  assert.equal(databases.timeLogs.mapping.hours, 'Temps passé');
  assert.equal(databases.tasks.mapping.title, 'Nom de la tâche');
});

test('import initial avec 429 et reprise après interruption', async () => {
  fake.state.cap = 130; // reproduit le plafond Notion (10 000 en vrai) à petite échelle
  fake.state.fail429 = 2;
  const ctrl = new AbortController();
  let batches = 0;
  await assert.rejects(
    runSync({
      store, client, databases, signal: ctrl.signal,
      onProgress: (p) => { if (p.kind === 'timeLogs' && p.phase === 'fetch' && ++batches === 2) ctrl.abort(new Error('stop')); },
    }),
    /stop/,
  );
  const partial = store.counts().timeLogs;
  assert.ok(partial > 0 && partial < 451, `import partiel attendu, obtenu ${partial}`);
  const before = fake.state.requests;
  const res = await runSync({ store, client, databases });
  assert.equal(store.counts().timeLogs, 451);
  assert.ok(fake.state.queries > 5, 'plusieurs tranches de requêtes pour dépasser le plafond');
  // la reprise ne relit pas tout : seulement à partir du watermark (moins la marge)
  assert.ok(res.timeLogs.fetched < 451, `relu ${res.timeLogs.fetched}`);
  assert.ok(fake.state.requests > before);
});

test('rapport : agrégation, précision, tags', async () => {
  const all = report('2026-01-01', '2026-03-31');
  assert.equal(all.entries, 450); // la ligne sans date est exclue
  const byTopic = report('2026-01-01', '2026-03-31', { precision: 'topic', byPerson: false });
  assert.equal(byTopic.rows.length, 2);
  assert.equal(byTopic.totalHours, all.totalHours);
  assert.equal(sum(byTopic.rows), all.totalHours);
  assert.ok(!('offer' in all.rows[0]));
  // tags hérités du sous-sujet, dédoublonnés sans tenir compte de la casse (CII + cir)
  const t3 = all.rows.find((r) => r.task === 'Tâche 3');
  assert.deepEqual(t3.cir.sort(), ['CII', 'cir'].sort());
  assert.equal(t3.subtopic, 'SS3 "guillemets" l\'apostrophe');
  // filtre OU entre catégories
  const f = report('2026-01-01', '2026-03-31', { tags: { cir: ['cii'], geo: ['espagne'] } });
  assert.deepEqual([...new Set(f.rows.map((r) => r.task))].sort(), ['Tâche 2', 'Tâche 3', 'Tâche 5', 'Tâche 6']);
  // sans filtre, les colonnes de tags restent remplies (bug de l'ancien workflow)
  assert.ok(all.rows.some((r) => r.geo.length));
  const buf = await reportToXlsx(f);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
});

test('clôture : les lignes figées ne bougent plus, les conflits sont tracés', async () => {
  const janBefore = report('2026-01-01', '2026-01-31');
  const febBefore = report('2026-02-01', '2026-02-28');
  const preview = store.closurePreview('2026-01-31');
  assert.equal(preview.rows, 150);
  store.closePeriod('2026-01-31');
  assert.equal(store.counts().frozen, 150);
  assert.throws(() => store.closePeriod('2026-01-15'), /déjà clôturée/);

  // Changements côté Notion
  const l0 = fake.pages.timeLogs.get('l0'); // janvier
  fake.put('timeLogs', 'l0', { ...l0.properties, 'Temps passé': P.num(99) });
  fake.put('timeLogs', 'new-jan', { ...l0.properties, Date: P.date('2026-01-10') });
  const l1 = fake.pages.timeLogs.get('l1'); // février -> déplacé en janvier
  fake.put('timeLogs', 'l1', { ...l1.properties, Date: P.date('2026-01-20') });
  const t1 = fake.pages.tasks.get('t1'); // tâche 1 change de sous-sujet
  fake.put('tasks', 't1', { ...t1.properties, 'Sous-sujet': P.rel('s2') });
  fake.put('timeLogs', 'new-apr', { ...l0.properties, Date: P.date('2026-04-02'), 'Temps passé': P.num(2) });

  const res = await runSync({ store, client, databases });
  assert.equal(res.timeLogs.conflicts, 3);
  const kinds = store.listConflicts().map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['created_in_closed', 'modified_in_closed', 'moved_into_closed']);

  const janAfter = report('2026-01-01', '2026-01-31');
  assert.deepEqual(janAfter.rows, janBefore.rows, 'janvier figé, y compris la hiérarchie');
  assert.equal(janAfter.provisionalEntries, 0);
  const febAfter = report('2026-02-01', '2026-02-28');
  assert.notDeepEqual(febAfter.rows, febBefore.rows, 'février suit le changement de sous-sujet');
  assert.ok(febAfter.rows.some((r) => r.task === 'Tâche 1' && r.subtopic === 'SS2'));
  assert.equal(store.counts().timeLogs, 452);

  // une nouvelle synchro ne recrée pas de doublons de conflits
  await runSync({ store, client, databases });
  assert.equal(store.listConflicts().length, 3);
});

test('synchro complète : suppressions hors période clôturée uniquement', async () => {
  fake.del('timeLogs', 'l2'); // mars
  fake.del('timeLogs', 'l3'); // janvier (clôturé) : doit rester
  const res = await runSync({ store, client, databases, mode: 'full' });
  assert.ok(res.timeLogs.fetched < 452, 'la période clôturée n\'est pas relue');
  assert.equal(store.get('timeLogs', 'l2'), undefined);
  assert.ok(store.get('timeLogs', 'l3'));
  assert.equal(store.get('timeLogs', 'l1'), undefined, 'déplacée dans la période clôturée côté Notion');
  assert.ok(store.get('timeLogs', 'nodate'));
  // 452 - l2 (supprimée) - l1 (sortie de la période ouverte) : rien d'autre ne doit disparaître
  assert.equal(store.counts().timeLogs, 450, 'aucune suppression à tort au-delà du plafond Notion');
});

test('réouverture puis resynchro', async () => {
  store.reopenPeriod('2025-12-31');
  assert.equal(store.counts().frozen, 0);
  await runSync({ store, client, databases, mode: 'full' });
  assert.equal(store.get('timeLogs', 'l0').hours, 99);
  assert.ok(store.get('timeLogs', 'new-jan'));
  assert.equal(store.get('timeLogs', 'l3'), undefined);
  assert.equal(store.closureHistory().length, 2);
});

test('calendrier : jours fériés français', async () => {
  const { frenchHolidays, isWorkingDay } = await import('../src/core/calendar.js');
  const h = frenchHolidays(2026);
  for (const d of ['2026-01-01', '2026-04-06', '2026-05-14', '2026-05-25', '2026-07-14', '2026-11-11', '2026-12-25']) {
    assert.ok(h.has(d), d);
  }
  assert.equal(h.size, 11);
  assert.equal(isWorkingDay('2026-11-12'), true);
  assert.equal(isWorkingDay('2026-11-14'), false); // samedi
  assert.equal(isWorkingDay('2026-05-25'), false);
  assert.equal(isWorkingDay('2026-05-25', { pentecostWorked: true }), true);
  assert.equal(isWorkingDay('2026-05-14', { pentecostWorked: true }), false); // Ascension
});

test('stats : temps attendu, couverture et anomalies', async () => {
  const { buildStats, issueRows } = await import('../src/core/stats.js');
  // février 2026 : 20 jours ouvrés, sans jour férié
  store.setTimeSettings({ unit: 'hour', perDay: 7 });
  store.updatePerson('bob@x.fr', { per_day: 3.5 });
  store.updatePerson('Ancien Bot', {}); // identifiant sans e-mail : non suivi par défaut
  store.updatePerson('ghost@x.fr', { start_date: '2026-01-01' }); // suivi mais n'a jamais rien saisi
  const s = buildStats(store, { start: '2026-02-01', end: '2026-02-28', today: '2026-11-12' });
  const by = Object.fromEntries(s.people.map((p) => [p.email, p]));
  assert.equal(by['alice@x.fr'].workDays, 20);
  assert.equal(by['alice@x.fr'].expected, 140);
  assert.equal(by['bob@x.fr'].expected, 70);
  assert.equal(by['ghost@x.fr'].status, 'none');
  assert.equal(s.kpis.peopleSilent, 1);
  assert.equal(s.kpis.peopleCounted, 3);
  assert.equal(by['Ancien Bot'].tracked, false);
  const sumPeople = s.people.reduce((t, p) => t + p.logged, 0);
  const noPerson = s.issues.find((i) => i.key === 'no_person').hours;
  assert.ok(Math.abs(sumPeople + noPerson - s.kpis.totalLogged) < 0.01);
  assert.equal(s.weeks[0], '2026-01-26'); // semaine du 1er février (dimanche)
  const weekTotal = by['alice@x.fr'].weekly.reduce((t, w) => t + w.expected, 0);
  assert.equal(weekTotal, 140);
  // mois en cours : attendu compté jusqu'à aujourd'hui seulement
  const cur = buildStats(store, { start: '2026-02-01', end: '2026-02-28', today: '2026-02-06' });
  assert.equal(cur.people.find((p) => p.email === 'alice@x.fr').workDays, 5);
  // détail d'une anomalie
  const long = s.issues.find((i) => i.key === 'long_day');
  const detail = issueRows(store, { key: 'long_day', start: '2026-02-01', end: '2026-02-28' });
  assert.equal(long.count > 0, detail.total > 0);
  assert.match(detail.rows[0]?.url ?? 'https://www.notion.so/x', /^https:\/\/www\.notion\.so\//);
  // l'instantané figé ne doit pas embarquer les champs techniques
  store.closePeriod('2026-02-28');
  const frozen = JSON.parse(store.db.prepare("SELECT frozen FROM time_logs WHERE frozen IS NOT NULL LIMIT 1").get().frozen);
  assert.ok(!('peopleCount' in frozen) && !('taskKnown' in frozen));
  const after = buildStats(store, { start: '2026-02-01', end: '2026-02-28', today: '2026-11-12' });
  assert.equal(after.kpis.totalLogged, s.kpis.totalLogged);
  assert.equal(after.issues.find((i) => i.key === 'multi_person').count, s.issues.find((i) => i.key === 'multi_person').count);
  // unité "jours" (réglage par défaut) : 1 jour attendu par jour ouvré
  store.setTimeSettings({ unit: 'day', perDay: 1 });
  store.updatePerson('bob@x.fr', { per_day: null });
  const d = buildStats(store, { start: '2026-02-01', end: '2026-02-28', today: '2026-11-12' });
  assert.equal(d.people.find((p) => p.email === 'alice@x.fr').expected, 20);
  assert.equal(d.issues.find((i) => i.key === 'long_day').label, 'Dates avec plus d’une journée saisie');
  assert.equal(buildReport(store, { start: '2026-02-01', end: '2026-02-28', precision: 'task' }).unit, 'day');
});

test('étiquettes et rattachement d’identifiants', async () => {
  const { buildStats } = await import('../src/core/stats.js');
  const uuid = '0661f715-63d5-4693-8b96-2a221dbb330f';
  const base = fake.pages.timeLogs.get('l5').properties; // mars
  fake.put('timeLogs', 'ux1', { ...base, Date: P.date('2026-03-03'), 'Temps passé': P.num(2), Personne: { type: 'people', people: [{ object: 'user', id: uuid }] }, Étiquettes: P.multi('Absent') });
  fake.put('timeLogs', 'ux2', { ...base, Date: P.date('2026-03-04'), 'Temps passé': P.num(1), Personne: P.people('alice@x.fr'), Étiquettes: P.multi('Développement') });
  await runSync({ store, client, databases });

  const ids = store.identities().identities;
  const u = ids.find((i) => i.raw === uuid);
  assert.equal(u.hasEmail, false);
  assert.equal(u.hours, 2);
  assert.ok(u.topSubtopics.length > 0);

  const period = { start: '2026-03-01', end: '2026-03-31', today: '2026-11-12' };
  const s1 = buildStats(store, period);
  assert.equal(s1.labels.list.find((l) => l.label === 'Absent').hours, 2);
  assert.ok(s1.labels.list.some((l) => l.label === '(sans étiquette)'));
  const alice1 = s1.people.find((p) => p.email === 'alice@x.fr').logged;
  assert.equal(s1.people.find((p) => p.email === uuid).tracked, false);

  assert.throws(() => store.setAlias(uuid, 'pas-un-email'), /adresse e-mail/);
  assert.equal(store.setAlias(uuid, ' Alice@X.fr '), 'alice@x.fr');
  const s2 = buildStats(store, period);
  assert.equal(s2.people.find((p) => p.email === 'alice@x.fr').logged, alice1 + 2);
  assert.equal(s2.people.find((p) => p.email === uuid), undefined);
  assert.equal(s2.labels.persons.find((p) => p.email === 'alice@x.fr').values.Absent, 2);
  assert.equal(s2.issues.find((i) => i.key === 'no_email').count, 0);
  const rep = buildReport(store, { ...period, precision: 'task', byPerson: true });
  assert.ok(!rep.rows.some((r) => r.person === uuid), 'rapport : identifiant remplacé par l’e-mail');

  // pas de chaîne de rattachements
  store.setAlias('ancien@x.fr', 'bob@x.fr');
  assert.throws(() => store.setAlias('autre@x.fr', 'ancien@x.fr'), /rattachez directement à bob@x.fr/);

  // clôture : le rapport garde l'identité figée, les stats suivent le rattachement
  store.closePeriod('2026-03-31');
  store.setAlias(uuid, 'bob@x.fr');
  const rep2 = buildReport(store, { ...period, precision: 'task', byPerson: true });
  assert.deepEqual(rep2.rows, rep.rows);
  const s3 = buildStats(store, period);
  assert.equal(s3.people.find((p) => p.email === 'alice@x.fr').logged, alice1);
  store.setAlias(uuid, '');
  assert.equal(store.identities().identities.find((i) => i.raw === uuid).alias, null);
});
