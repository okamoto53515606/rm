import Konva from 'konva';
import type { EffectKind, Mask, PhotoDoc } from './types';
import { boxFromPoints, uid } from './util';
import { renderMasked } from './image';

export type Tool = 'select' | 'rect' | 'ellipse' | 'polygon';

export interface EditorCallbacks {
  /** マスクの追加・移動・削除など、内容が変わったとき */
  onChange: () => void;
  /** 選択中のマスクが変わったとき（未選択なら null） */
  onSelect: (mask: Mask | null) => void;
  /** 描き終わったときにツールを戻したいとき（"select" を通知） */
  onToolChange?: (tool: Tool) => void;
}

interface DrawState {
  start: { x: number; y: number };
  node: Konva.Shape;
}

const MANUAL_COLOR = '#e0483f';
const AUTO_COLOR = '#0ea5e9';

export class MaskEditor {
  private readonly container: HTMLDivElement;
  private readonly cb: EditorCallbacks;
  private readonly stage: Konva.Stage;
  private readonly layer: Konva.Layer;
  private readonly content: Konva.Group;
  private readonly imageNode: Konva.Image;
  private readonly maskGroup: Konva.Group;
  private readonly vertexGroup: Konva.Group;
  private readonly transformer: Konva.Transformer;
  private readonly resizeObserver: ResizeObserver;

  private photo: PhotoDoc | null = null;
  private scale = 1;
  private tool: Tool = 'select';
  private defaultEffect: EffectKind = 'mosaic+blur';
  private selectedId: string | null = null;
  private nodes = new Map<string, Konva.Shape>();
  private history: string[] = [];
  private draw: DrawState | null = null;
  private polyPoints: number[] | null = null;
  private polyPreview: Konva.Line | null = null;
  private fitScheduled = false;

  constructor(container: HTMLDivElement, cb: EditorCallbacks) {
    this.container = container;
    this.cb = cb;

    this.stage = new Konva.Stage({ container, width: 1, height: 1 });
    this.layer = new Konva.Layer();
    this.stage.add(this.layer);

    this.content = new Konva.Group();
    this.layer.add(this.content);

    const blank = document.createElement('canvas');
    blank.width = 1;
    blank.height = 1;
    this.imageNode = new Konva.Image({ image: blank, width: 1, height: 1, listening: false });
    this.content.add(this.imageNode);

    this.maskGroup = new Konva.Group();
    this.content.add(this.maskGroup);

    this.vertexGroup = new Konva.Group();
    this.content.add(this.vertexGroup);

    this.transformer = new Konva.Transformer({
      rotateEnabled: false,
      flipEnabled: false,
      ignoreStroke: true,
      padding: 2,
      borderStroke: '#3b5bdb',
      anchorStroke: '#3b5bdb',
      anchorFill: '#ffffff',
      anchorSize: 9,
      boundBoxFunc: (oldBox, newBox) =>
        Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4 ? oldBox : newBox,
    });
    this.layer.add(this.transformer);
    this.transformer.visible(false);

    this.stage.on('mousedown touchstart', (e) => this.onDown(e));
    this.stage.on('mousemove touchmove', () => this.onMove());
    this.stage.on('mouseup touchend', () => this.onUp());
    this.stage.on('dblclick dbltap', () => {
      if (this.tool === 'polygon') this.finishPolygon();
    });

    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(container);
    this.scheduleFit();
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.stage.destroy();
  }

  // ===== 公開 API =====

  setPhoto(photo: PhotoDoc | null): void {
    this.photo = photo;
    this.history = [];
    this.cancelDraw();
    this.transformer.nodes([]);
    this.transformer.visible(false);

    if (!photo) {
      this.imageNode.visible(false);
      this.content.visible(false);
      this.rebuildMasks();
      this.stage.batchDraw();
      return;
    }

    this.content.visible(true);
    this.imageNode.visible(true);
    this.imageNode.image(photo.raster as unknown as CanvasImageSource);
    this.imageNode.size({ width: photo.width, height: photo.height });
    this.rebuildMasks();
    this.fit();
  }

