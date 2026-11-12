import { MultiSelect } from './multiselect.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtH = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtN = new Intl.NumberFormat('fr-FR');
const fmtDate = (d) => (d ? new Date(d + (d.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('fr-FR') : '—');
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthEnd = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return ymd(new Date(y, m, 0));
};
const prevMonth = () => {
  const d = new Date();
  return ymd(new Date(d.getFullYear(), d.getMonth(), 0)).slice(0, 7);
};

const TAG_LABELS = { cir: 'CIR/CII', geo: 'Géographique', itl: 'Statut projet international' };
const LEVEL_LABELS = { topic: 'Sujet', subtopic: 'Sous-sujet', task: 'Tâche' };
const CONFLICT_LABELS = {
  modified_in_closed: 'Modifiée après clôture',
  created_in_closed: 'Créée dans une période clôturée',
  moved_into_closed: 'Déplacée dans une période clôturée',
};
const FIELD_LABELS = { date: 'Date', hours: 'Temps', person: 'Personne', task_id: 'Tâche' };

let S = null; // état renvoyé par le processus principal
let inspected = null; // schéma lu dans Notion (Paramètres)
const unit = () => (S?.timeSettings?.unit === 'hour' ? 'h' : 'j');
const unitWord = () => (S?.timeSettings?.unit === 'hour' ? 'heures' : 'jours');

async function api(name, ...args) {
  const r = await window.api[name](...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

let toastTimer;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (error ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), error ? 9000 : 4000);
}

async function guard(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

const store = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

// ---------------- Onglets ----------------
function showTab(name) {
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of $$('.tab')) s.hidden = s.id !== `tab-${name}`;
  if (name === 'stats' && !statsLoaded) loadStats();
  if (name === 'people') loadIdentities();
  if (name === 'sync') renderConflicts();
  if (name === 'closures') renderClosures();
  if (name === 'settings') renderSettings();
}
for (const b of $$('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));

// ---------------- État global ----------------
async function refreshState() {
  S = await api('getState');
  $('#status-lock').textContent = S.lockedUntil ? `Clôturé jusqu'au ${fmtDate(S.lockedUntil)}` : 'Aucune période clôturée';
  const last = S.syncState.timeLogs?.last_sync;
  $('#status-sync').textContent = last ? `Synchro : ${fmtDateTime(last)}` : 'Jamais synchronisé';
  const badge = $('#conflict-badge');
  badge.hidden = !S.counts.openConflicts;
  badge.textContent = S.counts.openConflicts;
  for (const b of [$('#btn-quick-sync'), $('#btn-sync'), $('#btn-sync-full')]) b.disabled = S.syncing;
  renderSyncTable();
  return S;
}

// ---------------- Synchronisation ----------------
const KIND_LABELS = () => Object.fromEntries(Object.entries(S.defaults).map(([k, v]) => [k, v.label]));

function renderSyncTable() {
  const labels = KIND_LABELS();
  $('#sync-table').innerHTML = `
    <thead><tr><th>Base</th><th class="num">Lignes en cache</th><th>Dernière synchro</th><th>Dernière synchro complète</th></tr></thead>
    <tbody>${Object.keys(labels)
      .map(
        (k) => `<tr><td>${esc(labels[k])}</td><td class="num">${fmtN.format(S.counts[k])}</td>
        <td>${fmtDateTime(S.syncState[k]?.last_sync)}</td><td>${fmtDateTime(S.syncState[k]?.last_full_sync)}</td></tr>`,
      )
      .join('')}</tbody>
    <tfoot><tr><td colspan="4" class="muted">Temps passés figés : ${fmtN.format(S.counts.frozen)} —
      données du ${fmtDate(S.counts.dateMin)} au ${fmtDate(S.counts.dateMax)}</td></tr></tfoot>`;
}

const syncLog = [];
function log(line) {
  syncLog.push(`${new Date().toLocaleTimeString('fr-FR')}  ${line}`);
  if (syncLog.length > 15) syncLog.shift();
  const el = $('#sync-log');
  el.hidden = false;
  el.textContent = syncLog.join('\n');
}

window.api.onSyncProgress((p) => {
  let text;
  if (p.phase === 'retry') text = p.message;
  else if (p.phase === 'schema') text = `${p.label} : lecture du schéma…`;
  else if (p.phase === 'fetch')
    text = `${p.label} : ${fmtN.format(p.fetched)} pages lues${p.conflicts ? ` (${p.conflicts} conflits)` : ''}…`;
  else if (p.phase === 'done') {
    text = `${p.label} : ${fmtN.format(p.fetched)} pages lues${p.full ? `, ${fmtN.format(p.deleted)} supprimées` : ''}${
      p.conflicts ? `, ${p.conflicts} conflits` : ''
    }${p.warning ? ` — ${p.warning}` : ''}`;
    log(text);
  }
  if (text) $('#progress-text').textContent = text;
});

async function startSync(mode) {
  $('#progress').hidden = false;
  $('#progress-text').textContent = 'Démarrage…';
  for (const b of [$('#btn-quick-sync'), $('#btn-sync'), $('#btn-sync-full')]) b.disabled = true;
  log(mode === 'full' ? 'Synchronisation complète' : 'Synchronisation');
  try {
    const res = await api('sync', mode);
    const conflicts = Object.values(res).reduce((s, r) => s + r.conflicts, 0);
    toast(conflicts ? `Synchronisation terminée — ${conflicts} modification(s) ignorée(s) sur une période clôturée.` : 'Synchronisation terminée.');
    loadTags();
    return res;
  } catch (err) {
    log(`Erreur : ${err.message}`);
    toast(err.message, true);
    throw err;
  } finally {
    $('#progress').hidden = true;
    await refreshState();
    if (!$('#tab-sync').hidden) renderConflicts();
  }
}

$('#btn-quick-sync').addEventListener('click', () => startSync('incremental').catch(() => {}));
$('#btn-sync').addEventListener('click', () => startSync('incremental').catch(() => {}));
$('#btn-sync-full').addEventListener('click', () => startSync('full').catch(() => {}));
$('#btn-cancel-sync').addEventListener('click', () => api('cancelSync'));
$('#show-acked').addEventListener('change', renderConflicts);

async function renderConflicts() {
  const list = await api('conflicts', { includeAcknowledged: $('#show-acked').checked });
  const box = $('#conflicts');
  if (!list.length) {
    box.innerHTML = '<p class="muted">Aucun conflit.</p>';
    return;
  }
  const describe = (c) => {
    const d = c.details ?? {};
    if (d.diff)
      return Object.entries(d.diff)
        .map(([k, v]) => `${FIELD_LABELS[k] ?? k} : ${esc(v.cache ?? '—')} → ${esc(v.notion ?? '—')}`)
        .join('<br>');
    return `Date ${fmtDate(d.date)}${d.previousDate ? ` (avant : ${fmtDate(d.previousDate)})` : ''} · ${esc(d.hours ?? '—')} ${unit()} · ${esc(
      d.person ?? '—',
    )}`;
  };
  box.innerHTML = `
    <div class="table-flow"><table class="grid">
      <thead><tr><th><input type="checkbox" id="c-all" /></th><th>Détecté le</th><th>Type</th><th>Détail</th><th>Modifié dans Notion</th><th></th></tr></thead>
      <tbody>${list
        .map(
          (c) => `<tr>
          <td>${c.acknowledged ? '' : `<input type="checkbox" class="c-sel" value="${c.id}" />`}</td>
          <td>${fmtDateTime(c.detected_at)}</td>
          <td>${esc(CONFLICT_LABELS[c.kind] ?? c.kind)}</td>
          <td>${describe(c)}</td>
          <td>${fmtDateTime(c.page_last_edited)}</td>
          <td>${c.details?.url ? `<button class="btn small ghost" data-url="${esc(c.details.url)}">Ouvrir</button>` : ''}</td>
        </tr>`,
        )
        .join('')}</tbody>
    </table></div>
    <div class="actions"><button class="btn" id="btn-ack">Marquer comme vus</button></div>`;
  $('#c-all').addEventListener('change', (e) => $$('.c-sel', box).forEach((c) => (c.checked = e.target.checked)));
  $$('[data-url]', box).forEach((b) => b.addEventListener('click', () => api('openExternal', b.dataset.url)));
  $('#btn-ack').addEventListener('click', (e) =>
    guard(e.target, async () => {
      const ids = $$('.c-sel:checked', box).map((c) => Number(c.value));
      if (!ids.length) return toast('Cochez au moins une ligne.');
      await api('acknowledge', ids);
      await refreshState();
      renderConflicts();
    }),
  );
}

// ---------------- Rapport ----------------
const form = $('#report-form');

function setPreset(p) {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth();
  const ranges = {
    'prev-month': [new Date(y, m - 1, 1), new Date(y, m, 0)],
    'this-month': [new Date(y, m, 1), new Date(y, m + 1, 0)],
    'prev-year': [new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)],
    'this-year': [new Date(y, 0, 1), new Date(y, 11, 31)],
  };
  form.start.value = ymd(ranges[p][0]);
  form.end.value = ymd(ranges[p][1]);
}
$$('[data-preset]').forEach((b) => b.addEventListener('click', () => setPreset(b.dataset.preset)));

// Filtres de tags : une liste à choix multiples par catégorie.
const tagSelects = Object.fromEntries(
  Object.entries(TAG_LABELS).map(([k, label]) => [k, new MultiSelect({ key: k, label: `Tags « ${label} »`, placeholder: 'Pas de filtre' })]),
);
$('#tag-filters').append(...Object.values(tagSelects).map((m) => m.el));

async function loadTags() {
  const values = await api('tagValues');
  const saved = store.get('report')?.tags ?? {};
  for (const [k, ms] of Object.entries(tagSelects)) {
    ms.setOptions(values[k], ms.value.length ? ms.value : saved[k] ?? []);
  }
}

function reportParams() {
  const params = {
    start: form.start.value,
    end: form.end.value,
    precision: form.precision.value,
    byPerson: form.byPerson.checked,
    tags: Object.fromEntries(Object.entries(tagSelects).map(([k, ms]) => [k, ms.value])),
  };
  if (!params.start || !params.end) throw new Error('Choisissez une date de début et de fin.');
  store.set('report', params);
  return params;
}

function renderReport(r) {
  const cols = [...r.levels.map((l) => l.key), ...(r.params.byPerson ? ['person'] : [])];
  const head = [...cols.map((c) => `<th>${c === 'person' ? 'Personne' : LEVEL_LABELS[c]}</th>`), `<th class="num">Temps (${unit()})</th>`, ...Object.values(TAG_LABELS).map((l) => `<th>${esc(l)}</th>`)];
  const cell = (v) => (v == null || v === '' ? '<td class="empty-cell">non renseigné</td>' : `<td>${esc(v)}</td>`);
  const status = r.provisionalEntries
    ? `<div class="banner warn">Rapport <strong>provisoire</strong> : ${fmtN.format(r.provisionalEntries)} ligne(s) sur ${fmtN.format(
        r.entries,
      )} ne sont pas encore clôturées et peuvent encore changer.</div>`
    : r.entries
      ? `<div class="banner ok">Rapport <strong>définitif</strong> : toutes les lignes de cette période sont clôturées.</div>`
      : '';
  $('#report-result').innerHTML = `
    <div class="card">
      ${status}
      <div class="summary">
        <div><div class="num">${fmtH.format(r.totalHours)}</div><div class="lbl">${unitWord()}</div></div>
        <div><div class="num">${fmtN.format(r.entries)}</div><div class="lbl">temps passés</div></div>
        <div><div class="num">${fmtN.format(r.rows.length)}</div><div class="lbl">lignes du rapport</div></div>
      </div>
      ${
        r.rows.length
          ? `<div class="table-flow"><table class="grid">
        <thead><tr>${head.join('')}</tr></thead>
        <tbody>${r.rows
          .map(
            (row) =>
              `<tr>${cols.map((c) => cell(row[c])).join('')}<td class="num">${fmtH.format(row.hours)}</td>${Object.keys(TAG_LABELS)
                .map((k) => cell(row[k].join(', ')))
                .join('')}</tr>`,
          )
          .join('')}</tbody>
        <tfoot><tr><td colspan="${cols.length}">Total</td><td class="num">${fmtH.format(r.totalHours)}</td><td colspan="3"></td></tr></tfoot>
      </table></div>`
          : '<p class="muted">Aucun temps passé ne correspond à ces critères.</p>'
      }
    </div>`;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  guard(e.submitter, async () => renderReport(await api('buildReport', reportParams())));
});
$('#btn-export').addEventListener('click', (e) =>
  guard(e.target, async () => {
    const path = await api('exportReport', reportParams());
    if (path) toast(`Rapport enregistré : ${path}`);
  }),
);

// ---------------- Clôtures ----------------
async function renderClosures() {
  const lock = S.lockedUntil;
  $('#lock-summary').innerHTML = lock
    ? `Période clôturée jusqu'au <strong>${fmtDate(lock)}</strong> inclus.`
    : 'Aucune période n’est clôturée pour le moment.';
  const max = prevMonth();
  const cm = $('#close-month');
  cm.max = max;
  cm.min = lock ? ymd(new Date(new Date(lock + 'T00:00:00').getFullYear(), new Date(lock + 'T00:00:00').getMonth() + 1, 1)).slice(0, 7) : '';
  if (!cm.value || cm.value > max || (cm.min && cm.value < cm.min)) cm.value = max;
  const rm = $('#reopen-month');
  rm.max = lock ? lock.slice(0, 7) : '';
  rm.disabled = $('#btn-reopen').disabled = $('#btn-reopen-all').disabled = !lock;

  const nowY = new Date().getFullYear();
  const firstY = Number((S.counts.dateMin ?? `${nowY - 1}`).slice(0, 4));
  const years = [];
  for (let y = nowY - 1; y >= firstY; y--) if (!lock || `${y}-12-31` > lock) years.push(y);
  $('#close-year').innerHTML = years.map((y) => `<option>${y}</option>`).join('') || '<option value="">—</option>';
  $('#btn-close-year-preview').disabled = !years.length;

  const hist = await api('closureHistory');
  $('#closure-history').innerHTML = hist.length
    ? `<table class="grid"><thead><tr><th>Date</th><th>Action</th><th>Clôturé jusqu'au</th><th>Avant</th><th class="num">Lignes</th><th class="num">Temps</th></tr></thead>
      <tbody>${hist
        .map(
          (h) => `<tr><td>${fmtDateTime(h.at)}</td><td>${h.action === 'close' ? 'Clôture' : 'Réouverture'}</td>
          <td>${fmtDate(h.locked_until)}</td><td>${fmtDate(h.previous)}</td><td class="num">${fmtN.format(h.rows ?? 0)}</td>
          <td class="num">${h.hours != null ? fmtH.format(h.hours) : ''}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">Aucune clôture.</p>';
}

async function previewClosure(until) {
  const p = await api('closurePreview', until);
  $('#close-preview').innerHTML = `
    <div class="banner ${p.withoutTask ? 'warn' : 'ok'}">
      Clôture jusqu'au <strong>${fmtDate(until)}</strong> : ${fmtN.format(p.rows)} temps passés (${fmtH.format(p.hours)} ${unit()})
      ${p.rows ? `du ${fmtDate(p.min)} au ${fmtDate(p.max)}` : ''} seront figés.
      ${p.withoutTask ? `<br>Attention : ${fmtN.format(p.withoutTask)} ligne(s) ne sont rattachées à aucune tâche connue (elles seront figées sans sujet ni sous-sujet).` : ''}
    </div>
    <div class="actions"><button class="btn primary" id="btn-close-confirm">Synchroniser puis clôturer jusqu'au ${fmtDate(until)}</button></div>`;
  $('#btn-close-confirm').addEventListener('click', (e) =>
    guard(e.target, async () => {
      if (!confirm(`Clôturer définitivement jusqu'au ${fmtDate(until)} ?\n\nUne synchronisation complète est d'abord lancée pour partir de données à jour.`)) return;
      await startSync('full');
      const r = await api('closePeriod', until);
      toast(`Période clôturée : ${fmtN.format(r.rows)} lignes figées.`);
      $('#close-preview').innerHTML = '';
      await refreshState();
      renderClosures();
    }),
  );
}

$('#btn-close-preview').addEventListener('click', (e) =>
  guard(e.target, () => {
    if (!$('#close-month').value) throw new Error('Choisissez un mois.');
    return previewClosure(monthEnd($('#close-month').value));
  }),
);
$('#btn-close-year-preview').addEventListener('click', (e) => guard(e.target, () => previewClosure(`${$('#close-year').value}-12-31`)));

async function reopen(until) {
  const what = until ? `tout ce qui suit le ${fmtDate(until)}` : 'toutes les périodes';
  if (!confirm(`Rouvrir ${what} ?\n\nLes rapports déjà publiés sur ces dates pourront changer.`)) return;
  if (!confirm('Confirmez une seconde fois la réouverture.')) return;
  const r = await api('reopenPeriod', until);
  toast(`${fmtN.format(r.rows)} lignes rouvertes. Synchronisation complète en cours…`);
  await refreshState();
  renderClosures();
  await startSync('full').catch(() => {});
}
$('#btn-reopen').addEventListener('click', (e) =>
  guard(e.target, () => {
    if (!$('#reopen-month').value) throw new Error('Choisissez un mois.');
    return reopen(monthEnd($('#reopen-month').value));
  }),
);
$('#btn-reopen-all').addEventListener('click', (e) => guard(e.target, () => reopen(null)));

// ---------------- Paramètres ----------------
function renderSettings() {
  $('#token-status').textContent = S.token.hasToken
    ? `Token enregistré${S.token.encrypted ? ' (chiffré par le trousseau du système)' : ' (non chiffré : trousseau système indisponible)'}.`
    : 'Aucun token enregistré.';
  $('#data-path').textContent = `Cache et paramètres : ${S.dataPath}`;
  renderDbForm();
}

function renderDbForm() {
  const labels = KIND_LABELS();
  $('#db-form').innerHTML = Object.keys(labels)
    .map((kind) => {
      const saved = S.databases[kind];
      const info = inspected?.[kind];
      const mapping = info?.mapping ?? saved.mapping ?? {};
      const fields = S.fields[kind];
      const options = (field) => {
        const props = info?.properties ?? (mapping[field] ? [{ name: mapping[field], type: '' }] : []);
        return `<option value="">— non associée —</option>${props
          .map((p) => `<option value="${esc(p.name)}" ${p.name === mapping[field] ? 'selected' : ''}>${esc(p.name)}${p.type ? ` (${esc(p.type)})` : ''}</option>`)
          .join('')}`;
      };
      return `<div class="db-block" data-kind="${kind}">
        <h3>${esc(labels[kind])} ${info?.title ? `<span class="muted">→ ${esc(info.title)}</span>` : ''}</h3>
        ${info?.error ? `<div class="banner error">${esc(info.error)}</div>` : ''}
        ${info?.missing?.length ? `<div class="banner warn">Propriétés obligatoires non trouvées : ${esc(info.missing.join(', '))}</div>` : ''}
        ${info?.multipleSources ? '<div class="banner warn">Cette base contient plusieurs sources de données : seule la première est utilisée.</div>' : ''}
        <label>Identifiant ou URL de la base <input name="id" value="${esc(info?.id ?? saved.id)}" /></label>
        <div class="map-grid">${Object.entries(fields)
          .map(
            ([field, def]) =>
              `<label><span>${esc(def.label)}${def.required ? ' <span class="req">*</span>' : ''}</span><select data-field="${field}">${options(field)}</select></label>`,
          )
          .join('')}</div>
      </div>`;
    })
    .join('');
}

function collectDbForm() {
  return Object.fromEntries(
    $$('#db-form .db-block').map((b) => [
      b.dataset.kind,
      {
        id: $('input[name="id"]', b).value.trim(),
        mapping: Object.fromEntries($$('select[data-field]', b).map((s) => [s.dataset.field, s.value || null])),
      },
    ]),
  );
}

$('#token-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guard(e.submitter, async () => {
    await api('setToken', e.target.token.value);
    e.target.token.value = '';
    await refreshState();
    renderSettings();
    toast('Token enregistré. Lecture des bases…');
    await inspect();
  });
});

