/**
 * Explorer panel — the instance tree, property inspector and quick actions.
 *
 * Reads MirrorInstance trees (client-side copies of the engine tree) and emits
 * intents (`select`, `delete`, `add`, `setProp`) that the app forwards to the
 * server. This is intentionally read-mostly: the server stays authoritative.
 */

const ICONS = {
  Workspace: '🌐',
  Lighting: '💡',
  ReplicatedStorage: '📦',
  ServerScriptService: '🛡️',
  ServerStorage: '🗄️',
  StarterGui: '🖼️',
  StarterPlayer: '🧍',
  Teams: '🏳️',
  SoundService: '🔊',
  Part: '🧱',
  MeshPart: '🧱',
  SpawnLocation: '🚩',
  Model: '📁',
  Folder: '📂',
  Script: '📜',
  LocalScript: '📗',
  ModuleScript: '📘',
  RemoteEvent: '📡',
  BindableEvent: '🔗',
  PointLight: '🔆',
  SpotLight: '🔦',
  Camera: '🎥',
  ScreenGui: '🪟',
  BillboardGui: '🏷️',
  TextLabel: '🔤',
  TextButton: '🔘',
  Frame: '▭',
  Humanoid: '🧍',
  Sky: '☁️',
  Atmosphere: '🌫️',
  RunService: '⏱️',
  TweenService: '🎞️',
  Debris: '🧹',
  CollectionService: '🏷️',
  HttpService: '🌍',
};

const BROWSABLE = new Set([
  'Workspace', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage',
  'StarterGui', 'StarterPlayer', 'Lighting', 'Model', 'Folder', 'ScreenGui',
  'BillboardGui', 'Frame', 'StarterPlayerScripts',
]);

export class Explorer {
  /**
   * @param {HTMLElement} host
   * @param {object} handlers  { onSelect, onDelete, onCreate, onSetProp, onFocus }
   */
  constructor(host, handlers = {}) {
    this.host = host;
    this.handlers = handlers;
    this.services = {};
    this.expanded = new Set(['Workspace', 'ServerScriptService', 'ReplicatedStorage', 'StarterPlayer']);
    this.selectedPath = null;
    this.selectedNode = null;
    this.searchTerm = '';
    this.root = document.createElement('div');
    this.root.className = 'explorer';
    this.host.appendChild(this.root);
    this.render();
  }

  setTree(services) {
    this.services = services ?? {};
    this.render();
  }

  setSearch(term) {
    this.searchTerm = term.trim().toLowerCase();
    this.render();
  }

  toggle(path) {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else this.expanded.add(path);
    this.render();
  }

  select(path, node) {
    this.selectedPath = path;
    this.selectedNode = node;
    this.render();
    this.handlers.onSelect?.(path, node);
  }

  render() {
    const frag = document.createDocumentFragment();
    for (const [serviceName, snapshot] of Object.entries(this.services)) {
      frag.appendChild(this.renderNode(snapshot, serviceName, 0, true));
    }
    this.root.replaceChildren(frag);
  }

  renderNode(snapshot, path, depth, isService = false) {
    const container = document.createElement('div');
    container.className = 'node-container';

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.dataset.path = path;
    if (path === this.selectedPath) row.classList.add('selected');
    if (isService) row.classList.add('service');

    const hasChildren = (snapshot.children?.length ?? 0) > 0;
    const isOpen = this.expanded.has(path);

    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = hasChildren ? (isOpen ? '▾' : '▸') : ' ';
    if (hasChildren) {
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggle(path);
      });
    }

    const icon = document.createElement('span');
    icon.className = 'node-icon';
    icon.textContent = ICONS[snapshot.className] ?? '•';

    const label = document.createElement('span');
    label.className = 'node-label';
    label.textContent = snapshot.name;
    if (snapshot.className === 'Script' || snapshot.className === 'LocalScript') {
      label.classList.add('script-name');
    }

    const cls = document.createElement('span');
    cls.className = 'node-class';
    cls.textContent = snapshot.className !== snapshot.name ? snapshot.className : '';

    row.append(caret, icon, label, cls);
    row.addEventListener('click', () => this.select(path, snapshot));
    row.addEventListener('dblclick', () => this.handlers.onFocus?.(path));
    container.appendChild(row);

    const matchesSearch =
      this.searchTerm &&
      (snapshot.name.toLowerCase().includes(this.searchTerm) ||
        snapshot.className.toLowerCase().includes(this.searchTerm));

    if (hasChildren && (isOpen || this.searchTerm)) {
      const kids = document.createElement('div');
      kids.className = 'tree-children';
      for (const child of snapshot.children) {
        if (this.searchTerm && !this.matchesDeep(child, this.searchTerm) && !matchesSearch) continue;
        kids.appendChild(this.renderNode(child, `${path}.${child.name}`, depth + 1));
      }
      container.appendChild(kids);
    }

    return container;
  }

  matchesDeep(snapshot, term) {
    if (snapshot.name.toLowerCase().includes(term)) return true;
    if (snapshot.className.toLowerCase().includes(term)) return true;
    return (snapshot.children ?? []).some((c) => this.matchesDeep(c, term));
  }
}

/* ====================================================================== */
/* Property inspector                                                     */
/* ====================================================================== */

const EDITABLE = new Set([
  'Name', 'Anchored', 'CanCollide', 'Transparency', 'Material', 'Shape',
  'Text', 'TextScaled', 'Enabled', 'Brightness', 'Range', 'Gravity',
  'ClockTime', 'FogEnd',
]);

