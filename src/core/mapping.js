// Correspondance entre les champs utilisés par l'app et les propriétés Notion.
// Les noms "n8n" sont ceux des anciens workflows (property_<snakeCase(nom)>) ; ils servent
// à retrouver automatiquement les vraies propriétés à partir du schéma Notion.

export const DEFAULT_DATABASES = {
  topics: { id: '84995006-ce27-4813-a931-becf2d89200a', label: 'Sujets FT' },
  subtopics: { id: '6d3d4c6e-9b1d-46cf-8234-8033e26c698e', label: 'Sous-sujets FT' },
  tasks: { id: 'eeefe2ef-a6fc-4ea5-b39c-f13ad3a647e1', label: 'Tasks' },
  timeLogs: { id: 'f6e6c136-7f09-43db-ae75-30273b89d475', label: 'Temps passés' },
};

// Ordre de synchronisation : référentiels d'abord, temps passés en dernier.
export const KINDS = ['topics', 'subtopics', 'tasks', 'timeLogs'];

// field -> { n8n: clé snake_case attendue, label, required }
export const FIELDS = {
  topics: {
    title: { type: 'title', label: 'Titre', required: true },
    label: { n8n: 'sujet', label: 'Sujet (libellé affiché)', required: false },
  },
  subtopics: {
    title: { type: 'title', label: 'Nom', required: true },
    cir: { n8n: 'tags_cir_cii', label: 'Tags CIR/CII', required: false },
    geo: { n8n: 'tags_g_ographique', label: 'Tags géographique', required: false },
    itl: { n8n: 'tags_statut_projet_itl', label: 'Tags statut projet ITL', required: false },
  },
  tasks: {
    title: { type: 'title', label: 'Nom', required: true },
    subtopic: { n8n: 'sous_sujet', label: 'Sous-sujet (relation)', required: true },
    topic: { n8n: 'sujet_ft', label: 'Sujet FT (relation)', required: false },
    cir: { n8n: 'tag_cir_cii_t_che', label: 'Tag CIR/CII', required: false },
    geo: { n8n: 'tag_g_ographique_t_che', label: 'Tag géographique', required: false },
    itl: { n8n: 'tag_statut_projet_itl_t_che', label: 'Tag statut projet ITL', required: false },
  },
  timeLogs: {
    date: { n8n: 'date', label: 'Date', required: true },
    hours: { n8n: 'temps_pass', label: 'Temps passé', required: true },
    person: { n8n: 'personne', label: 'Personne', required: true },
    task: { n8n: 'tasks', label: 'Tâche (relation)', required: true },
    labels: { n8n: 'tiquettes', label: 'Étiquettes', required: false },
  },
};

// Réplique de snakeCase() de change-case v4, utilisé par n8n pour nommer les propriétés.
export function n8nKey(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1\0$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1\0$2')
    .replace(/[^A-Z0-9\0]+/gi, '\0')
    .split('\0')
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .join('_');
}

// Détecte la correspondance à partir du schéma ({ nom: { type, id } }).
// `current` = correspondance déjà enregistrée (prioritaire si la propriété existe toujours).
export function detectMapping(kind, properties, current = {}) {
  const mapping = {};
  for (const [field, def] of Object.entries(FIELDS[kind])) {
    if (current[field] && properties[current[field]]) {
      mapping[field] = current[field];
      continue;
    }
    const found = Object.entries(properties).find(([name, p]) =>
      def.type ? p.type === def.type : n8nKey(name) === def.n8n,
    );
    mapping[field] = found ? found[0] : null;
  }
  return mapping;
}

export function missingRequired(kind, mapping) {
  return Object.entries(FIELDS[kind])
    .filter(([field, def]) => def.required && !mapping?.[field])
    .map(([field, def]) => def.label);
}

// ---- Extraction des valeurs d'une propriété Notion (tous types) ----

function plain(rich) {
  return (rich ?? []).map((r) => r.plain_text ?? '').join('');
}

export function extractValue(prop) {
  if (!prop) return null;
  const v = prop[prop.type];
  switch (prop.type) {
    case 'title':
    case 'rich_text':
      return plain(v);
    case 'number':
    case 'checkbox':
    case 'url':
    case 'email':
    case 'phone_number':
    case 'created_time':
    case 'last_edited_time':
      return v ?? null;
    case 'select':
    case 'status':
      return v?.name ?? null;
    case 'multi_select':
      return (v ?? []).map((o) => o.name);
    case 'people':
      return (v ?? []).map((p) => p.person?.email ?? p.name ?? p.id);
    case 'created_by':
    case 'last_edited_by':
      return v ? v.person?.email ?? v.name ?? v.id : null;
    case 'relation':
      return (v ?? []).map((r) => r.id);
    case 'date':
      return v ? { start: v.start, end: v.end } : null;
    case 'unique_id':
      return v ? `${v.prefix ? v.prefix + '-' : ''}${v.number}` : null;
    case 'formula':
      return v ? v[v.type] ?? null : null;
    case 'rollup':
      if (!v) return null;
      if (v.type === 'array') return v.array.map(extractValue).flat();
      return v[v.type] ?? null;
    default:
      return null;
  }
}

export const asText = (v) => {
  if (v == null) return null;
  if (Array.isArray(v)) return v.filter((x) => x != null).join(', ') || null;
  if (typeof v === 'object') return v.start ?? null;
  return String(v);
};

export const asList = (v) => {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.filter((x) => x != null && x !== '').map(String);
};

export const asNumber = (v) => {
  if (Array.isArray(v)) v = v[0];
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

export const asDate = (v) => {
  if (Array.isArray(v)) v = v[0];
  const s = typeof v === 'object' && v ? v.start : v;
  return s ? String(s).slice(0, 10) : null;
};

// Transforme une page Notion en ligne pour la table locale.
export function pageToRow(kind, page, mapping) {
  const get = (field) => (mapping[field] ? extractValue(page.properties?.[mapping[field]]) : null);
  const base = { id: page.id, last_edited: page.last_edited_time };
  switch (kind) {
    case 'topics':
      return { ...base, name: asText(get('label')) || asText(get('title')) };
    case 'subtopics':
    case 'tasks': {
      const row = {
        ...base,
        name: asText(get('title')),
        tags_cir: asList(get('cir')),
        tags_geo: asList(get('geo')),
        tags_itl: asList(get('itl')),
      };
      if (kind === 'tasks') {
        row.subtopic_id = asList(get('subtopic'))[0] ?? null;
        row.topic_id = asList(get('topic'))[0] ?? null;
      }
      return row;
    }
    case 'timeLogs': {
      const people = asList(get('person'));
      return {
        ...base,
        date: asDate(get('date')),
        hours: asNumber(get('hours')),
        person: people[0] ?? null,
        people,
        labels: asList(get('labels')),
        task_id: asList(get('task'))[0] ?? null,
      };
    }
  }
  throw new Error(`Type inconnu : ${kind}`);
}