async function inspect() {
  inspected = await api('inspect', collectDbForm());
  renderDbForm();
  const errors = Object.values(inspected).filter((i) => i.error || i.missing?.length).length;
  toast(errors ? 'Certaines bases demandent votre attention.' : 'Bases lues : vérifiez les correspondances puis enregistrez.', !!errors);
}
$('#btn-inspect').addEventListener('click', (e) => guard(e.target, inspect));

$('#btn-save-dbs').addEventListener('click', (e) =>
  guard(e.target, async () => {
    await api('setDatabases', collectDbForm());
    await refreshState();
    toast(S.configured ? 'Paramètres enregistrés.' : 'Enregistré, mais des propriétés obligatoires ne sont pas associées.', !S.configured);
    if (S.configured && !S.syncState.timeLogs?.last_sync) startSync('incremental').catch(() => {});
  }),
);
$('#btn-data-folder').addEventListener('click', () => api('openDataFolder'));

// ---------------- Stats ----------------
let statsLoaded = false;
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
let lastStats = null;
const sForm = $('#stats-form');
const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)} %`);
const STATUS = {
  ok: { icon: '✓', label: 'OK', cls: 'st-ok' },
  partial: { icon: '◐', label: 'Partiel', cls: 'st-warn' },
  low: { icon: '!', label: 'Faible', cls: 'st-bad' },
  none: { icon: '✕', label: 'Rien saisi', cls: 'st-bad' },
  ignored: { icon: '–', label: 'Non suivi', cls: 'st-muted' },
};
const statusBadge = (p) => {
  const st = p.inactive ? { icon: '–', label: 'Inactif', cls: 'st-muted' } : STATUS[p.status];
  return `<span class="status-tag ${st.cls}"><span class="st-icon" aria-hidden="true">${st.icon}</span>${st.label}</span>`;
};
// Couverture -> classe de couleur (rampe séquentielle, 6 paliers)
const covBin = (logged, expected) => {
  if (!expected) return null;
  const r = logged / expected;
  return r <= 0 ? 0 : r < 0.25 ? 1 : r < 0.5 ? 2 : r < 0.75 ? 3 : r < 0.9 ? 4 : 5;
};

function setStatsPreset(p) {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth();
  const ranges = {
    'prev-month': [new Date(y, m - 1, 1), new Date(y, m, 0)],
    'this-month': [new Date(y, m, 1), new Date(y, m + 1, 0)],
    'last-3': [new Date(y, m - 3, 1), new Date(y, m, 0)],
    'prev-year': [new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)],
    'this-year': [new Date(y, 0, 1), new Date(y, 11, 31)],
  };
  sForm.start.value = ymd(ranges[p][0]);
  sForm.end.value = ymd(ranges[p][1]);
}
$$('[data-spreset]').forEach((b) =>
  b.addEventListener('click', () => {
    setStatsPreset(b.dataset.spreset);
    loadStats();
  }),
);
sForm.addEventListener('submit', (e) => {
  e.preventDefault();
  guard(e.submitter, loadStats);
});

function fillTimeSettings() {
  const f = $('#time-settings');
  f.unit.value = S.timeSettings.unit;
  f.perDay.value = S.timeSettings.perDay;
  f.pentecostWorked.checked = S.timeSettings.pentecostWorked;
}
$('#time-settings').addEventListener('submit', (e) => {
  e.preventDefault();
  guard(e.submitter, async () => {
    const f = e.target;
    await api('setTimeSettings', { unit: f.unit.value, perDay: Number(f.perDay.value), pentecostWorked: f.pentecostWorked.checked });
    await refreshState();
    fillTimeSettings();
    toast('Réglages enregistrés.');
    await loadStats();
  });
});

async function loadStats() {
  statsLoaded = true;
  if (!sForm.start.value) setStatsPreset('prev-month');
  fillTimeSettings();
  store.set('stats', { start: sForm.start.value, end: sForm.end.value });
  try {
    lastStats = await api('buildStats', { start: sForm.start.value, end: sForm.end.value });
    renderStats(lastStats);
  } catch (err) {
    $('#stats-result').innerHTML = `<div class="card"><div class="banner error">${esc(err.message)}</div></div>`;
  }
}

function tile(value, label, sub = '', tone = '') {
  return `<div class="tile ${tone}"><div class="num">${value}</div><div class="lbl">${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

function renderStats(st) {
  const k = st.kpis;
  const u = unit();
  const showAll = store.get('statsShowAll') ?? false;
  const people = st.people.filter((p) => showAll || p.counted);
  const hidden = st.people.length - st.people.filter((p) => p.counted).length;
  const covTone = k.coverage == null ? '' : k.coverage >= 0.9 ? 'tone-ok' : k.coverage >= 0.7 ? 'tone-warn' : 'tone-bad';
  const absence = st.labels.list.find((l) => /absen/i.test(l.label));

  const kpis = `
    <div class="tiles">
      ${tile(pct(k.coverage), 'Couverture', `${fmtH.format(k.countedLogged)} ${u} saisis / ${fmtH.format(k.totalExpected)} ${u} attendus`, covTone)}
      ${absence ? tile(`${fmtH.format(absence.hours)} ${u}`, 'Absences', `${pct(absence.share)} du temps saisi · étiquette « ${esc(absence.label)} »`) : ''}
      ${tile(`${k.peopleLogged} / ${k.peopleCounted}`, 'Personnes ayant saisi', `${k.peopleKnown} personnes connues dans Notion`)}
      ${tile(fmtN.format(k.peopleSilent), 'Personnes sans aucune saisie', 'parmi les personnes suivies', k.peopleSilent ? 'tone-bad' : 'tone-ok')}
      ${tile(pct(k.noTaskShare), 'Temps sans tâche', `${fmtN.format(k.noTaskEntries)} lignes · ${fmtH.format(k.noTaskHours)} ${u}`, k.noTaskShare > 0.1 ? 'tone-warn' : '')}
      ${tile(fmtN.format(k.noDateEntries), 'Temps sans date', 'tout historique, absents des rapports', k.noDateEntries ? 'tone-warn' : '')}
      ${tile(fmtN.format(k.openConflicts), 'Conflits non vus', 'modifs sur périodes clôturées', k.openConflicts ? 'tone-warn' : '')}
    </div>
    <p class="hint">Période du ${fmtDate(st.params.start)} au ${fmtDate(st.params.end)} · temps attendu compté jusqu'au ${fmtDate(st.params.expectedUntil)} ·
      ${fmtH.format(st.settings.perDay)} ${u} par jour ouvré · total saisi sur la période : ${fmtH.format(k.totalLogged)} ${u} (${fmtN.format(k.entries)} lignes) ·
      dernière synchro ${fmtDateTime(k.lastSync)}</p>`;

  const personRows = people
    .map(
      (p) => `<tr class="${p.counted ? '' : 'dim'}" data-email="${esc(p.email)}">
      <td><button class="link" data-person="${esc(p.email)}">${esc(p.email)}</button>${p.hasEmail ? '' : ' <span class="muted small">(sans e-mail)</span>'}</td>
      <td>${statusBadge(p)}</td>
      <td class="num">${fmtH.format(p.logged)}</td>
      <td class="num">${fmtH.format(p.expected)}</td>
      <td class="num ${p.gap < 0 ? 'neg' : ''}">${p.gap > 0 ? '+' : ''}${fmtH.format(p.gap)}</td>
      <td class="num">${pct(p.rate)}</td>
      <td class="num">${p.daysLogged} / ${p.workDays}</td>
      <td>${fmtDate(p.lastLog)}</td>
      <td class="num">${p.noTaskHours ? fmtH.format(p.noTaskHours) : ''}</td>
      <td class="edit"><input type="checkbox" data-f="tracked" ${p.tracked ? 'checked' : ''} title="Suivre cette personne" /></td>
      <td class="edit"><input type="number" data-f="per_day" step="0.05" min="0" value="${p.perDay ?? ''}" placeholder="${fmtH.format(st.settings.perDay)}" /></td>
      <td class="edit"><input type="date" data-f="start_date" value="${p.startDate ?? ''}" /></td>
      <td class="edit"><input type="date" data-f="end_date" value="${p.endDate ?? ''}" /></td>
    </tr>`,
    )
    .join('');

  const heat = st.people.filter((p) => p.counted);
  const showVals = st.weeks.length <= 16;
  const heatmap = heat.length
    ? `<div class="heat-flow"><table class="heat">
        <colgroup><col class="who" />${st.weeks.map(() => '<col />').join('')}</colgroup>
        <thead><tr><th></th>${st.weeks
          .map((w, i) => {
            // Beaucoup de semaines : on n'affiche que la première semaine de chaque mois.
            const show = st.weeks.length <= 20 || i === 0 || w.slice(5, 7) !== st.weeks[i - 1].slice(5, 7);
            const lbl = st.weeks.length <= 20 ? `${w.slice(8, 10)}/${w.slice(5, 7)}` : MONTHS[Number(w.slice(5, 7)) - 1];
            return `<th title="Semaine du ${fmtDate(w)}">${show ? lbl : ''}</th>`;
          })
          .join('')}</tr></thead>
        <tbody>${heat
          .map(
            (p) => `<tr><th>${esc(p.email.replace(/@.*/, ''))}</th>${p.weekly
              .map((c) => {
                const b = covBin(c.logged, c.expected);
                const tip = `${p.email} · semaine du ${fmtDate(c.week)} : ${fmtH.format(c.logged)} ${u} saisis / ${fmtH.format(c.expected)} ${u} attendus${c.expected ? ` (${pct(c.logged / c.expected)})` : ''}`;
                return `<td class="${b == null ? 'cov-na' : `cov-${b}`}" data-tip="${esc(tip)}">${
                  showVals && b != null ? Math.round((c.logged / c.expected) * 100) : ''
                }</td>`;
              })
              .join('')}</tr>`,
          )
          .join('')}</tbody></table></div>
      <div class="heat-legend"><span>Couverture :</span>${['0 %', '< 25 %', '< 50 %', '< 75 %', '< 90 %', '≥ 90 %']
        .map((l, i) => `<span class="sw cov-${i}"></span><span>${l}</span>`)
        .join('')}<span class="sw cov-na"></span><span>rien d'attendu</span></div>`
    : '<p class="muted">Aucune personne suivie sur la période.</p>';

  const labelsCard = renderLabels(st, showAll);

  const issues = st.issues
    .map(
      (i) => `<tr>
      <td>${esc(i.label)}<div class="muted small">${esc(i.hint)}</div></td>
      <td class="num">${fmtN.format(i.count)}</td>
      <td class="num">${i.hours ? `${fmtH.format(i.hours)} ${u}` : ''}</td>
      <td>${i.count ? `<button class="btn small" data-issue="${i.key}">Voir</button>` : '<span class="st-ok">✓</span>'}</td>
    </tr>`,
    )
    .join('');

  $('#stats-result').innerHTML = `
    <div class="card">${kpis}</div>
    ${labelsCard}
    <div class="card">
      <div class="card-head">
        <h2>Par personne</h2>
        <label class="check"><input type="checkbox" id="stats-show-all" ${showAll ? 'checked' : ''}/> Afficher les personnes non suivies ou inactives (${hidden})</label>
      </div>
      <div class="table-flow"><table class="grid people">
        <thead><tr><th>Personne</th><th>Statut</th><th class="num">Saisi (${u})</th><th class="num">Attendu (${u})</th><th class="num">Écart</th>
          <th class="num">Taux</th><th class="num">Jours saisis / ouvrés</th><th>Dernière saisie</th><th class="num">Sans tâche (${u})</th>
          <th>Suivi</th><th>Attendu/jour</th><th>Arrivée</th><th>Départ</th></tr></thead>
        <tbody>${personRows || '<tr><td colspan="13" class="muted">Aucune personne.</td></tr>'}</tbody>
      </table></div>
      <p class="hint">Inactif = aucune saisie depuis plus de 60 jours avant la période et pas de date de départ : renseignez une date de départ ou décochez « Suivi ». Les identifiants sans e-mail (anciens membres, bots) ne sont pas suivis par défaut.</p>
    </div>
    <div class="card">
      <h2>Couverture par semaine</h2>
      ${heatmap}
    </div>
    <div class="card">
      <h2>Qualité des données</h2>
      <table class="grid"><thead><tr><th>Anomalie</th><th class="num">Nombre</th><th class="num">Temps</th><th></th></tr></thead><tbody>${issues}</tbody></table>
    </div>
    <div id="stats-detail"></div>`;

  $('#stats-show-all').addEventListener('change', (e) => {
    store.set('statsShowAll', e.target.checked);
    renderStats(lastStats);
  });
  $$('[data-issue]').forEach((b) => b.addEventListener('click', () => guard(b, () => showDetail({ key: b.dataset.issue }))));
  $$('[data-person]').forEach((b) => b.addEventListener('click', () => guard(b, () => showDetail({ email: b.dataset.person }))));
  $$('[data-label]').forEach((b) =>
    b.addEventListener('click', () => guard(null, () => showDetail({ label: b.dataset.label, email: b.dataset.labelPerson }))),
  );
  $$('.bar[data-w]').forEach((b) => (b.style.width = `${b.dataset.w}%`));
  $$('[data-lmode]').forEach((b) =>
    b.addEventListener('click', () => {
      store.set('labelsMode', b.dataset.lmode);
      renderStats(lastStats);
    }),
  );
  $$('table.people td.edit input').forEach((input) =>
    input.addEventListener('change', () =>
      guard(null, async () => {
        const email = input.closest('tr').dataset.email;
        const f = input.dataset.f;
        const value = f === 'tracked' ? input.checked : f === 'per_day' ? (input.value === '' ? null : Number(input.value)) : input.value || null;
        await api('updatePerson', email, { [f]: value });
        const scroll = window.scrollY;
        await loadStats();
        window.scrollTo(0, scroll);
      }),
    ),
  );
}

// Temps par étiquette : barres au global, matrice personne × étiquette.
const shareBin = (s) => (s <= 0 ? null : s < 0.05 ? 0 : s < 0.15 ? 1 : s < 0.3 ? 2 : s < 0.5 ? 3 : s < 0.75 ? 4 : 5);
function renderLabels(st, showAll) {
  const u = unit();
  const { list, persons } = st.labels;
  if (!list.length) return '';
  const mode = store.get('labelsMode') === 'share' ? 'share' : 'value';
  const max = Math.max(...list.map((l) => l.hours), 0.0001);
  const bars = list
    .map(
      (l) => `<button type="button" class="bar-row" data-label="${esc(l.label)}"
        data-tip="${esc(`${l.label} : ${fmtH.format(l.hours)} ${u} · ${fmtN.format(l.entries)} lignes · ${pct(l.share)} du temps saisi`)}">
        <span class="bar-label">${esc(l.label)}</span>
        <span class="bar-track"><span class="bar" data-w="${((l.hours / max) * 100).toFixed(2)}"></span></span>
        <span class="bar-value">${fmtH.format(l.hours)} ${u}<span class="muted"> · ${pct(l.share)}</span></span>
      </button>`,
    )
    .join('');
  const rows = persons.filter((p) => showAll || p.counted);
  const matrix = rows.length
    ? `<table class="grid labels-matrix">
      <thead><tr><th>Personne</th><th class="num">Total (${u})</th>${list.map((l) => `<th class="num">${esc(l.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows
        .map(
          (p) => `<tr><td>${esc(p.email)}</td><td class="num">${fmtH.format(p.total)}</td>${list
            .map((l) => {
              const h = p.values[l.label] ?? 0;
              if (!h) return '<td></td>';
              const share = p.total ? h / p.total : 0;
              const b = shareBin(share);
              return `<td class="num cell cov-${b}" data-label="${esc(l.label)}" data-label-person="${esc(p.email)}"
                data-tip="${esc(`${p.email} · ${l.label} : ${fmtH.format(h)} ${u} (${pct(share)} de son temps)`)}">${
                  mode === 'share' ? pct(share) : fmtH.format(h)
                }</td>`;
            })
            .join('')}</tr>`,
        )
        .join('')}</tbody></table>
      <div class="heat-legend"><span>Part du temps de la personne :</span>${['< 5 %', '< 15 %', '< 30 %', '< 50 %', '< 75 %', '≥ 75 %']
        .map((l, i) => `<span class="sw cov-${i}"></span><span>${l}</span>`)
        .join('')}</div>`
    : '<p class="muted">Aucune personne.</p>';
  return `<div class="card">
    <div class="card-head"><h2>Temps par étiquette</h2></div>
    <div class="bars">${bars}</div>
    <div class="card-head sub-head"><h3>Par personne</h3>
      <div class="seg" role="group" aria-label="Affichage">
        <button type="button" class="btn small ${mode === 'value' ? 'active' : 'ghost'}" data-lmode="value">Temps (${u})</button>
        <button type="button" class="btn small ${mode === 'share' ? 'active' : 'ghost'}" data-lmode="share">% de son temps</button>
      </div>
    </div>
    ${matrix}
    <p class="hint">Cliquez sur une barre ou une case pour voir les lignes concernées.</p>
  </div>`;
}

async function showDetail({ key, email, label }) {
  const { start, end } = lastStats.params;
  const res = await api('issueRows', { key, email, label, start, end });
  const title = key
    ? lastStats.issues.find((i) => i.key === key).label
    : label
      ? `Étiquette « ${label} »${email ? ` — ${email}` : ''}`
      : `Temps passés de ${email}`;
  const u = unit();
  $('#stats-detail').innerHTML = `<div class="card">
    <div class="card-head"><h2>${esc(title)} <span class="muted">(${fmtN.format(res.total)} lignes${res.total > res.rows.length ? `, ${res.rows.length} affichées` : ''})</span></h2>
      <button class="btn small ghost" id="close-detail">Fermer</button></div>
    <div class="table-flow"><table class="grid">
      <thead><tr><th>Date</th><th>Personne</th><th class="num">Temps (${u})</th><th>Étiquette</th><th>Tâche</th><th>Sous-sujet</th><th>Sujet</th><th></th></tr></thead>
      <tbody>${res.rows
        .map(
          (r) => `<tr><td>${fmtDate(r.date)}</td><td>${esc(r.person ?? '')}</td><td class="num">${r.hours != null ? fmtH.format(r.hours) : ''}</td>
          <td>${esc((r.labels ?? []).join(', '))}</td>
          <td>${r.task ? esc(r.task) : '<span class="empty-cell">—</span>'}</td><td>${esc(r.subtopic ?? '')}</td><td>${esc(r.topic ?? '')}</td>
          <td><button class="btn small ghost" data-url="${esc(r.url)}">Notion</button></td></tr>`,
        )
        .join('')}</tbody></table></div></div>`;
  $('#close-detail').addEventListener('click', () => ($('#stats-detail').innerHTML = ''));
  $$('#stats-detail [data-url]').forEach((b) => b.addEventListener('click', () => api('openExternal', b.dataset.url)));
  $('#stats-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Infobulle de la grille de couverture
const tip = document.createElement('div');
tip.className = 'tooltip';
tip.hidden = true;
document.body.append(tip);
document.addEventListener('mouseover', (e) => {
  const cell = e.target.closest('[data-tip]');
  if (!cell) return void (tip.hidden = true);
  tip.textContent = cell.dataset.tip;
  tip.hidden = false;
});
document.addEventListener('mousemove', (e) => {
  if (tip.hidden) return;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${e.clientY + 16}px`;
});

// ---------------- Personnes (rattachement des identifiants) ----------------
let identities = null;
const idFilter = $('#id-filter');
const idOnlyMissing = $('#id-only-missing');
try {
  idOnlyMissing.checked = store.get('idOnlyMissing') ?? true;
} catch {}

async function loadIdentities() {
  identities = await api('identities');
  renderIdentities();
}

function renderIdentities() {
  if (!identities) return;
  const u = unit();
  const q = idFilter.value.trim().toLowerCase();
  const list = identities.identities
    .filter((i) => !idOnlyMissing.checked || !i.hasEmail || i.alias)
    .filter((i) => !q || `${i.raw} ${i.alias ?? ''} ${i.topSubtopics.join(' ')}`.toLowerCase().includes(q))
    .sort((a, b) => Number(a.hasEmail) - Number(b.hasEmail) || b.hours - a.hours);
  const known = [...new Set(identities.identities.flatMap((i) => [i.hasEmail ? i.raw : null, i.alias]).filter(Boolean))].sort();
  $('#known-emails').innerHTML = known.map((e) => `<option value="${esc(e)}"></option>`).join('');
  const np = identities.noPerson;
  $('#id-summary').textContent =
    `${identities.identities.length} identifiants, dont ${identities.identities.filter((i) => !i.hasEmail).length} sans e-mail et ` +
    `${identities.identities.filter((i) => i.alias).length} rattachés.` +
    (np.n ? ` ${fmtN.format(np.n)} temps passés n'ont aucune personne (${fmtH.format(np.hours)} ${u}) : à corriger dans Notion.` : '');
  $('#id-table').innerHTML = list.length
    ? `<table class="grid ids">
      <thead><tr><th>Identifiant Notion</th><th class="num">Lignes</th><th class="num">Temps (${u})</th><th>Période</th><th>Sous-sujets principaux</th><th>Rattaché à</th><th></th></tr></thead>
      <tbody>${list
        .map(
          (i) => `<tr data-raw="${esc(i.raw)}">
          <td><code>${esc(i.raw)}</code>${i.hasEmail ? '' : '<div class="muted small">sans e-mail : ancien membre ou bot</div>'}</td>
          <td class="num">${fmtN.format(i.entries)}</td>
          <td class="num">${fmtH.format(i.hours)}</td>
          <td>${fmtDate(i.first_log)} → ${fmtDate(i.last_log)}</td>
          <td class="small">${esc(i.topSubtopics.join(' · ')) || '<span class="muted">—</span>'}</td>
          <td><input type="email" class="alias-input" list="known-emails" placeholder="prenom.nom@…" value="${esc(i.alias ?? '')}" /></td>
          <td class="actions-cell">
            <button class="btn small primary" data-save>Enregistrer</button>
            ${i.alias ? '<button class="btn small ghost" data-unlink>Retirer</button>' : ''}
          </td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">Aucun identifiant ne correspond.</p>';
  const save = (tr, value) =>
    guard(tr.querySelector('[data-save]'), async () => {
      const email = await api('setAlias', tr.dataset.raw, value);
      statsLoaded = false;
      toast(email ? `${tr.dataset.raw} rattaché à ${email}.` : 'Rattachement retiré.');
      await loadIdentities();
    });
  $$('#id-table tr[data-raw]').forEach((tr) => {
    tr.querySelector('[data-save]').addEventListener('click', () => save(tr, tr.querySelector('.alias-input').value));
    tr.querySelector('.alias-input').addEventListener('keydown', (e) => e.key === 'Enter' && save(tr, e.target.value));
    tr.querySelector('[data-unlink]')?.addEventListener('click', () => save(tr, ''));
  });
}
idFilter.addEventListener('input', renderIdentities);
idOnlyMissing.addEventListener('change', () => {
  store.set('idOnlyMissing', idOnlyMissing.checked);
  renderIdentities();
});

// ---------------- Démarrage ----------------
(async () => {
  try {
    await refreshState();
    const saved = store.get('report');
    if (saved?.start) {
      form.start.value = saved.start;
      form.end.value = saved.end;
      form.precision.value = LEVEL_LABELS[saved.precision] ? saved.precision : 'task';
      form.byPerson.checked = saved.byPerson;
    } else setPreset('prev-month');
    const savedStats = store.get('stats');
    if (savedStats?.start) {
      sForm.start.value = savedStats.start;
      sForm.end.value = savedStats.end;
    } else setStatsPreset('prev-month');
    await loadTags();
    if (!S.token.hasToken || !S.configured) {
      showTab('settings');
      toast('Configurez le token Notion et les bases pour commencer.');
    } else {
      startSync('incremental').catch(() => {});
    }
  } catch (err) {
    toast(err.message, true);
  }
})();
