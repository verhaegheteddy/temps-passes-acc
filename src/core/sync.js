// Moteur de synchronisation Notion -> cache local.
//
// - Incrémental : pages modifiées depuis le dernier "watermark" (last_edited_time), triées par
//   ordre croissant ; le watermark est enregistré après chaque lot de 100 pages, donc une synchro
//   interrompue reprend là où elle s'était arrêtée (y compris la toute première).
// - Complète : relit tout (pour les temps passés : uniquement la période non clôturée) et supprime
//   du cache ce qui n'existe plus dans Notion.
// - Période clôturée : les temps passés datés jusqu'à `locked_until` ne sont jamais modifiés ;
//   toute modification côté Notion est enregistrée comme "conflit" pour information.
import { KINDS, DEFAULT_DATABASES, missingRequired, pageToRow } from './mapping.js';

const MARGIN_MS = 5 * 60_000; // last_edited_time Notion est arrondi à la minute
const PAGE_SIZE = 100;
const NOTION_QUERY_CAP = 10_000;

function frozenDiff(snap, row) {
  const diff = {};
  for (const k of ['date', 'hours', 'person', 'task_id']) {
    if ((snap[k] ?? null) !== (row[k] ?? null)) diff[k] = { cache: snap[k] ?? null, notion: row[k] ?? null };
  }
  return Object.keys(diff).length ? diff : null;
}

function applyTimeLog(store, row, page, runId, lockedUntil, stats) {
  const existing = store.get('timeLogs', row.id);
  if (existing?.frozen) {
    const diff = frozenDiff(JSON.parse(existing.frozen), row);
    if (diff) {
      store.addConflict(row.id, 'modified_in_closed', row.last_edited, { url: page.url, diff });
      stats.conflicts++;
    }
    return;
  }
  if (lockedUntil && row.date && row.date <= lockedUntil) {
    const kind = existing ? 'moved_into_closed' : 'created_in_closed';
    store.addConflict(row.id, kind, row.last_edited, {
      url: page.url,
      date: row.date,
      hours: row.hours,
      person: row.person,
      previousDate: existing?.date ?? null,
    });
    stats.conflicts++;
    return;
  }
  store.upsert('timeLogs', row, runId);
  stats.upserted++;
}

export async function runSync({ store, client, databases, mode = 'incremental', kinds = KINDS, onProgress = () => {}, signal }) {
  const startedAt = Date.now();
  if (store.getMeta('needs_full_sync') === '1') mode = 'full';
  const summary = {};

  for (const kind of kinds) {
    const cfg = databases[kind];
    const label = DEFAULT_DATABASES[kind].label;
    if (!cfg?.id) throw new Error(`Base « ${label} » : identifiant manquant (voir Paramètres).`);
    const missing = missingRequired(kind, cfg.mapping);
    if (missing.length) {
      throw new Error(`Base « ${label} » : propriétés non associées : ${missing.join(', ')} (voir Paramètres).`);
    }

    onProgress({ kind, label, phase: 'schema' });
    const source = await client.resolveSource(cfg.id, { signal });
    const propertyIds = [];
    for (const name of Object.values(cfg.mapping).filter(Boolean)) {
      const p = source.properties[name];
      if (!p) throw new Error(`Base « ${label} » : la propriété « ${name} » n'existe plus dans Notion (voir Paramètres).`);
      propertyIds.push(p.id);
    }

    // Début de lecture de cette base, à l'heure du serveur Notion (repli : horloge locale).
    const kindStartedAt = client.lastServerTime ?? Date.now();
    const state = store.getSyncState(kind);
    const full = mode === 'full' && !!state.watermark; // sans watermark : import initial, reprenable
    const lockedUntil = store.lockedUntil;
    // Pour une synchro complète des temps passés : uniquement la période non clôturée.
    let dateFilter = null;
    if (full && kind === 'timeLogs' && lockedUntil) {
      const dateProp = cfg.mapping.date;
      if (source.properties[dateProp]?.type === 'date') {
        dateFilter = {
          or: [
            { property: dateProp, date: { after: lockedUntil } },
            { property: dateProp, date: { is_empty: true } },
          ],
        };
      }
    }

    const runId = startedAt;
    const stats = { fetched: 0, upserted: 0, conflicts: 0, deleted: 0, full };
    let watermark = state.watermark ?? null; // persisté (incrémental)
    let cursor = null; // dernière date de modification lue pendant cette synchro
    let since = !full && state.watermark ? new Date(Date.parse(state.watermark) - MARGIN_MS).toISOString() : null;

    // Notion ne renvoie jamais plus de 10 000 résultats par requête, même en paginant.
    // On lit donc par tranches : tant qu'une tranche est "pleine", on relance une requête
    // à partir de la dernière date de modification lue (tri croissant).
    for (;;) {
      const parts = [];
      if (since) parts.push({ timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } });
      if (dateFilter) parts.push(dateFilter);
      const filter = parts.length > 1 ? { and: parts } : parts[0];
      const cursorBefore = cursor;
      let inSlice = 0;

      for await (const pages of client.queryPages(source, {
        filter,
        sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
        propertyIds,
        signal,
      })) {
        store.tx(() => {
          for (const page of pages) {
            const row = pageToRow(kind, page, cfg.mapping);
            if (kind === 'timeLogs') applyTimeLog(store, row, page, runId, lockedUntil, stats);
            else {
              store.upsert(kind, row, runId);
              stats.upserted++;
            }
            if (!cursor || page.last_edited_time > cursor) cursor = page.last_edited_time;
            if (!watermark || page.last_edited_time > watermark) watermark = page.last_edited_time;
          }
          if (!full) store.setSyncState(kind, { watermark, last_sync: new Date().toISOString() });
        });
        inSlice += pages.length;
        stats.fetched += pages.length;
        onProgress({ kind, label, phase: 'fetch', ...stats });
      }

      if (inSlice < PAGE_SIZE || !cursor) break; // tranche incomplète : tout est lu
      if (cursor === cursorBefore) {
        // La tranche n'a rien apporté de plus récent : soit tout est lu, soit plus de 10 000 pages
        // partagent la même minute de modification (impossible à départager via l'API).
        if (inSlice >= NOTION_QUERY_CAP) stats.warning = `Plus de ${NOTION_QUERY_CAP} pages modifiées à la même minute : certaines peuvent manquer.`;
        break;
      }
      since = cursor;
    }

    if (full) {
      const before = store.counts()[kind];
      if (stats.fetched === 0 && before > 0) {
        // Garde-fou : une réponse vide (droits retirés, mauvais filtre…) ne doit pas vider le cache.
        stats.warning = 'Aucune page reçue : suppression ignorée par sécurité.';
      } else {
        stats.deleted = store.deleteUnseen(kind, runId);
      }
      const at = new Date().toISOString();
      store.setSyncState(kind, {
        // Tout ce qui a été modifié pendant la synchro complète sera relu à la prochaine incrémentale.
        watermark: new Date(kindStartedAt).toISOString(),
        last_sync: at,
        last_full_sync: at,
      });
    } else {
      store.setSyncState(kind, { watermark, last_sync: new Date().toISOString() });
    }

    if (full && kind === 'timeLogs') store.setMeta('needs_full_sync', '0');
    summary[kind] = stats;
    onProgress({ kind, label, phase: 'done', ...stats });
  }
  return summary;
}
