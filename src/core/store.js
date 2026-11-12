// Cache local SQLite (node:sqlite, intégré à Node/Electron : aucun module natif).
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sync_state (
  kind TEXT PRIMARY KEY, watermark TEXT, last_sync TEXT, last_full_sync TEXT
);
DROP TABLE IF EXISTS offers; -- base « Offres Accenta » supprimée
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY, name TEXT, last_edited TEXT, seen_run INTEGER
);
CREATE TABLE IF NOT EXISTS subtopics (
  id TEXT PRIMARY KEY, name TEXT,
  tags_cir TEXT, tags_geo TEXT, tags_itl TEXT, last_edited TEXT, seen_run INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, name TEXT, subtopic_id TEXT, topic_id TEXT,
  tags_cir TEXT, tags_geo TEXT, tags_itl TEXT, last_edited TEXT, seen_run INTEGER
);
CREATE TABLE IF NOT EXISTS time_logs (
  id TEXT PRIMARY KEY, date TEXT, hours REAL, person TEXT, people TEXT, labels TEXT,
  task_id TEXT, last_edited TEXT, seen_run INTEGER,
  frozen TEXT -- instantané figé à la clôture (JSON), NULL si période ouverte
);
CREATE INDEX IF NOT EXISTS time_logs_date ON time_logs(date);
CREATE INDEX IF NOT EXISTS time_logs_task ON time_logs(task_id);
CREATE TABLE IF NOT EXISTS conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL, kind TEXT NOT NULL, page_last_edited TEXT,
  detected_at TEXT NOT NULL, details TEXT, acknowledged INTEGER NOT NULL DEFAULT 0,
  UNIQUE (page_id, kind, page_last_edited)
);
CREATE TABLE IF NOT EXISTS people (
  email TEXT PRIMARY KEY,
  per_day REAL,            -- temps attendu par jour ouvré (NULL = valeur par défaut)
  start_date TEXT,         -- arrivée (NULL = pas de limite)
  end_date TEXT,           -- départ (NULL = pas de limite)
  tracked INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS person_aliases (
  raw TEXT PRIMARY KEY,    -- identifiant tel que fourni par Notion (UUID d'un ancien membre, nom d'un bot, ancien e-mail…)
  email TEXT NOT NULL,     -- personne à laquelle on le rattache
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS closures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL, locked_until TEXT, previous TEXT, at TEXT NOT NULL,
  rows INTEGER, hours REAL
);
`;

const TABLES = {
  topics: { table: 'topics', cols: ['name'] },
  subtopics: { table: 'subtopics', cols: ['name', 'tags_cir', 'tags_geo', 'tags_itl'] },
  tasks: { table: 'tasks', cols: ['name', 'subtopic_id', 'topic_id', 'tags_cir', 'tags_geo', 'tags_itl'] },
  timeLogs: { table: 'time_logs', cols: ['date', 'hours', 'person', 'people', 'labels', 'task_id'] },
};

const JSON_COLS = new Set(['tags_cir', 'tags_geo', 'tags_itl', 'people', 'labels']);

const RESOLVE_SQL = `
SELECT tl.id, tl.date, tl.hours, COALESCE(pa.email, tl.person) AS person, tl.person AS raw_person, tl.people, tl.labels, tl.task_id, tl.frozen,
  t.id IS NOT NULL AS task_known, t.name AS task, t.tags_cir AS t_cir, t.tags_geo AS t_geo, t.tags_itl AS t_itl,
  s.name AS subtopic, s.tags_cir AS s_cir, s.tags_geo AS s_geo, s.tags_itl AS s_itl,
  tp.name AS topic
FROM time_logs tl
LEFT JOIN person_aliases pa ON pa.raw = tl.person
LEFT JOIN tasks t ON t.id = tl.task_id
LEFT JOIN subtopics s ON s.id = t.subtopic_id
LEFT JOIN topics tp ON tp.id = t.topic_id`;

function unionTags(...lists) {
  const seen = new Map();
  for (const json of lists) {
    for (const v of json ? JSON.parse(json) : []) {
      const k = v.toLowerCase();
      if (!seen.has(k)) seen.set(k, v);
    }
  }
  return [...seen.values()];
}

// Ligne jointe -> ligne "résolue" (hiérarchie + tags). Pour une ligne figée, on renvoie l'instantané.
// Champs "techniques" ajoutés à chaque ligne, jamais enregistrés dans l'instantané figé :
// livePerson = personne après rattachement (utilisée par les stats, même sur une période clôturée).
export function resolveRow(r) {
  const extra = {
    peopleCount: r.people ? JSON.parse(r.people).length : 0,
    labels: r.labels ? JSON.parse(r.labels) : [],
    livePerson: r.person ?? null,
    rawPerson: r.raw_person ?? null,
  };
  if (r.frozen) {
    const snap = JSON.parse(r.frozen);
    return { id: r.id, frozen: true, ...snap, ...extra, taskKnown: snap.task != null };
  }
  return {
    id: r.id,
    frozen: false,
    ...extra,
    taskKnown: r.task_known === 1,
    date: r.date,
    hours: r.hours,
    person: r.person,
    task_id: r.task_id,
    topic: r.topic ?? null,
    subtopic: r.subtopic ?? null,
    task: r.task ?? null,
    cir: unionTags(r.s_cir, r.t_cir),
    geo: unionTags(r.s_geo, r.t_geo),
    itl: unionTags(r.s_itl, r.t_itl),
  };
}

const nowIso = () => new Date().toISOString();
export const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s ?? '');

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    // Migration : ancienne colonne hours_per_day -> per_day
    const cols = this.db.prepare('PRAGMA table_info(people)').all().map((c) => c.name);
    if (cols.includes('hours_per_day')) this.db.exec('ALTER TABLE people RENAME COLUMN hours_per_day TO per_day');
    this._stmts = new Map();
  }

  close() {
    this.db.close();
  }

  stmt(sql) {
    let s = this._stmts.get(sql);
    if (!s) this._stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- meta / état de synchro ----
  getMeta(key) {
    return this.stmt('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  }
  setMeta(key, value) {
    this.stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      key,
      value,
    );
  }
  get lockedUntil() {
    return this.getMeta('locked_until');
  }

  getSyncState(kind) {
    return this.stmt('SELECT * FROM sync_state WHERE kind = ?').get(kind) ?? { kind };
  }
  setSyncState(kind, patch) {
    const cur = this.getSyncState(kind);
    const next = { ...cur, ...patch };
    this.stmt(
      `INSERT INTO sync_state (kind, watermark, last_sync, last_full_sync) VALUES ($kind, $watermark, $last_sync, $last_full_sync)
       ON CONFLICT(kind) DO UPDATE SET watermark = excluded.watermark, last_sync = excluded.last_sync, last_full_sync = excluded.last_full_sync`,
    ).run({
      kind,
      watermark: next.watermark ?? null,
      last_sync: next.last_sync ?? null,
      last_full_sync: next.last_full_sync ?? null,
    });
  }
  resetSyncState() {
    this.db.exec('DELETE FROM sync_state');
  }

  // ---- écriture des lignes ----
  get(kind, id) {
    return this.stmt(`SELECT * FROM ${TABLES[kind].table} WHERE id = ?`).get(id);
  }

  upsert(kind, row, runId) {
    const { table, cols } = TABLES[kind];
    const all = ['id', ...cols, 'last_edited', 'seen_run'];
    const sql = `INSERT INTO ${table} (${all.join(', ')}) VALUES (${all.map((c) => '$' + c).join(', ')})
      ON CONFLICT(id) DO UPDATE SET ${all
        .slice(1)
        .map((c) => `${c} = excluded.${c}`)
        .join(', ')}`;
    const params = {};
    for (const c of all) {
      let v = c === 'seen_run' ? runId : row[c];
      if (JSON_COLS.has(c)) v = JSON.stringify(v ?? []);
      params[c] = v === undefined ? null : v;
    }
    this.stmt(sql).run(params);
  }

  markSeen(kind, id, runId) {
    this.stmt(`UPDATE ${TABLES[kind].table} SET seen_run = ? WHERE id = ?`).run(runId, id);
  }

  // Supprime les lignes absentes d'une synchro complète. Les lignes figées ne sont jamais supprimées.
  deleteUnseen(kind, runId) {
    const { table } = TABLES[kind];
    const extra = kind === 'timeLogs' ? ' AND frozen IS NULL' : '';
    return Number(
      this.stmt(`DELETE FROM ${table} WHERE (seen_run IS NULL OR seen_run <> ?)${extra}`).run(runId).changes,
    );
  }

  addConflict(pageId, kind, pageLastEdited, details) {
    this.stmt(
      `INSERT OR IGNORE INTO conflicts (page_id, kind, page_last_edited, detected_at, details) VALUES (?, ?, ?, ?, ?)`,
    ).run(pageId, kind, pageLastEdited ?? null, nowIso(), JSON.stringify(details));
  }

  listConflicts({ includeAcknowledged = false } = {}) {
    return this.db
      .prepare(
        `SELECT * FROM conflicts ${includeAcknowledged ? '' : 'WHERE acknowledged = 0'} ORDER BY detected_at DESC, id DESC LIMIT 2000`,
      )
      .all()
      .map((c) => ({ ...c, details: JSON.parse(c.details ?? 'null') }));
  }

  acknowledgeConflicts(ids) {
    this.tx(() => {
      for (const id of ids) this.stmt('UPDATE conflicts SET acknowledged = 1 WHERE id = ?').run(id);
    });
  }

  counts() {
    const out = {};
    for (const [kind, { table }] of Object.entries(TABLES)) {
      out[kind] = this.stmt(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    }
    out.frozen = this.stmt('SELECT COUNT(*) AS n FROM time_logs WHERE frozen IS NOT NULL').get().n;
    out.openConflicts = this.stmt('SELECT COUNT(*) AS n FROM conflicts WHERE acknowledged = 0').get().n;
    const range = this.stmt('SELECT MIN(date) AS min, MAX(date) AS max FROM time_logs').get();
    out.dateMin = range.min;
    out.dateMax = range.max;
    return out;
  }

  // ---- lecture pour les rapports ----
  resolvedRows(start, end) {
    return this.stmt(`${RESOLVE_SQL} WHERE tl.date >= ? AND tl.date <= ?`).all(start, end).map(resolveRow);
  }

  tagValues() {
    const out = {};
    for (const col of ['cir', 'geo', 'itl']) {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT j.value AS v FROM (
             SELECT tags_${col} AS tags FROM tasks UNION ALL SELECT tags_${col} FROM subtopics
             UNION ALL SELECT json_extract(frozen, '$.${col}') FROM time_logs WHERE frozen IS NOT NULL
           ) x, json_each(x.tags) j WHERE x.tags IS NOT NULL`,
        )
        .all();
      const seen = new Map();
      for (const { v } of rows) if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
      out[col] = [...seen.values()].sort((a, b) => a.localeCompare(b, 'fr'));
    }
    return out;
  }

  // ---- personnes (stats) ----
  peopleConfig() {
    return this.db.prepare('SELECT * FROM people').all();
  }

  updatePerson(email, patch) {
    const cur = this.stmt('SELECT * FROM people WHERE email = ?').get(email) ?? { email, tracked: isEmail(email) ? 1 : 0 };
    const next = { ...cur, ...patch };
    this.stmt(
      `INSERT INTO people (email, per_day, start_date, end_date, tracked) VALUES ($email, $per_day, $start_date, $end_date, $tracked)
       ON CONFLICT(email) DO UPDATE SET per_day = excluded.per_day, start_date = excluded.start_date,
       end_date = excluded.end_date, tracked = excluded.tracked`,
    ).run({
      email,
      per_day: next.per_day ?? null,
      start_date: next.start_date || null,
      end_date: next.end_date || null,
      tracked: next.tracked ? 1 : 0,
    });
  }

  // Réglages du temps attendu (unité Notion, temps attendu par jour ouvré, Pentecôte).
  timeSettings() {
    const unit = this.getMeta('time_unit') === 'hour' ? 'hour' : 'day';
    const perDay = Number(this.getMeta('expected_per_day')) || (unit === 'hour' ? 7 : 1);
    const pentecostWorked = this.getMeta('pentecost_worked') !== '0';
    return { unit, perDay, pentecostWorked };
  }

  setTimeSettings({ unit, perDay, pentecostWorked }) {
    this.tx(() => {
      if (unit) this.setMeta('time_unit', unit === 'hour' ? 'hour' : 'day');
      if (perDay != null) this.setMeta('expected_per_day', String(Number(perDay) || ''));
      if (pentecostWorked != null) this.setMeta('pentecost_worked', pentecostWorked ? '1' : '0');
    });
    return this.timeSettings();
  }

  // Activité de chaque personne sur tout l'historique (premier / dernier temps saisi).
  personActivity() {
    return this.db
      .prepare(
        `SELECT COALESCE(pa.email, tl.person) AS email, MIN(tl.date) AS first_log, MAX(tl.date) AS last_log, COUNT(*) AS entries
         FROM time_logs tl LEFT JOIN person_aliases pa ON pa.raw = tl.person
         WHERE tl.person IS NOT NULL GROUP BY COALESCE(pa.email, tl.person)`,
      )
      .all();
  }

  // Identifiants Notion présents dans les temps passés, avec de quoi les reconnaître.
  identities() {
    const rows = this.db
      .prepare(
        `SELECT tl.person AS raw, pa.email AS alias, pa.updated_at AS alias_at, COUNT(*) AS entries,
           COALESCE(SUM(tl.hours), 0) AS hours, MIN(tl.date) AS first_log, MAX(tl.date) AS last_log
         FROM time_logs tl LEFT JOIN person_aliases pa ON pa.raw = tl.person
         WHERE tl.person IS NOT NULL GROUP BY tl.person`,
      )
      .all();
    const top = new Map();
    for (const r of this.db
      .prepare(
        `SELECT tl.person AS raw, s.name AS name, SUM(tl.hours) AS hours
         FROM time_logs tl LEFT JOIN tasks t ON t.id = tl.task_id LEFT JOIN subtopics s ON s.id = t.subtopic_id
         WHERE tl.person IS NOT NULL AND s.name IS NOT NULL GROUP BY tl.person, s.name ORDER BY hours DESC`,
      )
      .all()) {
      const list = top.get(r.raw) ?? [];
      if (list.length < 3) list.push(r.name);
      top.set(r.raw, list);
    }
    const noPerson = this.stmt('SELECT COUNT(*) AS n, COALESCE(SUM(hours), 0) AS hours FROM time_logs WHERE person IS NULL').get();
    return {
      identities: rows.map((r) => ({ ...r, hasEmail: isEmail(r.raw), topSubtopics: top.get(r.raw) ?? [] })),
      noPerson,
    };
  }

  setAlias(raw, email) {
    email = String(email ?? '').trim().toLowerCase();
    if (!email) {
      this.stmt('DELETE FROM person_aliases WHERE raw = ?').run(raw);
      return null;
    }
    if (!isEmail(email)) throw new Error(`« ${email} » n'est pas une adresse e-mail valide.`);
    if (email === String(raw).toLowerCase()) throw new Error('Un identifiant ne peut pas être rattaché à lui-même.');
    const chained = this.stmt('SELECT email FROM person_aliases WHERE raw = ?').get(email);
    if (chained) throw new Error(`${email} est lui-même rattaché à ${chained.email} : rattachez directement à ${chained.email}.`);
    this.stmt(
      `INSERT INTO person_aliases (raw, email, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(raw) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at`,
    ).run(raw, email, nowIso());
    // Ceux qui pointaient vers l'identifiant rattaché suivent (pas de chaîne).
    this.stmt('UPDATE person_aliases SET email = ?, updated_at = ? WHERE email = ?').run(email, nowIso(), raw);
    return email;
  }

  countWithoutDate() {
    return this.stmt('SELECT COUNT(*) AS n, COALESCE(SUM(hours), 0) AS hours FROM time_logs WHERE date IS NULL').get();
  }

  // ---- clôtures ----
  closurePreview(until) {
    const from = this.lockedUntil;
    const r = this.stmt(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(hours), 0) AS hours, MIN(date) AS min, MAX(date) AS max
       FROM time_logs WHERE frozen IS NULL AND date IS NOT NULL AND date <= ?`,
    ).get(until);
    const noTask = this.stmt(
      `SELECT COUNT(*) AS n FROM time_logs tl LEFT JOIN tasks t ON t.id = tl.task_id
       WHERE tl.frozen IS NULL AND tl.date IS NOT NULL AND tl.date <= ? AND t.id IS NULL`,
    ).get(until).n;
    return { from, until, ...r, withoutTask: noTask };
  }

  // Fige toutes les lignes jusqu'à `until` (inclus) : on enregistre l'instantané résolu.
  closePeriod(until) {
    const prev = this.lockedUntil;
    if (prev && until <= prev) throw new Error(`La période est déjà clôturée jusqu'au ${prev}.`);
    return this.tx(() => {
      const rows = this.stmt(`${RESOLVE_SQL} WHERE tl.frozen IS NULL AND tl.date IS NOT NULL AND tl.date <= ?`)
        .all(until)
        .map(resolveRow);
      const upd = this.stmt('UPDATE time_logs SET frozen = ? WHERE id = ?');
      let hours = 0;
      for (const { id, frozen, peopleCount, taskKnown, labels, livePerson, rawPerson, ...snap } of rows) {
        upd.run(JSON.stringify(snap), id);
        hours += snap.hours ?? 0;
      }
      this.setMeta('locked_until', until);
      this.stmt('INSERT INTO closures (action, locked_until, previous, at, rows, hours) VALUES (?, ?, ?, ?, ?, ?)').run(
        'close',
        until,
        prev,
        nowIso(),
        rows.length,
        hours,
      );
      return { rows: rows.length, hours };
    });
  }

  // Rouvre la période après `until` (ou tout si null). Les lignes redeviennent "vivantes".
  reopenPeriod(until) {
    const prev = this.lockedUntil;
    if (!prev) throw new Error("Aucune période n'est clôturée.");
    if (until && until >= prev) throw new Error(`La date doit être antérieure au ${prev}.`);
    return this.tx(() => {
      const res = until
        ? this.stmt('UPDATE time_logs SET frozen = NULL WHERE frozen IS NOT NULL AND date > ?').run(until)
        : this.stmt('UPDATE time_logs SET frozen = NULL WHERE frozen IS NOT NULL').run();
      this.setMeta('locked_until', until ?? null);
      if (!until) this.stmt("DELETE FROM meta WHERE key = 'locked_until'").run();
      this.stmt('INSERT INTO closures (action, locked_until, previous, at, rows) VALUES (?, ?, ?, ?, ?)').run(
        'reopen',
        until ?? null,
        prev,
        nowIso(),
        Number(res.changes),
      );
      // Les modifications ignorées pendant la clôture seront récupérées par la prochaine synchro,
      // qui sera automatiquement complète.
      this.setMeta('needs_full_sync', '1');
      return { rows: Number(res.changes) };
    });
  }

  closureHistory() {
    return this.db.prepare('SELECT * FROM closures ORDER BY id DESC').all();
  }
}
