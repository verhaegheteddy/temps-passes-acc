// Statistiques de diagnostic : couverture des saisies par personne et qualité des données.
import { addDays, days, isWorkingDay, weekStart } from './calendar.js';
import { isEmail } from './store.js';

export const NO_LABEL = '(sans étiquette)';
export const INACTIVE_AFTER_DAYS = 60; // sans saisie depuis plus longtemps (et sans date de départ) : probablement parti

export const ISSUES = [
  { key: 'no_task', label: 'Temps passés sans tâche', hint: 'Comptés dans les totaux, mais en « non renseigné » dans les rapports.' },
  { key: 'unknown_task', label: 'Tâche introuvable dans le cache', hint: 'Tâche supprimée, ou synchronisation des tâches incomplète.' },
  { key: 'no_subtopic', label: 'Tâche sans sous-sujet', hint: 'Les rapports par sous-sujet les classent en « non renseigné ».' },
  { key: 'no_topic', label: 'Tâche sans sujet FT', hint: 'Les rapports par sujet les classent en « non renseigné ».' },
  { key: 'no_person', label: 'Temps passés sans personne', hint: 'Exclus des statistiques par personne.' },
  { key: 'no_hours', label: 'Temps vide ou à 0', hint: 'Saisie probablement incomplète.' },
  { key: 'multi_person', label: 'Plusieurs personnes sur un même temps', hint: 'Seule la première personne est comptée.' },
  { key: 'long_day', label: 'Dates surchargées', hint: '' }, // libellé calculé selon l'unité
  { key: 'non_working_day', label: 'Saisies un week-end ou jour férié', hint: 'Pour information : non comptées dans le temps attendu.' },
  { key: 'no_email', label: 'Personnes sans e-mail (anciens membres, bots)', hint: 'Notion ne fournit plus l’e-mail des membres partis. Non suivies par défaut.' },
];

const round = (n) => Math.round(n * 100) / 100;
const notionUrl = (id) => `https://www.notion.so/${id.replace(/-/g, '')}`;

function issueMatchers(rows, { longDay, pentecostWorked }) {
  // Journées > 10 h : on repère les couples personne/jour concernés.
  const perDay = new Map();
  for (const r of rows) {
    if (!r.person || !r.date) continue;
    const k = `${r.person}|${r.date}`;
    perDay.set(k, (perDay.get(k) ?? 0) + (r.hours ?? 0));
  }
  const longDays = new Set([...perDay].filter(([, h]) => h > longDay + 1e-9).map(([k]) => k));
  return {
    longDays,
    test: {
      no_task: (r) => !r.task_id,
      unknown_task: (r) => !!r.task_id && !r.taskKnown,
      no_subtopic: (r) => r.taskKnown && !r.subtopic,
      no_topic: (r) => r.taskKnown && !r.topic,
      no_person: (r) => !r.person,
      no_hours: (r) => !r.hours,
      multi_person: (r) => r.peopleCount > 1,
      long_day: (r) => longDays.has(`${r.person}|${r.date}`),
      non_working_day: (r) => !!r.date && !isWorkingDay(r.date, { pentecostWorked }),
      no_email: (r) => !!r.person && !isEmail(r.person),
    },
  };
}

