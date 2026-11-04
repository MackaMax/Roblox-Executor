/**
 * Renderer for PlayerGui.
 *
 * The three.js viewport only knows about 3D parts, but a huge part of what
 * client scripts do is build ScreenGuis. This module paints the active client's
 * PlayerGui on top of the viewport with plain DOM, so a filtered tree you can
 * inspect is also a GUI you can actually see and click — clicking fires
 * MouseButton1Click inside the owning client realm, exactly like Roblox.
 *
 * Supported: ScreenGui, Frame, TextLabel, TextButton, ImageLabel, ImageButton,
 * ScrollingFrame, plus UDim2 size/position, colours, transparency, corner radii
 * and automatic layout-free stacking.
 */

const style_pointerEvents = (el, value) => {
  el.style.pointerEvents = value;
};

const COLOR = (c) => {
  if (!c || typeof c !== 'object') return null;
  const to255 = (v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255);
  return `rgb(${to255(c.r)}, ${to255(c.g)}, ${to255(c.b)})`;
};

/**
 * The engine stores UDim2 as the four numbers passed to `UDim2.new`:
 *   { __t: 'UDim2', x: X.Scale, y: X.Offset, w: Y.Scale, h: Y.Offset }
 * i.e. x/y are the horizontal scale/offset and w/h the vertical ones — they are
 * NOT a width/height pair. Read them positionally or every GUI lands at 0×0.
 */
const UDIM2 = (value) => {
  if (!value || typeof value !== 'object') return null;
  return {
    xScale: Number(value.x ?? 0),
    xOffset: Number(value.y ?? 0),
    yScale: Number(value.w ?? 0),
    yOffset: Number(value.h ?? 0),
  };
};

export class GuiLayer {
  /**
   * @param {HTMLElement} host an absolutely-positioned element over the canvas
   * @param {object} options { onActivate(node) }
   */
  constructor(host, options = {}) {
    this.host = host;
    this.onActivate = options.onActivate ?? (() => {});
    this.root = document.createElement('div');
    this.root.className = 'gui-root';
    host.appendChild(this.root);
    this.signature = '';
    this.visible = true;
  }

  setVisible(visible) {
    this.visible = visible;
    this.root.style.display = visible ? '' : 'none';
  }

  /**
   * The layer itself never captures input: a full-screen ScreenGui would
   * otherwise swallow every click meant for the 3D viewport. Individual
   * controls opt in with `pointer-events: auto` when they are created.
   */
  setInteractive() {
    this.root.style.pointerEvents = 'none';
  }

  /**
   * @param {object|null} playerGui snapshot of PlayerGui (from the server)
   * @param {string} clientName used to label the layer
   */
  render(playerGui, clientName = '') {
    const sig = playerGui ? JSON.stringify(playerGui) + clientName : '';
    if (sig === this.signature) return;
    this.signature = sig;

    this.root.textContent = '';
    this.root.replaceChildren?.();
    if (!playerGui) {
      this.setInteractive(false);
      return;
    }
    let painted = 0;
    for (const child of playerGui.children ?? []) {
      if (child.className !== 'ScreenGui' && child.className !== 'BillboardGui') continue;
      if (child.props?.Enabled === false) continue;
      painted += this.paint(child, this.root, { w: this.host.clientWidth, h: this.host.clientHeight });
    }
    this.setInteractive(painted > 0);

    if (painted > 0 && clientName) {
      const badge = document.createElement('div');
      badge.className = 'gui-badge';
      badge.textContent = `PlayerGui · ${clientName}`;
      this.root.appendChild(badge);
    }
  }

