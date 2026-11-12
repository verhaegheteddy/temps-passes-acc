// Paramètres persistants (userData/settings.json). Le token est chiffré via safeStorage
// (trousseau du système : Keychain, DPAPI, libsecret).
import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DATABASES, KINDS } from '../core/mapping.js';

const file = () => join(app.getPath('userData'), 'settings.json');

function read() {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

function write(data) {
  const tmp = file() + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file());
}

// Accepte un identifiant ou une URL Notion, renvoie un UUID avec tirets.
export function normalizeId(input) {
  const hex = String(input ?? '')
    .replace(/-/g, '')
    .match(/[0-9a-f]{32}(?![0-9a-f])/i)?.[0];
  if (!hex) return String(input ?? '').trim();
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function getDatabases() {
  const saved = read().databases ?? {};
  return Object.fromEntries(
    KINDS.map((k) => [k, { id: saved[k]?.id ?? DEFAULT_DATABASES[k].id, mapping: saved[k]?.mapping ?? {} }]),
  );
}

export function setDatabases(databases) {
  const data = read();
  data.databases = Object.fromEntries(
    KINDS.map((k) => [k, { id: normalizeId(databases[k]?.id), mapping: databases[k]?.mapping ?? {} }]),
  );
  write(data);
  return getDatabases();
}

export function getToken() {
  const { token, tokenEncrypted } = read();
  if (!token) return null;
  if (!tokenEncrypted) return token;
  try {
    return safeStorage.decryptString(Buffer.from(token, 'base64'));
  } catch {
    return null;
  }
}

export function setToken(token) {
  const data = read();
  token = String(token ?? '').trim();
  if (!token) {
    delete data.token;
    delete data.tokenEncrypted;
  } else if (safeStorage.isEncryptionAvailable()) {
    data.token = safeStorage.encryptString(token).toString('base64');
    data.tokenEncrypted = true;
  } else {
    data.token = token;
    data.tokenEncrypted = false;
  }
  write(data);
}

export function tokenInfo() {
  const { token, tokenEncrypted } = read();
  return { hasToken: !!token && !!getToken(), encrypted: !!tokenEncrypted };
}