export function buildStats(store, { start, end, today = new Date().toISOString().slice(0, 10) }) {
  if (!start || !end || start > end) throw new Error('Période invalide.');
  const settings = store.timeSettings();
  const { unit, perDay: defaultPerDay, pentecostWorked } = settings;
  // Seuil "date surchargée" : plus d'une journée (unité jours) ou plus de 10 h (unité heures).
  const longDay = unit === 'day' ? 1 : 10;
  const calOpts = { pentecostWorked };
  // Le temps attendu n'est compté que jusqu'à aujourd'hui (un mois en cours n'est pas "en retard").
  const expEnd = end < today ? end : today;
  const rows = store.resolvedRows(start, end);
  const activity = new Map(store.personActivity().map((a) => [a.email, a]));
  const config = new Map(store.peopleConfig().map((c) => [c.email, c]));
  const emails = [...new Set([...activity.keys(), ...config.keys()])];

  const weekKeys = [...new Set([...days(start, end)].map(weekStart))];
  const inactiveLimit = addDays(start, -INACTIVE_AFTER_DAYS);

  const byPerson = new Map();
  for (const r of rows) r.person = r.livePerson; // rattachements appliqués, même sur période clôturée
  const labelTotals = new Map();
  const labelByPerson = new Map();
  for (const r of rows) {
    const h = r.hours ?? 0;
    for (const lbl of r.labels.length ? r.labels : [NO_LABEL]) {
      const g = labelTotals.get(lbl) ?? { hours: 0, entries: 0 };
      g.hours += h;
      g.entries++;
      labelTotals.set(lbl, g);
      if (r.person) {
        const pl = labelByPerson.get(r.person) ?? new Map();
        pl.set(lbl, (pl.get(lbl) ?? 0) + h);
        labelByPerson.set(r.person, pl);
      }
    }
  }

  for (const r of rows) {
    if (!r.person) continue;
    let p = byPerson.get(r.person);
    if (!p) byPerson.set(r.person, (p = { logged: 0, entries: 0, noTask: 0, days: new Set(), weeks: new Map() }));
    const h = r.hours ?? 0;
    p.logged += h;
    p.entries++;
    if (!r.task_id) p.noTask += h;
    if (h > 0) p.days.add(r.date);
    const w = weekStart(r.date);
    p.weeks.set(w, (p.weeks.get(w) ?? 0) + h);
  }

  const people = emails.map((email) => {
    const cfg = config.get(email) ?? {};
    const act = activity.get(email) ?? {};
    const perDay = cfg.per_day ?? defaultPerDay;
    // Sans date d'arrivée saisie, on part du premier temps saisi (évite de compter un nouvel arrivant
    // comme absent sur les mois précédant son arrivée).
    const arrival = cfg.start_date ?? act.first_log ?? null;
    const from = arrival && arrival > start ? arrival : start;
    const to = cfg.end_date && cfg.end_date < expEnd ? cfg.end_date : expEnd;
    const workDays = from <= to ? [...days(from, to)].filter((d) => isWorkingDay(d, calOpts)) : [];
    const expected = workDays.length * perDay;
    const p = byPerson.get(email);
    const logged = round(p?.logged ?? 0);
    const tracked = cfg.tracked ?? (isEmail(email) ? 1 : 0);
    const inactive = !cfg.end_date && !p && !!act.last_log && act.last_log < inactiveLimit;
    const counted = !!tracked && !inactive && expected > 0;
    const rate = expected > 0 ? logged / expected : null;
    const weekly = weekKeys.map((w) => {
      const wd = workDays.filter((d) => weekStart(d) === w).length;
      return { week: w, expected: wd * perDay, logged: round(p?.weeks.get(w) ?? 0) };
    });
    return {
      email,
      tracked: !!tracked,
      inactive,
      counted,
      perDay: cfg.per_day ?? null,
      hasEmail: isEmail(email),
      startDate: cfg.start_date ?? null,
      endDate: cfg.end_date ?? null,
      expected: round(expected),
      logged,
      gap: round(logged - expected),
      rate,
      workDays: workDays.length,
      daysLogged: p?.days.size ?? 0,
      entries: p?.entries ?? 0,
      noTaskHours: round(p?.noTask ?? 0),
      firstLog: act.first_log ?? null,
      lastLog: act.last_log ?? null,
      status: !counted ? 'ignored' : logged === 0 ? 'none' : rate >= 0.9 ? 'ok' : rate >= 0.5 ? 'partial' : 'low',
      weekly,
    };
  });
  people.sort((a, b) => (a.counted === b.counted ? (a.rate ?? 9) - (b.rate ?? 9) || a.email.localeCompare(b.email) : a.counted ? -1 : 1));

  const { test } = issueMatchers(rows, { longDay, pentecostWorked });
  const issues = ISSUES.map((def) => {
    const matched = rows.filter(test[def.key]);
    let count = matched.length;
    if (def.key === 'long_day') count = new Set(matched.map((r) => `${r.person}|${r.date}`)).size;
    if (def.key === 'no_email') count = new Set(matched.map((r) => r.person)).size;
    const label =
      def.key === 'long_day'
        ? unit === 'day'
          ? 'Dates avec plus d’une journée saisie'
          : `Dates avec plus de ${longDay} h saisies`
        : def.label;
    const hint =
      def.key === 'long_day' ? 'Saisie groupée (semaine, mois…) ou doublon. Compté en couples personne/date.' : def.hint;
    return { ...def, label, hint, count, hours: round(matched.reduce((s, r) => s + (r.hours ?? 0), 0)) };
  });
  const noDate = store.countWithoutDate();

  const counted = people.filter((p) => p.counted);
  const totalLogged = round(rows.reduce((s, r) => s + (r.hours ?? 0), 0));
  const countedLogged = round(counted.reduce((s, p) => s + p.logged, 0));
  const totalExpected = round(counted.reduce((s, p) => s + p.expected, 0));
  const noTask = issues.find((i) => i.key === 'no_task');

  return {
    params: { start, end, expectedUntil: expEnd },
    settings,
    kpis: {
      peopleKnown: emails.length,
      peopleCounted: counted.length,
      peopleLogged: counted.filter((p) => p.logged > 0).length,
      peopleSilent: counted.filter((p) => p.logged === 0).length,
      peopleInactive: people.filter((p) => p.inactive).length,
      totalLogged,
      countedLogged,
      totalExpected,
      coverage: totalExpected ? countedLogged / totalExpected : null,
      entries: rows.length,
      noTaskEntries: noTask.count,
      noTaskHours: noTask.hours,
      noTaskShare: totalLogged ? noTask.hours / totalLogged : 0,
      noDateEntries: noDate.n,
      openConflicts: store.counts().openConflicts,
      lastSync: store.getSyncState('timeLogs').last_sync ?? null,
    },
    weeks: weekKeys,
    people,
    issues,
    labels: labelStats(labelTotals, labelByPerson, totalLogged, people),
  };
}