  /** @returns {number} how many elements were created */
  paint(node, parentEl, bounds) {
    const el = this.createElement(node);
    if (!el) return 0;

    const props = node.props ?? {};
    const pos = UDIM2(props.Position);
    const size = UDIM2(props.Size);

    const style = el.style;
    style.position = 'absolute';

    if (pos) {
      style.left = `${pos.xScale * bounds.w + pos.xOffset}px`;
      style.top = `${pos.yScale * bounds.h + pos.yOffset}px`;
    }
    if (size) {
      const w = Math.max(0, size.xScale * bounds.w + size.xOffset);
      const h = Math.max(0, size.yScale * bounds.h + size.yOffset);
      // a zero size means "no explicit size": let the element size itself
      if (w > 0) style.width = `${w}px`;
      if (h > 0) style.height = `${h}px`;
    }

    const bg = COLOR(props.BackgroundColor3);
    if (bg && el.dataset.isText !== 'true') style.background = bg;
    if (props.BackgroundTransparency != null) {
      style.opacity = String(1 - Number(props.BackgroundTransparency));
    }
    if (props.Visible === false) style.display = 'none';
    if (props.ZIndex != null) style.zIndex = String(props.ZIndex);

    const nextBounds = {
      w: parseFloat(style.width) || bounds.w,
      h: parseFloat(style.height) || bounds.h,
    };

    let count = 1;
    for (const child of node.children ?? []) {
      count += this.paint(child, el, nextBounds);
    }

    parentEl.appendChild(el);
    return count;
  }

  createElement(node) {
    const props = node.props ?? {};
    const tag = node.className;
    let el;

    switch (tag) {
      case 'ScreenGui':
        el = document.createElement('div');
        el.className = 'gui-screen';
        break;
      case 'Frame':
      case 'ScrollingFrame':
        el = document.createElement('div');
        break;
      case 'TextLabel': {
        el = document.createElement('div');
        el.dataset.isText = 'true';
        el.textContent = String(props.Text ?? '');
        const color = COLOR(props.TextColor3);
        if (color) el.style.color = color;
        if (props.TextScaled) el.style.fontSize = 'clamp(9px, 2.2vh, 22px)';
        else el.style.fontSize = `${Number(props.TextSize ?? 14)}px`;
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';
        el.style.textAlign = 'center';
        break;
      }
      case 'TextButton': {
        el = document.createElement('button');
        el.type = 'button';
        el.className = 'gui-button';
        el.textContent = String(props.Text ?? 'Button');
        const fg = COLOR(props.TextColor3);
        if (fg) el.style.color = fg;
        el.style.fontSize = props.TextScaled
          ? 'clamp(9px, 2vh, 20px)'
          : `${Number(props.TextSize ?? 14)}px`;
        break;
      }
      case 'ImageLabel':
      case 'ImageButton':
        el = document.createElement(tag === 'ImageButton' ? 'button' : 'div');
        if (props.Image) {
          el.style.backgroundImage = `url("${String(props.Image)}")`;
          el.style.backgroundSize = 'contain';
          el.style.backgroundRepeat = 'no-repeat';
          el.style.backgroundPosition = 'center';
        }
        break;
      default:
        return null; // not a renderable GUI class
    }

    // rounded corners (UICorner child, Roblox's usual idiom). CornerRadius is a
    // UDim, which the engine stores as { s: scale, o: offset } — with the
    // default being UDim.new(0, 8).
    const corner = (node.children ?? []).find((c) => c.className === 'UICorner');
    if (corner) {
      const raw = corner.props?.CornerRadius;
      const radius = typeof raw === 'object' && raw !== null ? Number(raw.o ?? 0) : Number(raw ?? 8);
      el.style.borderRadius = `${Number.isFinite(radius) ? radius : 8}px`;
    }

    // UIPadding
    const padding = (node.children ?? []).find((c) => c.className === 'UIPadding');
    if (padding) {
      const px = (v) => {
        const n = typeof v === 'object' && v !== null ? Number(v.o ?? 0) : Number(v ?? 0);
        return Number.isFinite(n) ? `${n}px` : '0px';
      };
      el.style.padding = `${px(padding.props?.PaddingTop)} ${px(padding.props?.PaddingRight)} ${px(padding.props?.PaddingBottom)} ${px(padding.props?.PaddingLeft)}`;
    }

    if (tag === 'TextButton' || tag === 'ImageButton') {
      style_pointerEvents(el, 'auto');
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        this.onActivate(node);
      });
      el.addEventListener('pointerdown', (event) => event.stopPropagation());
    }
    // keep 3D picking from hijacking clicks inside a control
    el.addEventListener('pointerdown', (event) => event.stopPropagation());

    return el;
  }
}
