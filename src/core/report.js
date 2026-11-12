// Construction des rapports "Temps passés" et export XLSX.
import ExcelJS from 'exceljs';

export const LEVELS = [
  { key: 'topic', label: 'Sujet' },
  { key: 'subtopic', label: 'Sous-sujet' },
  { key: 'task', label: 'Tâche' },
];

export const TAG_GROUPS = [
  { key: 'cir', label: 'CIR/CII' },
  { key: 'geo', label: 'Géographique' },
  { key: 'itl', label: 'Statut projet international' },
];

const lower = (arr) => (arr ?? []).map((s) => s.toLowerCase());

// params : { start, end, precision: 'topic'|'subtopic'|'task', byPerson: bool, tags: { cir:[], geo:[], itl:[] } }
export function buildReport(store, params) {
  const { start, end, precision = 'task', byPerson = true } = params;
  if (!start || !end) throw new Error('Les dates de début et de fin sont obligatoires.');
  if (start > end) throw new Error('La date de début doit précéder la date de fin.');
  const depth = LEVELS.findIndex((l) => l.key === precision);
  if (depth < 0) throw new Error(`Précision inconnue : ${precision}`);
  const levels = LEVELS.slice(0, depth + 1);

  const wanted = Object.fromEntries(TAG_GROUPS.map((g) => [g.key, new Set(lower(params.tags?.[g.key]))]));
  const filtering = TAG_GROUPS.some((g) => wanted[g.key].size);

  let rows = store.resolvedRows(start, end);
  // Filtre "OU" : une ligne est retenue si au moins un de ses tags (tâche ou sous-sujet)
  // fait partie de la sélection, toutes catégories confondues.
  if (filtering) rows = rows.filter((r) => TAG_GROUPS.some((g) => lower(r[g.key]).some((t) => wanted[g.key].has(t))));

  const groups = new Map();
  let total = 0;
  let provisional = 0;
  for (const r of rows) {
    const hours = r.hours ?? 0;
    total += hours;
    if (!r.frozen) provisional++;
    const keyParts = levels.map((l) => r[l.key] ?? '');
    if (byPerson) keyParts.push(r.person ?? '');
    const key = JSON.stringify(keyParts);
    let g = groups.get(key);
    if (!g) {
      g = { hours: 0, entries: 0, cir: new Map(), geo: new Map(), itl: new Map() };
      for (const l of levels) g[l.key] = r[l.key] ?? null;
      if (byPerson) g.person = r.person ?? null;
      groups.set(key, g);
    }
    g.hours += hours;
    g.entries++;
    for (const t of TAG_GROUPS) for (const v of r[t.key] ?? []) if (!g[t.key].has(v.toLowerCase())) g[t.key].set(v.toLowerCase(), v);
  }

  const collator = new Intl.Collator('fr');
  const out = [...groups.values()]
    .map((g) => ({
      ...g,
      hours: Math.round(g.hours * 100) / 100,
      cir: [...g.cir.values()],
      geo: [...g.geo.values()],
      itl: [...g.itl.values()],
    }))
    .sort((a, b) => {
      for (const l of levels) {
        const c = collator.compare(a[l.key] ?? '', b[l.key] ?? '');
        if (c) return c;
      }
      return collator.compare(a.person ?? '', b.person ?? '');
    });

  return {
    params: { start, end, precision, byPerson, tags: params.tags ?? {} },
    levels,
    rows: out,
    totalHours: Math.round(total * 100) / 100,
    entries: rows.length,
    provisionalEntries: provisional,
    unit: store.timeSettings().unit,
    lockedUntil: store.lockedUntil,
    generatedAt: new Date().toISOString(),
  };
}

export async function reportToXlsx(report) {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date(report.generatedAt);
  const ws = wb.addWorksheet('Rapport');

  const columns = [
    ...report.levels.map((l) => ({ header: l.label, key: l.key, width: 32 })),
    ...(report.params.byPerson ? [{ header: 'Personne', key: 'person', width: 30 }] : []),
    { header: report.unit === 'hour' ? 'Temps (h)' : 'Temps (j)', key: 'hours', width: 12, style: { numFmt: '0.00' } },
    ...TAG_GROUPS.map((g) => ({ header: g.label, key: g.key, width: 24 })),
  ];
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  for (const r of report.rows) {
    ws.addRow({ ...r, cir: r.cir.join(', '), geo: r.geo.join(', '), itl: r.itl.join(', ') });
  }
  const totalRow = ws.addRow({ [columns[0].key]: 'Total', hours: report.totalHours });
  totalRow.font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  const info = wb.addWorksheet('Paramètres');
  info.columns = [
    { header: 'Paramètre', key: 'k', width: 34 },
    { header: 'Valeur', key: 'v', width: 60 },
  ];
  info.getRow(1).font = { bold: true };
  const tags = report.params.tags ?? {};
  info.addRows([
    { k: 'Du', v: report.params.start },
    { k: 'Au', v: report.params.end },
    { k: 'Précision', v: report.levels.at(-1).label },
    { k: 'Détail par personne', v: report.params.byPerson ? 'Oui' : 'Non' },
    ...TAG_GROUPS.map((g) => ({ k: `Filtre tags ${g.label}`, v: (tags[g.key] ?? []).join(', ') || '—' })),
    { k: 'Lignes de temps passés', v: report.entries },
    { k: 'Dont non clôturées (provisoires)', v: report.provisionalEntries },
    { k: 'Période clôturée jusqu’au', v: report.lockedUntil ?? '—' },
    { k: 'Généré le', v: new Date(report.generatedAt).toLocaleString('fr-FR') },
  ]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