// Temps par étiquette des temps passés : au global et par personne.
function labelStats(totals, byPerson, totalLogged, people) {
  const list = [...totals]
    .map(([label, g]) => ({ label, hours: round(g.hours), entries: g.entries, share: totalLogged ? g.hours / totalLogged : 0 }))
    .sort((a, b) => b.hours - a.hours || a.label.localeCompare(b.label, 'fr'));
  const meta = new Map(people.map((p) => [p.email, p]));
  const persons = [...byPerson]
    .map(([email, m]) => {
      const total = [...m.values()].reduce((s, h) => s + h, 0);
      return {
        email,
        counted: meta.get(email)?.counted ?? false,
        total: round(total),
        values: Object.fromEntries([...m].map(([l, h]) => [l, round(h)])),
      };
    })
    .sort((a, b) => b.total - a.total || a.email.localeCompare(b.email));
  return { list, persons };
}

// Lignes concernées par une anomalie (pour le détail).
export function issueRows(store, { key, start, end, email, label }) {
  let rows = store.resolvedRows(start, end);
  for (const r of rows) r.person = r.livePerson;
  const { unit, pentecostWorked } = store.timeSettings();
  const { test } = issueMatchers(rows, { longDay: unit === 'day' ? 1 : 10, pentecostWorked });
  if (key && !test[key]) throw new Error(`Anomalie inconnue : ${key}`);
  if (key) rows = rows.filter(test[key]);
  if (email) rows = rows.filter((r) => r.person === email);
  if (label) rows = rows.filter((r) => (r.labels.length ? r.labels.includes(label) : label === NO_LABEL));
  rows.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || (a.person ?? '').localeCompare(b.person ?? ''));
  return {
    total: rows.length,
    rows: rows.slice(0, 1000).map((r) => ({
      id: r.id,
      url: notionUrl(r.id),
      date: r.date,
      person: r.person,
      hours: r.hours,
      labels: r.labels,
      task: r.task,
      subtopic: r.subtopic,
      topic: r.topic,
      frozen: r.frozen,
    })),
  };
}