  setTool(tool: Tool): void {
    if (tool !== 'polygon') this.cancelPolygon();
    if (tool !== 'rect' && tool !== 'ellipse') this.cancelShape();
    this.tool = tool;
    // 描画中は既存マスクがドラッグを奪わないようにする
    this.maskGroup.listening(tool === 'select');
    this.vertexGroup.listening(tool === 'select');
    this.container.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    if (tool === 'select') this.fit();
  }

  /** 外部からマスク配列を書き換えたとき、履歴を保ったまま表示を作り直す */
  refresh(): void {
    this.rebuildMasks();
    this.stage.batchDraw();
  }

  getSelectedMask(): Mask | null {
    if (!this.photo || !this.selectedId) return null;
    return this.photo.masks.find((m) => m.id === this.selectedId) ?? null;
  }

  setSelectedEffect(effect: EffectKind): void {
    const mask = this.getSelectedMask();
    if (!mask) return;
    this.pushHistory();
    mask.effect = effect;
    this.requestPreview();
    this.cb.onChange();
  }

  /** 未選択のときに、その写真のすべての枠の隠し方をまとめて変える */
  setAllEffects(effect: EffectKind): number {
    this.defaultEffect = effect;
    if (!this.photo || !this.photo.masks.length) return 0;
    this.pushHistory();
    for (const mask of this.photo.masks) mask.effect = effect;
    this.requestPreview();
    this.cb.onChange();
    return this.photo.masks.length;
  }

  deleteSelected(): void {
    if (!this.photo || !this.selectedId) return;
    const idx = this.photo.masks.findIndex((m) => m.id === this.selectedId);
    if (idx < 0) return;
    this.pushHistory();
    this.photo.masks.splice(idx, 1);
    this.selectedId = null;
    this.rebuildMasks();
    this.transformer.nodes([]);
    this.transformer.visible(false);
    this.cb.onSelect(null);
    this.cb.onChange();
  }

  undo(): void {
    if (!this.photo) return;
    const prev = this.history.pop();
    if (!prev) return;
    this.photo.masks = JSON.parse(prev) as Mask[];
    this.selectedId = null;
    this.transformer.nodes([]);
    this.transformer.visible(false);
    this.cb.onSelect(null);
    this.rebuildMasks();
    this.cb.onChange();
  }

  // ===== 配置 =====

  private scheduleFit(): void {
    if (this.fitScheduled) return;
    this.fitScheduled = true;
    requestAnimationFrame(() => {
      this.fitScheduled = false;
      this.fit();
    });
  }

  private fit(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width <= 0 || height <= 0) return;
    this.stage.size({ width, height });

