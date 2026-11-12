// Liste à choix multiples façon <select> : un bouton qui ouvre un overlay avec recherche,
// actions « Tout » / « Aucun » et cases à cocher.
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

let openInstance = null;
document.addEventListener('mousedown', (e) => {
  if (openInstance && !openInstance.pop.contains(e.target) && !openInstance.button.contains(e.target)) openInstance.close();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openInstance) {
    const inst = openInstance;
    inst.close();
    inst.button.focus();
  }
});
window.addEventListener('resize', () => openInstance?.position());

export class MultiSelect {
  constructor({ key, label, placeholder = 'Tous', onChange = () => {} }) {
    this.key = key;
    this.placeholder = placeholder;
    this.onChange = onChange;
    this.options = [];
    this.selected = new Set();

    this.el = document.createElement('label');
    this.el.className = 'ms';
    this.el.innerHTML = `<span>${esc(label)}</span>
      <button type="button" class="ms-button" data-ms="${esc(key)}" aria-haspopup="listbox" aria-expanded="false">
        <span class="ms-text"></span><span class="ms-count" hidden></span><span class="ms-caret" aria-hidden="true">▾</span>
      </button>`;
    this.button = this.el.querySelector('button');
    this.button.addEventListener('click', () => (openInstance === this ? this.close() : this.open()));

    this.pop = document.createElement('div');
    this.pop.className = 'ms-pop';
    this.pop.dataset.ms = key;
    this.pop.hidden = true;
    this.pop.innerHTML = `
      <input type="search" class="ms-search" placeholder="Rechercher…" aria-label="Rechercher" />
      <div class="ms-actions">
        <button type="button" class="btn small ghost" data-act="all">Tout</button>
        <button type="button" class="btn small ghost" data-act="none">Aucun</button>
        <span class="ms-info"></span>
      </div>
      <div class="ms-list" role="listbox" aria-multiselectable="true"></div>`;
    document.body.append(this.pop);
    this.search = this.pop.querySelector('.ms-search');
    this.list = this.pop.querySelector('.ms-list');
    this.search.addEventListener('input', () => this.renderList());
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.list.querySelector('input')?.focus();
      }
    });
    this.pop.querySelector('[data-act="all"]').addEventListener('click', () => this.setVisible(true));
    this.pop.querySelector('[data-act="none"]').addEventListener('click', () => this.setVisible(false));
    this.list.addEventListener('change', (e) => {
      const v = e.target.value;
      e.target.checked ? this.selected.add(v) : this.selected.delete(v);
      this.update();
    });
    this.update();
  }

  get value() {
    return this.options.filter((o) => this.selected.has(o));
  }

  set value(values) {
    this.selected = new Set(values ?? []);
    this.renderList();
    this.update(false);
  }

  setOptions(options, selected = this.value) {
    this.options = options;
    this.selected = new Set((selected ?? []).filter((v) => options.includes(v)));
    this.renderList();
    this.update(false);
  }

  visibleOptions() {
    const q = norm(this.search.value.trim());
    return q ? this.options.filter((o) => norm(o).includes(q)) : this.options;
  }

  // « Tout » / « Aucun » agissent sur les options visibles (après recherche).
  setVisible(checked) {
    for (const o of this.visibleOptions()) checked ? this.selected.add(o) : this.selected.delete(o);
    this.renderList();
    this.update();
  }

  renderList() {
    const opts = this.visibleOptions();
    this.list.innerHTML = opts.length
      ? opts
          .map(
            (o) => `<label class="ms-option"><input type="checkbox" value="${esc(o)}" ${this.selected.has(o) ? 'checked' : ''} /> ${esc(o)}</label>`,
          )
          .join('')
      : `<div class="ms-empty">${this.options.length ? 'Aucun résultat' : 'Aucune valeur disponible'}</div>`;
  }

  update(notify = true) {
    const vals = this.value;
    const text = this.button.querySelector('.ms-text');
    const count = this.button.querySelector('.ms-count');
    text.textContent = !vals.length ? this.placeholder : vals.length <= 2 ? vals.join(', ') : `${vals.length} sélectionnés`;
    text.classList.toggle('muted', !vals.length);
    count.hidden = vals.length <= 2;
    count.textContent = vals.length;
    this.pop.querySelector('.ms-info').textContent = `${vals.length} / ${this.options.length}`;
    if (notify) this.onChange(vals);
  }

  position() {
    const r = this.button.getBoundingClientRect();
    const width = Math.max(r.width, 280);
    const left = Math.min(r.left, window.innerWidth - width - 12) + window.scrollX;
    this.pop.style.width = `${width}px`;
    this.pop.style.left = `${Math.max(12, left)}px`;
    this.pop.style.top = `${r.bottom + window.scrollY + 4}px`;
  }

  open() {
    openInstance?.close();
    openInstance = this;
    this.search.value = '';
    this.renderList();
    this.pop.hidden = false;
    this.position();
    this.button.setAttribute('aria-expanded', 'true');
    this.search.focus();
  }

  close() {
    this.pop.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    if (openInstance === this) openInstance = null;
  }
}
