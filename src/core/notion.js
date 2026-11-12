// Client minimal pour l'API Notion : limitation de débit, reprises sur erreur, pagination.

export class NotionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Annulé'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('Annulé'));
      },
      { once: true },
    );
  });

export class NotionClient {
  constructor(token, opts = {}) {
    this.token = token;
    this.baseUrl = opts.baseUrl ?? 'https://api.notion.com/v1';
    this.version = opts.version ?? '2025-09-03';
    this.minIntervalMs = opts.minIntervalMs ?? 350; // ~3 req/s, limite officielle
    this.maxRetries = opts.maxRetries ?? 8;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.onRetry = opts.onRetry ?? (() => {});
    this._next = 0;
    this._queue = Promise.resolve();
  }

  // Sérialise les requêtes et impose un délai minimal entre deux appels.
  _slot() {
    const p = this._queue.then(async () => {
      const wait = this._next - Date.now();
      if (wait > 0) await sleep(wait);
      this._next = Date.now() + this.minIntervalMs;
    });
    this._queue = p.catch(() => {});
    return p;
  }

  async request(method, path, body, { signal } = {}) {
    for (let attempt = 0; ; attempt++) {
      await this._slot();
      if (signal?.aborted) throw signal.reason ?? new Error('Annulé');
      let res;
      try {
        res = await fetch(this.baseUrl + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Notion-Version': this.version,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
            : AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt >= this.maxRetries) throw err;
        const delay = Math.min(30_000, 1000 * 2 ** attempt);
        this.onRetry({ reason: `réseau (${err.message})`, delay, attempt });
        await sleep(delay, signal);
        continue;
      }

      // Heure du serveur Notion : sert de référence pour les watermarks (indépendante de l'horloge du PC).
      const serverDate = Date.parse(res.headers.get('date') ?? '');
      if (Number.isFinite(serverDate)) this.lastServerTime = serverDate;
      if (res.ok) return res.json();

      const data = await res.json().catch(() => ({}));
      const retryable = res.status === 429 || res.status >= 500 || res.status === 409;
      if (retryable && attempt < this.maxRetries) {
        const ra = Number(res.headers.get('retry-after'));
        const delay = res.status === 429 && ra > 0 ? ra * 1000 : Math.min(30_000, 1000 * 2 ** attempt);
        this.onRetry({ reason: `HTTP ${res.status}`, delay, attempt });
        await sleep(delay, signal);
        continue;
      }
      throw new NotionError(res.status, data.code, data.message ?? `HTTP ${res.status}`);
    }
  }

  // Résout une base Notion en "source" interrogeable (data source depuis l'API 2025-09-03,
  // repli sur l'ancienne API si besoin).
  async resolveSource(databaseId, { signal } = {}) {
    const db = await this.request('GET', `/databases/${databaseId}`, null, { signal });
    const title = (db.title ?? []).map((t) => t.plain_text).join('') || databaseId;
    if (Array.isArray(db.data_sources) && db.data_sources.length) {
      const ds = await this.request('GET', `/data_sources/${db.data_sources[0].id}`, null, { signal });
      return {
        title,
        queryPath: `/data_sources/${ds.id}/query`,
        properties: ds.properties ?? {},
        multipleSources: db.data_sources.length > 1,
      };
    }
    return { title, queryPath: `/databases/${databaseId}/query`, properties: db.properties ?? {} };
  }

  // Parcourt toutes les pages d'une requête, lot par lot (100 pages max par lot).
  async *queryPages(source, { filter, sorts, propertyIds, signal } = {}) {
    let cursor;
    let qs = '';
    if (propertyIds?.length) {
      qs = '?' + propertyIds.map((id) => `filter_properties=${encodeURIComponent(id)}`).join('&');
    }
    for (;;) {
      const body = { page_size: 100 };
      if (filter) body.filter = filter;
      if (sorts) body.sorts = sorts;
      if (cursor) body.start_cursor = cursor;
      let data;
      try {
        data = await this.request('POST', source.queryPath + qs, body, { signal });
      } catch (err) {
        // Si filter_properties est refusé, on retente sans (payload plus gros mais fonctionnel).
        if (qs && err instanceof NotionError && err.status === 400 && !cursor) {
          qs = '';
          continue;
        }
        throw err;
      }
      yield data.results.filter((p) => p.object === 'page');
      if (!data.has_more || !data.next_cursor) return;
      cursor = data.next_cursor;
    }
  }
}