    if (!this.photo) {
      this.stage.batchDraw();
      return;
    }
    const scale = Math.min(width / this.photo.width, height / this.photo.height);
    this.scale = scale;
    this.content.scale({ x: scale, y: scale });
    this.content.position({
      x: (width - this.photo.width * scale) / 2,
      y: (height - this.photo.height * scale) / 2,
    });
    this.updateStrokeWidths();
    this.updatePreview();
    this.stage.batchDraw();
  }

  private updateStrokeWidths(): void {
    for (const node of this.nodes.values()) {
      node.strokeWidth(2 / this.scale);
    }
    for (const child of this.vertexGroup.getChildren()) {
      if (child instanceof Konva.Circle) {
        child.radius(5 / this.scale);
        child.strokeWidth(1.5 / this.scale);
      }
    }
  }

  private updatePreview(): void {
    if (!this.photo || this.scale <= 0) return;
    const longSide = Math.max(
      1,
      Math.round(Math.max(this.photo.width, this.photo.height) * this.scale),
    );
    const canvas = renderMasked(this.photo.raster, this.photo.masks, longSide);
    this.imageNode.image(canvas as unknown as CanvasImageSource);
    this.stage.batchDraw();
  }

  private requestPreview(): void {
    this.updatePreview();
  }

  // ===== マスクノード =====

  private rebuildMasks(): void {
    this.transformer.nodes([]);
    this.transformer.visible(false);
    this.vertexGroup.destroyChildren();
    this.maskGroup.destroyChildren();
    this.nodes.clear();

    if (this.photo) {
      for (const mask of this.photo.masks) this.createNode(mask);
    }
    this.updateStrokeWidths();
    this.requestPreview();
    this.stage.batchDraw();

    // 選択状態を復元する。何も選んでいなければ先頭の枠を選んでおく
    // （検出直後に「隠し方」を変えたとき、その枠へ即座に反映させるため）
    const still =
      this.selectedId !== null &&
      (this.photo?.masks.some((m) => m.id === this.selectedId) ?? false);
    const next: string | null = still
      ? this.selectedId
      : (this.photo?.masks[0]?.id ?? null);
    if (next) this.select(next);
    else this.deselect();
  }

  private createNode(mask: Mask): void {
    const stroke = mask.source === 'auto' ? AUTO_COLOR : MANUAL_COLOR;
    const fill =
      mask.source === 'auto' ? 'rgba(14,165,233,0.06)' : 'rgba(224,72,63,0.06)';
    const common = {
      id: mask.id,
      name: 'mask',
      draggable: true,
      stroke,
      strokeWidth: 2 / this.scale,
      fill,
    };

    let node: Konva.Shape;
    if (mask.kind === 'rect') {
      node = new Konva.Rect({
        ...common,
        x: mask.box.x,
        y: mask.box.y,
        width: mask.box.w,
        height: mask.box.h,
      });
    } else if (mask.kind === 'ellipse') {
      node = new Konva.Ellipse({
        ...common,
        x: mask.box.x + mask.box.w / 2,
        y: mask.box.y + mask.box.h / 2,
        radiusX: mask.box.w / 2,
        radiusY: mask.box.h / 2,
      });
    } else {
      node = new Konva.Line({
        ...common,
        points: mask.points ?? [],
        closed: true,
      });
    }

    node.on('click tap', (e) => {
      e.cancelBubble = true;
      this.select(mask.id);
    });
    node.on('dragstart transformstart', () => this.pushHistory());
    node.on('dragmove', () => {
      if (mask.kind !== 'polygon' || !(node instanceof Konva.Line)) return;
      const dx = node.x();
      const dy = node.y();
      const circles = this.vertexGroup.getChildren();
      const pts = mask.points ?? [];
      for (let i = 0, c = 0; i < pts.length; i += 2, c += 1) {
        const circle = circles[c];
        if (circle instanceof Konva.Circle) {
          circle.position({ x: pts[i] + dx, y: pts[i + 1] + dy });
        }
      }
    });
    node.on('dragend transformend', () => this.commitNode(mask.id, node));

    this.maskGroup.add(node);
    this.nodes.set(mask.id, node);
  }

  private commitNode(id: string, node: Konva.Shape): void {
    if (!this.photo) return;
    const mask = this.photo.masks.find((m) => m.id === id);
    if (!mask) return;

    if (mask.kind === 'rect' && node instanceof Konva.Rect) {
      const w = Math.max(2, Math.abs(node.width() * node.scaleX()));
      const h = Math.max(2, Math.abs(node.height() * node.scaleY()));
      node.scale({ x: 1, y: 1 });
      node.width(w);
      node.height(h);
      mask.box = { x: node.x(), y: node.y(), w, h };
    } else if (mask.kind === 'ellipse' && node instanceof Konva.Ellipse) {
      const rx = Math.max(1, Math.abs(node.radiusX() * node.scaleX()));
      const ry = Math.max(1, Math.abs(node.radiusY() * node.scaleY()));
      node.scale({ x: 1, y: 1 });
      node.radiusX(rx);
      node.radiusY(ry);
      mask.box = { x: node.x() - rx, y: node.y() - ry, w: rx * 2, h: ry * 2 };
    } else if (mask.kind === 'polygon' && node instanceof Konva.Line) {
      const dx = node.x();
      const dy = node.y();
      const points = node.points().map((v, i) => v + (i % 2 === 0 ? dx : dy));
      node.position({ x: 0, y: 0 });
      node.points(points);
      mask.points = points;
      mask.box = boxFromPoints(points);
      this.showVertices(mask, node);
    }

    this.requestPreview();
    // 半径・サイズを確定してスケールを 1 に戻すため、ハンドル位置を再計算する
    this.transformer.forceUpdate();
    this.cb.onChange();
  }

  private select(id: string): void {
    if (!this.photo) return;
    const mask = this.photo.masks.find((m) => m.id === id);
    if (!mask) {
      this.deselect();
      return;
    }
    this.selectedId = id;
    this.vertexGroup.destroyChildren();
    const node = this.nodes.get(id);

    if (node && mask.kind !== 'polygon') {
      this.transformer.nodes([node]);
      this.transformer.visible(true);
      node.moveToTop();
      this.transformer.forceUpdate();
    } else {
      this.transformer.nodes([]);
      this.transformer.visible(false);
      if (node instanceof Konva.Line) this.showVertices(mask, node);
    }
    this.stage.batchDraw();
    this.cb.onSelect(mask);
  }

  private deselect(): void {
    this.selectedId = null;
    this.transformer.nodes([]);
    this.transformer.visible(false);
    this.vertexGroup.destroyChildren();
    this.stage.batchDraw();
    this.cb.onSelect(null);
  }

  private showVertices(mask: Mask, line: Konva.Line): void {
    this.vertexGroup.destroyChildren();
    const points = line.points();
    for (let i = 0; i < points.length; i += 2) {
      const index = i;
      const circle = new Konva.Circle({
        x: points[i],
        y: points[i + 1],
        radius: 5 / this.scale,
        fill: '#ffffff',
        stroke: '#3b5bdb',
        strokeWidth: 1.5 / this.scale,
        draggable: true,
      });
      circle.on('dragstart', () => this.pushHistory());
      circle.on('dragmove', () => {
        const next = line.points().slice();
        next[index] = circle.x();
        next[index + 1] = circle.y();
        line.points(next);
        mask.points = next;
        mask.box = boxFromPoints(next);
        this.requestPreview();
        this.stage.batchDraw();
      });
      circle.on('dragend', () => this.cb.onChange());
      this.vertexGroup.add(circle);
    }
    this.stage.batchDraw();
  }

  // ===== 描画 =====

  private pointer(): { x: number; y: number } | null {
    const pos = this.stage.getPointerPosition();
    if (!pos) return null;
    return this.content.getAbsoluteTransform().copy().invert().point(pos);
  }

  private onDown(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void {
    if (!this.photo) return;
    const target = e.target as Konva.Node;

    // 変形ハンドル・頂点ハンドルの操作では選択を維持する
    if (target === this.transformer || target.getParent() === this.transformer) return;
    if (target.getParent() === this.vertexGroup) return;

    if (this.tool === 'select') {
      if (target && target.name() === 'mask') this.select(target.id());
      else this.deselect();
      return;
    }

    const p = this.pointer();
    if (!p) return;

    if (this.tool === 'polygon') {
      this.addPolygonPoint(p);
      return;
    }

    if (this.draw) return;
    const common = {
      stroke: MANUAL_COLOR,
      strokeWidth: 2 / this.scale,
      fill: 'rgba(224,72,63,0.12)',
      listening: false,
    };
    const node: Konva.Shape =
      this.tool === 'rect'
        ? new Konva.Rect({ ...common, x: p.x, y: p.y, width: 0, height: 0 })
        : new Konva.Ellipse({ ...common, x: p.x, y: p.y, radiusX: 0, radiusY: 0 });
    this.maskGroup.add(node);
    this.draw = { start: p, node };
  }

  private onMove(): void {
    if (this.draw) {
      const p = this.pointer();
      if (!p) return;
      const { start, node } = this.draw;
      if (node instanceof Konva.Rect) {
        node.setAttrs({
          x: Math.min(start.x, p.x),
          y: Math.min(start.y, p.y),
          width: Math.abs(p.x - start.x),
          height: Math.abs(p.y - start.y),
        });
      } else if (node instanceof Konva.Ellipse) {
        node.setAttrs({
          x: (start.x + p.x) / 2,
          y: (start.y + p.y) / 2,
          radiusX: Math.abs(p.x - start.x) / 2,
          radiusY: Math.abs(p.y - start.y) / 2,
        });
      }
      this.stage.batchDraw();
      return;
    }
    if (this.polyPoints) {
      const p = this.pointer();
      if (p) this.updatePolyPreview(p);
    }
  }

  private onUp(): void {
    if (!this.draw || !this.photo) return;
    const { node } = this.draw;
    this.draw = null;

    let box: { x: number; y: number; w: number; h: number };
    if (node instanceof Konva.Rect) {
      box = { x: node.x(), y: node.y(), w: node.width(), h: node.height() };
    } else if (node instanceof Konva.Ellipse) {
      box = {
        x: node.x() - node.radiusX(),
        y: node.y() - node.radiusY(),
        w: node.radiusX() * 2,
        h: node.radiusY() * 2,
      };
    } else {
      box = { x: 0, y: 0, w: 0, h: 0 };
    }
    node.destroy();
    this.stage.batchDraw();

    // 画面上で 6px 未満のものは誤操作とみなす
    if (box.w * this.scale < 6 || box.h * this.scale < 6) return;

    const kind: Mask['kind'] = node instanceof Konva.Ellipse ? 'ellipse' : 'rect';
    this.pushHistory();
    const mask: Mask = {
      id: uid(),
      kind,
      box,
      effect: this.defaultEffect,
      label: '手動',
      source: 'manual',
    };
    this.photo.masks.push(mask);
    this.rebuildMasks();
    this.select(mask.id);
    this.cb.onChange();
    // 描いたあとは選択ツールに戻す（そのままサイズ変更できるように）
    this.cb.onToolChange?.('select');
  }

  private addPolygonPoint(p: { x: number; y: number }): void {
    if (!this.polyPoints) {
      this.polyPoints = [p.x, p.y];
      this.polyPreview = new Konva.Line({
        points: [p.x, p.y, p.x, p.y],
        stroke: MANUAL_COLOR,
        strokeWidth: 2 / this.scale,
        dash: [6 / this.scale, 4 / this.scale],
        listening: false,
        closed: false,
      });
      this.maskGroup.add(this.polyPreview);
      return;
    }

    const [x0, y0] = [this.polyPoints[0], this.polyPoints[1]];
    const closed =
      this.polyPoints.length >= 6 &&
      Math.hypot(p.x - x0, p.y - y0) < 10 / this.scale;
    if (closed) {
      this.finishPolygon();
      return;
    }
    this.polyPoints.push(p.x, p.y);
    this.updatePolyPreview();
  }

  private updatePolyPreview(p?: { x: number; y: number }): void {
    if (!this.polyPreview || !this.polyPoints) return;
    const points = this.polyPoints.slice();
    if (p) points.push(p.x, p.y);
    this.polyPreview.points(points);
    this.stage.batchDraw();
  }

  private finishPolygon(): void {
    if (!this.photo || !this.polyPoints || this.polyPoints.length < 6) {
      this.cancelPolygon();
      return;
    }
    const points = this.polyPoints.slice();
    this.cancelPolygon();
    this.pushHistory();
    const mask: Mask = {
      id: uid(),
      kind: 'polygon',
      box: boxFromPoints(points),
      points,
      effect: this.defaultEffect,
      label: '手動',
      source: 'manual',
    };
    this.photo.masks.push(mask);
    this.rebuildMasks();
    this.select(mask.id);
    this.cb.onChange();
    this.cb.onToolChange?.('select');
  }

  private cancelPolygon(): void {
    this.polyPreview?.destroy();
    this.polyPreview = null;
    this.polyPoints = null;
    this.stage.batchDraw();
  }

  private cancelShape(): void {
    this.draw?.node.destroy();
    this.draw = null;
    this.stage.batchDraw();
  }

  private cancelDraw(): void {
    this.cancelShape();
    this.cancelPolygon();
  }

  private pushHistory(): void {
    if (!this.photo) return;
    this.history.push(JSON.stringify(this.photo.masks));
    if (this.history.length > 50) this.history.shift();
  }
}
