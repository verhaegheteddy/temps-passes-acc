// Test de fumée de l'interface : `npx electron test/ui-smoke.js <dossier-captures>`
// Lance l'app contre un faux Notion, déroule le parcours principal et enregistre des captures.
import { app, BrowserWindow } from 'electron';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeNotion, seed, P } from './fake-notion.js';
import { KINDS, DEFAULT_DATABASES } from '../src/core/mapping.js';

const outDir = process.argv.at(-1).endsWith('.js') ? mkdtempSync(join(tmpdir(), 'tp-shots-')) : process.argv.at(-1);
mkdirSync(outDir, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'tp-ui-'));
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ token: 'secret', tokenEncrypted: false }));

const fake = createFakeNotion(Object.fromEntries(KINDS.map((k) => [k, DEFAULT_DATABASES[k].id])));
seed(fake);
process.env.TP_USER_DATA = userData;
process.env.TP_NOTION_API_URL = await fake.listen();

await import('../src/main/main.js');
app.whenReady().then(scenario).catch((err) => {
  console.error(err);
  app.exit(2);
});

async function scenario() {
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
while (!(win = BrowserWindow.getAllWindows()[0])) await sleep(100);
const wc = win.webContents;
const errors = [];
wc.on('console-message', (e) => {
  if (e.level === 'error' || e.level === 'warning') errors.push(e.message);
});
await new Promise((r) => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
const js = (code) => wc.executeJavaScript(`{${code}\n}; void 0`);
const ask = (expr) => wc.executeJavaScript(expr);
const shot = async (name) => {
  await sleep(400);
  writeFileSync(join(outDir, `${name}.png`), (await wc.capturePage()).toPNG());
};
const waitSyncDone = async () => {
  await sleep(300);
  for (let i = 0; i < 300 && !(await ask(`document.querySelector('#progress').hidden`)); i++) await sleep(100);
};

await js('window.confirm = () => true');
await sleep(800);
await shot('1-parametres-initial');
await js(`document.querySelector('#btn-inspect').click()`);
await sleep(300);
for (let i = 0; i < 200 && (await ask(`document.querySelector('#btn-inspect').disabled`)); i++) await sleep(100);
await shot('2-parametres-bases-lues');
await js(`document.querySelector('#btn-save-dbs').click()`);
await waitSyncDone();

await js(`document.querySelector('[data-tab="report"]').click();
  const f = document.querySelector('#report-form');
  f.start.value = '2026-01-01'; f.end.value = '2026-03-31'; f.precision.value = 'subtopic';
  document.querySelector('.ms-button[data-ms="geo"]').click();
  document.querySelector('.ms-pop[data-ms="geo"] .ms-search').value = 'esp';
  document.querySelector('.ms-pop[data-ms="geo"] .ms-search').dispatchEvent(new Event('input'));
  document.querySelector('.ms-pop[data-ms="geo"] [data-act="all"]').click();
  f.requestSubmit();`);
await sleep(800);
const geoSel = await ask(`document.querySelector('.ms-button[data-ms="geo"] .ms-text').textContent`);
if (geoSel !== 'Espagne') errors.push(`multiselect : « Espagne » attendu, obtenu « ${geoSel} »`);
await shot('3-rapport');
await js(`document.querySelector('.ms-button[data-ms="cir"]').click()`);
await shot('3b-multiselect-ouvert');
await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

await js(`document.querySelector('[data-tab="closures"]').click()`);
await sleep(500);
await js(`document.querySelector('#close-month').value = '2026-01'; document.querySelector('#btn-close-preview').click();`);
await sleep(600);
await shot('4-cloture-apercu');
await js(`document.querySelector('#btn-close-confirm').click()`);
await waitSyncDone();
await sleep(800);
await shot('5-cloture-faite');

const l0 = fake.pages.timeLogs.get('l0');
fake.put('timeLogs', 'l0', { ...l0.properties, 'Temps passé': P.num(42) });
fake.put('timeLogs', 'late', { ...l0.properties, Date: P.date('2026-01-05') });
await js(`document.querySelector('#btn-quick-sync').click()`);
await waitSyncDone();
await js(`document.querySelector('[data-tab="sync"]').click()`);
await sleep(800);
const conflictRows = await ask(`document.querySelectorAll('#conflicts tbody tr').length`);
if (conflictRows !== 2) errors.push(`attendu 2 conflits affichés, obtenu ${conflictRows}`);
await shot('6-synchro-conflits');

await js(`document.querySelector('[data-tab="report"]').click();
  const f = document.querySelector('#report-form');
  f.start.value = '2026-01-01'; f.end.value = '2026-01-31'; f.precision.value = 'topic';
  document.querySelectorAll('.ms-pop [data-act="none"]').forEach(b => b.click());
  f.requestSubmit();`);
await sleep(800);
await shot('7-rapport-definitif');
const total = await ask(`document.querySelector('.summary .num').textContent`);
if (total !== '168,75') errors.push(`total janvier figé attendu 168,75, obtenu ${total}`);

// Étiquettes et identifiant sans e-mail (ancien membre)
const uuid = '0661f715-63d5-4693-8b96-2a221dbb330f';
const lbls = ['Développement', 'Absent', 'Support'];
for (let i = 0; i < 30; i++) {
  const src = fake.pages.timeLogs.get(`l${i * 3 + 2}`); // mars
  fake.put('timeLogs', src.id, { ...src.properties, Étiquettes: P.multi(lbls[i % 3]) });
}
fake.put('timeLogs', 'ux1', {
  ...fake.pages.timeLogs.get('l5').properties,
  Date: P.date('2026-03-03'),
  'Temps passé': P.num(1),
  Personne: { type: 'people', people: [{ object: 'user', id: uuid }] },
  Étiquettes: P.multi('Absent'),
});
await js(`document.querySelector('#btn-quick-sync').click()`);
await waitSyncDone();

await js(`document.querySelector('[data-tab="stats"]').click()`);
await sleep(800);
await js(`const f = document.querySelector('#stats-form');
  f.start.value = '2026-01-01'; f.end.value = '2026-03-31'; f.requestSubmit();`);
await sleep(1000);
await shot('8-stats');
const tiles = await ask(`document.querySelectorAll('#stats-result .tile').length`);
if (tiles !== 7) errors.push(`stats : 7 indicateurs attendus (avec Absences), obtenu ${tiles}`);
const bars = await ask(`document.querySelectorAll('#stats-result .bar-row').length`);
if (bars !== 4) errors.push(`stats : 4 étiquettes attendues (3 + sans étiquette), obtenu ${bars}`);
const barW = await ask(`document.querySelector('#stats-result .bar').style.width`);
if (barW !== '100%') errors.push(`stats : largeur de la 1re barre ${barW}`);
await js(`document.querySelector('#stats-result .bar-row[data-label="Absent"]').click()`);
await sleep(800);
const absRows = await ask(`document.querySelectorAll('#stats-detail tbody tr').length`);
if (absRows !== 11) errors.push(`stats : 11 lignes « Absent » attendues, obtenu ${absRows}`);
await js(`window.scrollTo(0, 0)`);
const heatCells = await ask(`document.querySelectorAll('table.heat td').length`);
if (!heatCells) errors.push('stats : grille de couverture vide');
await js(`document.querySelector('#stats-result [data-issue]')?.click()`);
await sleep(800);
const detailRows = await ask(`document.querySelectorAll('#stats-detail tbody tr').length`);
if (!detailRows) errors.push('stats : détail d’anomalie vide');
await shot('9-stats-detail');
// modification d'une personne : temps partiel
const who = await ask(`document.querySelector('table.people tbody tr').dataset.email`);
await js(`const i = document.querySelector('table.people tr[data-email="${who}"] input[data-f="per_day"]'); i.value = '0.5'; i.dispatchEvent(new Event('change'));`);
await sleep(1000);
const pd = await ask(`document.querySelector('table.people tr[data-email="${who}"] input[data-f="per_day"]').value`);
if (pd !== '0.5') errors.push(`stats : temps partiel non enregistré (${pd})`);
await js(`window.scrollTo(0, 0)`);

const inner = await ask(`[...document.querySelectorAll('main *')].filter((el) => {
  const cs = getComputedStyle(el);
  return /(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
}).map((el) => el.className || el.tagName)`);
if (inner.length) errors.push(`zones défilantes internes : ${inner.join(', ')}`);
const hscroll = await ask(`document.documentElement.scrollWidth > document.documentElement.clientWidth`);
if (hscroll) errors.push('défilement horizontal de la page');
// Onglet Personnes : rattachement de l'UUID
await js(`window.scrollTo(0, 0); document.querySelector('[data-tab="people"]').click()`);
await sleep(800);
await shot('10-personnes');
const idRows = await ask(`document.querySelectorAll('#id-table tr[data-raw]').length`);
if (idRows !== 1) errors.push(`personnes : 1 identifiant sans e-mail attendu, obtenu ${idRows}`);
await js(`const tr = document.querySelector('#id-table tr[data-raw="${uuid}"]');
  tr.querySelector('.alias-input').value = 'Alice@x.fr';
  tr.querySelector('[data-save]').click();`);
await sleep(800);
const alias = await ask(`document.querySelector('#id-table tr[data-raw="${uuid}"] .alias-input')?.value`);
if (alias !== 'alice@x.fr') errors.push(`personnes : rattachement non enregistré (${alias})`);
await shot('11-personnes-rattache');
await js(`document.querySelector('[data-tab="stats"]').click()`);
await sleep(1000);
const uuidInStats = await ask(`document.querySelector('#stats-result').textContent.includes('${uuid}')`);
if (uuidInStats) errors.push('stats : l’UUID rattaché apparaît encore');
await js(`document.querySelector('[data-lmode="share"]').click()`);
await sleep(500);
await js(`document.querySelector('.labels-matrix').scrollIntoView()`);
await shot('12-stats-etiquettes-pct');

console.log(JSON.stringify({ outDir, errors }, null, 2));
await fake.close();
app.exit(errors.length ? 1 : 0);
}