export class Inspector {
  constructor(host, handlers = {}) {
    this.host = host;
    this.handlers = handlers;
    this.root = document.createElement('div');
    this.root.className = 'inspector';
    this.host.appendChild(this.root);
    this.node = null;
    this.path = null;
    this.render();
  }

  show(path, node) {
    this.path = path;
    this.node = node;
    this.render();
  }

  render() {
    if (!this.node) {
      this.root.innerHTML = `<div class="empty-hint">Select an instance<br><span>Click anything in the explorer or in the viewport.</span></div>`;
      return;
    }
    const header = document.createElement('div');
    header.className = 'inspector-header';
    header.innerHTML = `
      <div class="inspector-title">${escapeHtml(this.node.name)}</div>
      <div class="inspector-class">${escapeHtml(this.node.className)}</div>
    `;

    const body = document.createElement('div');
    body.className = 'inspector-body';

    for (const [key, value] of Object.entries(this.node.props)) {
      if (key === 'Source') continue;
      body.appendChild(this.renderProp(key, value));
    }
    if (this.node.props.Source !== undefined) {
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = 'Open in editor';
      btn.addEventListener('click', () => this.handlers.onOpenScript?.(this.path, this.node));
      body.appendChild(btn);
    }

    const actions = document.createElement('div');
    actions.className = 'inspector-actions';
    const del = document.createElement('button');
    del.className = 'btn danger small';
    del.textContent = 'Delete instance';
    del.addEventListener('click', () => this.handlers.onDelete?.(this.path, this.node));
    actions.appendChild(del);

    this.root.replaceChildren(header, body, actions);
  }

  renderProp(key, value) {
    const row = document.createElement('div');
    row.className = 'prop-row';

    const label = document.createElement('label');
    label.textContent = key;
    row.appendChild(label);

    const control = document.createElement('div');
    control.className = 'prop-control';

    const editable = EDITABLE.has(key);

    if (typeof value === 'boolean') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = value;
      input.disabled = !editable;
      input.addEventListener('change', () => {
        this.handlers.onSetProp?.(this.path, key, input.checked);
      });
      control.appendChild(input);
    } else if (typeof value === 'number') {
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.01';
      input.value = String(Math.round(value * 1000) / 1000);
      input.disabled = !editable;
      input.addEventListener('change', () => {
        this.handlers.onSetProp?.(this.path, key, Number(input.value));
      });
      control.appendChild(input);
    } else if (typeof value === 'string') {
      if (key === 'Material' || key === 'Shape') {
        const select = document.createElement('select');
        const options = key === 'Material'
          ? ['Plastic', 'SmoothPlastic', 'Neon', 'Glass', 'Metal', 'Wood', 'Grass', 'Slate', 'Concrete', 'Ice', 'ForceField']
          : ['Block', 'Ball', 'Cylinder'];
        for (const opt of options) {
          const o = document.createElement('option');
          o.value = opt;
          o.textContent = opt;
          if (opt === value) o.selected = true;
          select.appendChild(o);
        }
        select.disabled = !editable;
        select.addEventListener('change', () => this.handlers.onSetProp?.(this.path, key, select.value));
        control.appendChild(select);
      } else if (key === 'Text') {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value;
        input.addEventListener('change', () => this.handlers.onSetProp?.(this.path, key, input.value));
        control.appendChild(input);
      } else {
        const span = document.createElement('span');
        span.className = 'prop-value';
        span.textContent = value;
        control.appendChild(span);
      }
    } else if (value && typeof value === 'object') {
      control.appendChild(this.renderValueObject(key, value));
    } else {
      const span = document.createElement('span');
      span.className = 'prop-value';
      span.textContent = String(value);
      control.appendChild(span);
    }

    row.appendChild(control);
    return row;
  }

  renderValueObject(key, value) {
    const wrap = document.createElement('div');
    wrap.className = 'prop-vec';

    if (value.__t === 'Color3') {
      const swatch = document.createElement('input');
      swatch.type = 'color';
      swatch.value = rgbToHex(value);
      swatch.addEventListener('change', () => {
        const rgb = hexToRgb(swatch.value);
        this.handlers.onSetProp?.(this.path, key, { __t: 'Color3', ...rgb });
      });
      wrap.appendChild(swatch);
      return wrap;
    }

    if (value.__t === 'Vector3' || (value.x !== undefined && value.y !== undefined)) {
      for (const axis of ['x', 'y', 'z']) {
        const field = document.createElement('input');
        field.type = 'number';
        field.step = '0.5';
        field.value = String(Math.round((value[axis] ?? 0) * 100) / 100);
        field.title = axis.toUpperCase();
        field.className = `axis-${axis}`;
        field.addEventListener('change', () => {
          const next = { __t: value.__t ?? 'Vector3', x: value.x, y: value.y, z: value.z };
          next[axis] = Number(field.value);
          this.handlers.onSetProp?.(this.path, key, next);
        });
        wrap.appendChild(field);
      }
      return wrap;
    }

    if (value.__t === 'UDim2') {
      const text = document.createElement('span');
      text.className = 'prop-value';
      text.textContent = `{${fmt(value.x)}, ${fmt(value.y)}} × {${fmt(value.w)}, ${fmt(value.h)}}`;
      wrap.appendChild(text);
      return wrap;
    }

    const text = document.createElement('span');
    text.className = 'prop-value';
    text.textContent = JSON.stringify(value);
    wrap.appendChild(text);
    return wrap;
  }
}

function rgbToHex(c) {
  const to = (v) => Math.round(Math.max(0, Math.min(1, v ?? 0)) * 255).toString(16).padStart(2, '0');
  return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function fmt(v) {
  return typeof v === 'number' ? Math.round(v * 100) / 100 : v;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
