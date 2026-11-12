import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../core/store.js';
import { NotionClient, NotionError } from '../core/notion.js';
import { runSync } from '../core/sync.js';
import { buildReport, reportToXlsx } from '../core/report.js';
import { buildStats, issueRows } from '../core/stats.js';
import { KINDS, DEFAULT_DATABASES, FIELDS, detectMapping, missingRequired } from '../core/mapping.js';
import * as settings from './settings.js';

const here = dirname(fileURLToPath(import.meta.url));
// Pour les tests : dossier de données et API Notion alternatifs.
if (process.env.TP_USER_DATA) app.setPath('userData', process.env.TP_USER_DATA);
let win;
let store;
let currentSync = null; // { controller, promise }

const LEVEL_LABEL = { topic: 'sujet', subtopic: 'sous-sujet', task: 'tache' };

function friendly(err) {
  if (err instanceof NotionError) {
    if (err.status === 401) return 'Token Notion invalide ou révoqué.';
    if (err.status === 404)
      return "Base Notion introuvable : vérifiez l'identifiant et que la base est bien partagée avec l'intégration (… › Connexions).";
    if (err.status === 403) return "L'intégration n'a pas les droits suffisants sur cette base.";
    return `Erreur Notion (${err.status}${err.code ? ' ' + err.code : ''}) : ${err.message}`;
  }
  if (err?.name === 'AbortError' || /annul/i.test(err?.message ?? '')) return 'Synchronisation annulée.';
  return err?.message ?? String(err);
}

// Les erreurs sont renvoyées sous forme { error } pour garder un message lisible côté interface.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[${channel}]`, err);
      return { ok: false, error: friendly(err) };
    }
  });
}

function client() {
  const token = settings.getToken();
  if (!token) throw new Error('Aucun token Notion configuré (voir Paramètres).');
  return new NotionClient(token, {
    baseUrl: process.env.TP_NOTION_API_URL || undefined,
    onRetry: ({ reason, delay }) =>
      win?.webContents.send('sync:progress', { phase: 'retry', message: `Nouvel essai dans ${Math.round(delay / 1000)} s (${reason})` }),
  });
}

function state() {
  const databases = settings.getDatabases();
  return {
    token: settings.tokenInfo(),
    databases,
    defaults: DEFAULT_DATABASES,
    fields: FIELDS,
    configured: KINDS.every((k) => databases[k].id && !missingRequired(k, databases[k].mapping).length),
    counts: store.counts(),
    syncState: Object.fromEntries(KINDS.map((k) => [k, store.getSyncState(k)])),
    timeSettings: store.timeSettings(),
    lockedUntil: store.lockedUntil,
    syncing: !!currentSync,
    dataPath: app.getPath('userData'),
    version: app.getVersion(),
  };
}

function lastDayOfPreviousMonth() {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 0)).toISOString().slice(0, 10);
}

function registerIpc() {
  handle('state:get', state);

  handle('settings:setToken', (token) => {
    settings.setToken(token);
    return state();
  });

  handle('settings:setDatabases', (databases) => {
    settings.setDatabases(databases);
    return state();
  });

  // Lit le schéma des 5 bases et propose une correspondance des propriétés.
  handle('notion:inspect', async (databases) => {
    const c = client();
    const out = {};
    for (const kind of KINDS) {
      const id = settings.normalizeId(databases?.[kind]?.id ?? settings.getDatabases()[kind].id);
      try {
        const src = await c.resolveSource(id);
        const mapping = detectMapping(kind, src.properties, databases?.[kind]?.mapping);
        out[kind] = {
          id,
          title: src.title,
          multipleSources: !!src.multipleSources,
          properties: Object.entries(src.properties)
            .map(([name, p]) => ({ name, type: p.type }))
            .sort((a, b) => a.name.localeCompare(b.name, 'fr')),
          mapping,
          missing: missingRequired(kind, mapping),
        };
      } catch (err) {
        out[kind] = { id, error: friendly(err) };
      }
    }
    return out;
  });

  handle('sync:start', async (mode = 'incremental') => {
    if (currentSync) throw new Error('Une synchronisation est déjà en cours.');
    const controller = new AbortController();
    const promise = runSync({
      store,
      client: client(),
      databases: settings.getDatabases(),
      mode,
      signal: controller.signal,
      onProgress: (p) => win?.webContents.send('sync:progress', p),
    });
    currentSync = { controller, promise };
    try {
      return await promise;
    } finally {
      currentSync = null;
    }
  });

  handle('sync:cancel', () => {
    currentSync?.controller.abort(new Error('Synchronisation annulée.'));
    return true;
  });

  handle('conflicts:list', (opts) => store.listConflicts(opts));
  handle('conflicts:ack', (ids) => store.acknowledgeConflicts(ids));

  handle('report:tags', () => store.tagValues());
  handle('report:build', (params) => buildReport(store, params));
  handle('report:export', async (params) => {
    const report = buildReport(store, params);
    const name = `temps-passes_${params.start}_${params.end}_${LEVEL_LABEL[params.precision] ?? params.precision}${
      report.provisionalEntries ? '_provisoire' : ''
    }.xlsx`;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: join(app.getPath('documents'), name),
      filters: [{ name: 'Classeur Excel', extensions: ['xlsx'] }],
    });
    if (canceled || !filePath) return null;
    writeFileSync(filePath, await reportToXlsx(report));
    shell.showItemInFolder(filePath);
    return filePath;
  });

  handle('stats:build', (params) => buildStats(store, params));
  handle('stats:issueRows', (params) => issueRows(store, params));
  handle('stats:updatePerson', (email, patch) => store.updatePerson(email, patch));
  handle('stats:setSettings', (s) => store.setTimeSettings(s));
  handle('people:identities', () => store.identities());
  handle('people:setAlias', (raw, email) => store.setAlias(raw, email));

  handle('closure:preview', (until) => store.closurePreview(until));
  handle('closure:close', (until) => {
    if (currentSync) throw new Error('Attendez la fin de la synchronisation.');
    if (until > lastDayOfPreviousMonth()) throw new Error('On ne peut clôturer que des mois terminés.');
    return store.closePeriod(until);
  });
  handle('closure:reopen', (until) => {
    if (currentSync) throw new Error('Attendez la fin de la synchronisation.');
    return store.reopenPeriod(until || null);
  });
  handle('closure:history', () => store.closureHistory());

  handle('shell:open', (url) => {
    if (!/^https:\/\/(www\.)?notion\.so\//.test(url)) throw new Error('URL non autorisée');
    return shell.openExternal(url);
  });
  handle('shell:dataFolder', () => shell.openPath(app.getPath('userData')));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Temps passés',
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(join(here, '../renderer/index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    store = new Store(join(app.getPath('userData'), 'cache.sqlite'));
    registerIpc();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    currentSync?.controller.abort();
    store?.close();
  });
}
