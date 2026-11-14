import { MaskEditor, type Tool } from './editor';
import { canvasToJpeg, decodeFile, makeThumbnail, releaseRaster, renderMasked } from './image';
import { detect } from './detect';
import type { Detection, DetectSettings, EffectKind, PhotoDoc } from './types';
import { baseName, download, iou, isTypingTarget, stamp, uid } from './util';
import { zipSync } from 'fflate';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`要素 #${id} が見つかりません`);
  return node as T;
}

function blobPart(bytes: Uint8Array): BlobPart {
  return bytes as unknown as BlobPart;
}

function newDoc(file: File): PhotoDoc {
  const placeholder = document.createElement('canvas');
  placeholder.width = 1;
  placeholder.height = 1;
  return {
    id: uid(),
    file,
    name: file.name || `clipboard_${stamp()}.png`,
    width: 0,
    height: 0,
    raster: placeholder,
    thumbnail: '',
    masks: [],
    status: 'decoding',
    verified: false,
  };
}

export class App {
  private photos: PhotoDoc[] = [];
  private currentId: string | null = null;
  private editor: MaskEditor;
  private currentTool: Tool = 'select';
  private busy = false;
  private progressTimer: number | undefined;

  private readonly dom = {
    dropzone: el<HTMLDivElement>('dropzone'),
    fileInput: el<HTMLInputElement>('fileInput'),
    photoList: el<HTMLUListElement>('photoList'),
    photoCount: el<HTMLElement>('photoCount'),
    btnClearAll: el<HTMLButtonElement>('btnClearAll'),
    effectSelect: el<HTMLSelectElement>('effectSelect'),
    btnUndo: el<HTMLButtonElement>('btnUndo'),
    btnDelete: el<HTMLButtonElement>('btnDelete'),
    chkVerified: el<HTMLInputElement>('chkVerified'),
    verifiedWrap: el<HTMLElement>('verifiedWrap'),
    canvasHost: el<HTMLDivElement>('canvasHost'),
    emptyState: el<HTMLDivElement>('emptyState'),
    statusText: el<HTMLElement>('statusText'),
    progressBar: el<HTMLDivElement>('progressBar'),
    selProvider: el<HTMLSelectElement>('selProvider'),
    chkFaceRefine: el<HTMLInputElement>('chkFaceRefine'),
    refineFields: el<HTMLElement>('refineFields'),
    ocrFields: el<HTMLElement>('ocrFields'),
    chkLocalOcr: el<HTMLInputElement>('chkLocalOcr'),
    externalWarning: el<HTMLElement>('externalWarning'),
    providerNote: el<HTMLElement>('providerNote'),
    ollamaHint: el<HTMLElement>('ollamaHint'),
    ollamaFields: el<HTMLElement>('ollamaFields'),
    ollamaEndpoint: el<HTMLInputElement>('ollamaEndpoint'),
    ollamaModel: el<HTMLInputElement>('ollamaModel'),
    btnDetectCurrent: el<HTMLButtonElement>('btnDetectCurrent'),
    btnDetectAll: el<HTMLButtonElement>('btnDetectAll'),
    detectStatus: el<HTMLElement>('detectStatus'),
    expMaxSide: el<HTMLSelectElement>('expMaxSide'),
    expQuality: el<HTMLSelectElement>('expQuality'),
    btnExport: el<HTMLButtonElement>('btnExport'),
    exportStatus: el<HTMLElement>('exportStatus'),
    btnHelp: el<HTMLButtonElement>('btnHelp'),
    helpDialog: el<HTMLDialogElement>('helpDialog'),
    confirmDialog: el<HTMLDialogElement>('confirmDialog'),
    confirmTitle: el<HTMLElement>('confirmTitle'),
    confirmMessage: el<HTMLElement>('confirmMessage'),
    confirmOk: el<HTMLButtonElement>('confirmOk'),
    confirmCancel: el<HTMLButtonElement>('confirmCancel'),
  };

  constructor() {
    this.editor = new MaskEditor(this.dom.canvasHost, {
      onChange: () => this.afterEdit(),
      onSelect: (mask) => {
        if (!mask) return;
        this.dom.effectSelect.value = mask.effect;
        const kind = mask.kind === 'rect' ? '矩形' : mask.kind === 'ellipse' ? '楕円' : '多角形';
        this.setStatus(`${kind}の枠を選択中 — 四隅のハンドルでサイズ変更できます`);
      },
      onToolChange: (tool) => this.setTool(tool),
    });
  }

  start(): void {
    this.bind();
    this.dom.ollamaHint.textContent =
      `起動例: OLLAMA_ORIGINS=${location.origin} ollama serve。` +
      'Chrome 142 以降は、初回に「ローカルネットワーク」の許可も求められます。';
    this.dom.selProvider.dispatchEvent(new Event('change'));
    this.renderList();
  }

  // ===== イベント =====

  private bind(): void {
    const d = this.dom;

    d.dropzone.addEventListener('click', () => d.fileInput.click());
    d.dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        d.fileInput.click();
      }
    });
    d.fileInput.addEventListener('change', () => {
      if (d.fileInput.files) void this.addFiles(Array.from(d.fileInput.files));
      d.fileInput.value = '';
    });

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      d.dropzone.classList.add('is-over');
    });
    window.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) d.dropzone.classList.remove('is-over');
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      d.dropzone.classList.remove('is-over');
      const files = e.dataTransfer?.files;
      if (files && files.length) void this.addFiles(Array.from(files));
    });

    window.addEventListener('paste', (e) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) {
        e.preventDefault();
        void this.addFiles(files);
      }
    });

    d.photoList.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('.photo-item');
      if (item?.dataset.id) this.selectPhoto(item.dataset.id);
    });

    d.btnClearAll.addEventListener('click', () => this.clearAll());

    document.querySelectorAll<HTMLButtonElement>('.tool[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => this.setTool(btn.dataset.tool as Tool));
    });

    d.effectSelect.addEventListener('change', () => {
      const effect = d.effectSelect.value as EffectKind;
      const label = d.effectSelect.selectedOptions[0]?.textContent ?? effect;
      if (this.editor.getSelectedMask()) {
        this.editor.setSelectedEffect(effect);
        this.setStatus(`選択中の枠を「${label}」に変更しました`);
        return;
      }
      // 何も選んでいないときは、その写真の枠すべてに適用する
      const count = this.editor.setAllEffects(effect);
      this.setStatus(
        count > 0
          ? `すべての枠（${count} か所）を「${label}」に変更しました`
          : `新しく描く枠を「${label}」にしました`,
      );
    });

    d.btnUndo.addEventListener('click', () => this.editor.undo());
    d.btnDelete.addEventListener('click', () => this.editor.deleteSelected());

    d.chkVerified.addEventListener('change', () => {
      const doc = this.current();
      if (!doc) return;
      doc.verified = d.chkVerified.checked;
      this.renderList();
    });

    d.selProvider.addEventListener('change', () => {
      const provider = d.selProvider.value;
      d.ollamaFields.hidden = provider !== 'ollama';
      d.refineFields.hidden = provider === 'local';
      d.ocrFields.hidden = provider !== 'local';
      // ブラウザ内のときは「Ollama で文字検出」の説明は不要なので隠す
      d.providerNote.hidden = provider === 'local';
      d.externalWarning.hidden = provider === 'local';
      d.externalWarning.textContent =
        provider === 'ollama'
          ? '選択した写真は、この端末の Ollama（localhost）に送信されます。'
          : '';
    });

    d.btnDetectCurrent.addEventListener('click', () => {
      const doc = this.current();
      if (!doc) {
        this.setDetectStatus('写真を選択してください', 'error');
        return;
      }
      void this.runDetect([doc]);
    });
    d.btnDetectAll.addEventListener('click', () => void this.runDetect(this.photos));

    d.btnExport.addEventListener('click', () => void this.exportAll());
    d.btnHelp.addEventListener('click', () => d.helpDialog.showModal());

    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  private onKey(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      this.editor.undo();
      this.afterEdit();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.editor.getSelectedMask()) {
        e.preventDefault();
        this.editor.deleteSelected();
      }
      return;
    }
    if (e.key === 'Escape') {
      this.setTool('select');
      return;
    }
    const map: Record<string, Tool> = { v: 'select', r: 'rect', e: 'ellipse', p: 'polygon' };
    const tool = map[e.key.toLowerCase()];
    if (tool) {
      e.preventDefault();
      this.setTool(tool);
    }
  }

  // ===== 写真の追加・選択 =====

  private async addFiles(files: File[]): Promise<void> {
    const images = files.filter(
      (f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name),
    );
    if (!images.length) {
      this.setStatus('画像ファイルを追加してください');
      return;
    }

    for (const file of images) {
      const doc = newDoc(file);
      this.photos.push(doc);
      this.renderList();
      this.setStatus(`読み込み中: ${doc.name}`);
      try {
        const { raster, width, height } = await decodeFile(file);
        doc.raster = raster;
        doc.width = width;
        doc.height = height;
        doc.thumbnail = await makeThumbnail(raster);
        doc.status = 'ready';
        if (!this.currentId) this.selectPhoto(doc.id);
      } catch (err) {
        doc.status = 'error';
        doc.message = err instanceof Error ? err.message : String(err);
        this.setStatus(doc.message);
      }
      this.renderList();
    }
    this.setStatus(`${this.photos.length} 枚を読み込みました`);
  }

  private current(): PhotoDoc | null {
    return this.photos.find((p) => p.id === this.currentId) ?? null;
  }

  private selectPhoto(id: string): void {
    const doc = this.photos.find((p) => p.id === id);
    if (!doc) return;
    if (doc.status !== 'ready') {
      this.setStatus(doc.message ?? '読み込み中です');
      return;
    }
    this.currentId = id;
    this.editor.setPhoto(doc);
    this.editor.setTool(this.currentTool);
    this.dom.emptyState.classList.add('hidden');
    this.dom.verifiedWrap.hidden = false;
    this.dom.chkVerified.checked = doc.verified;
    this.setStatus(`${doc.name}（${doc.masks.length} か所）`);
    this.renderList();
  }

  private clearAll(): void {
    if (!this.photos.length) return;
    void this.askConfirm({
      title: 'すべて削除',
      message: '追加した写真をすべて削除します。\nよろしいですか？',
      okText: '削除する',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      for (const doc of this.photos) {
        if (doc.thumbnail) URL.revokeObjectURL(doc.thumbnail);
        releaseRaster(doc.raster);
      }
      this.photos = [];
      this.currentId = null;
      this.editor.setPhoto(null);
      this.dom.emptyState.classList.remove('hidden');
      this.dom.verifiedWrap.hidden = true;
      this.setStatus('待機中');
      this.renderList();
    });
  }

  /** ブラウザの confirm() の代わりに、アプリ内のモーダルで確認する */
  private askConfirm(options: {
    title: string;
    message: string;
    okText?: string;
    danger?: boolean;
  }): Promise<boolean> {
    const d = this.dom;
    d.confirmTitle.textContent = options.title;
    d.confirmMessage.textContent = options.message;
    d.confirmOk.textContent = options.okText ?? 'OK';
    d.confirmOk.classList.toggle('danger', Boolean(options.danger));

    return new Promise((resolve) => {
      const finish = (value: boolean) => {
        d.confirmOk.onclick = null;
        d.confirmCancel.onclick = null;
        d.confirmDialog.oncancel = null;
        d.confirmDialog.close();
        resolve(value);
      };
      d.confirmOk.onclick = () => finish(true);
      d.confirmCancel.onclick = () => finish(false);
      d.confirmDialog.oncancel = (e) => {
        e.preventDefault();
        finish(false);
      };
      d.confirmDialog.showModal();
    });
  }

  private setTool(tool: Tool): void {
    this.currentTool = tool;
    this.editor.setTool(tool);
    document.querySelectorAll<HTMLButtonElement>('.tool[data-tool]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.tool === tool);
    });
  }

  // ===== 検出 =====

  private settings(): DetectSettings {
    return {
      provider: this.dom.selProvider.value as DetectSettings['provider'],
      ollamaEndpoint: this.dom.ollamaEndpoint.value,
      ollamaModel: this.dom.ollamaModel.value,
      refineFaces: this.dom.chkFaceRefine.checked,
      ocr: this.dom.chkLocalOcr.checked,
      onProgress: (message) => this.setDetectStatus(message),
    };
  }

  private async runDetect(targets: PhotoDoc[]): Promise<void> {
    if (this.busy) return;
    const notes: string[] = [];
    const base = this.settings();
    // 進捗は逐次表示しつつ、エラー文言は最後のメッセージにも残す
    const settings = {
      ...base,
      onProgress: (message: string) => {
        notes.push(message);
        this.setDetectStatus(message);
      },
    };
    if (settings.provider === 'ollama' && !settings.ollamaEndpoint.trim()) {
      this.setDetectStatus('Ollama のエンドポイントを入力してください', 'error');
      return;
    }

    const runnable = targets.filter((p) => p.status === 'ready');
    if (!runnable.length) {
      this.setDetectStatus('検出できる写真がありません', 'error');
      return;
    }

    this.setBusy(true);
    let failed = false;
    for (let i = 0; i < runnable.length; i += 1) {
      const doc = runnable[i];
      doc.status = 'detecting';
      this.renderList();
      this.setStatus(`検出中: ${doc.name} (${i + 1}/${runnable.length})`);
      this.setDetectStatus(`${i + 1}/${runnable.length} 枚目を検出しています…`);
      try {
        const found = await detect(doc.raster, settings);
        const added = this.appendDetections(doc, found);
        doc.status = 'ready';
        doc.lastError = undefined;
        doc.verified = false;
        const tally = (category: Detection['category']): number =>
          found.filter((x) => x.category === category).length;
        if (added === 0) {
          // 何も見つからなかったことは見逃されやすいので、目立つ表示で案内する。
          // 顔の検出は 100% ではないため、OCR の有無にかかわらず手動追加を促す。
          const warn = notes.find(
            (m) => m.includes('読み込めませんでした') || m.includes('失敗') || m.includes('エラー'),
          );
          const detail = warn ?? notes.filter((m) => /プレート|読み込め|失敗|エラー/.test(m)).pop();
          const message = settings.ocr
            ? '0 か所でした。集合写真や引きの写真は顔が小さいと検出されないことがあります。\n手動で枠を追加してください'
            : '0 か所でした。顔が見つからないときは手動で枠を追加してください。\n「文字も検出（OCR）」をONにすると、ナンバープレートや API キーも探します';
          this.setDetectStatus(detail ? `${message}\n${detail}` : message, warn ? 'alert error' : 'alert');
        } else {
          const warn = notes.find(
            (m) => m.includes('読み込めませんでした') || m.includes('失敗') || m.includes('エラー'),
          );
          const summary = `${added} か所を追加しました（顔 ${tally('face')}・プレート ${tally('plate')}・文字 ${tally('secret')}）`;
          this.setDetectStatus(summary, warn ? 'error' : 'ok');
        }
        if (doc.id === this.currentId) {
          this.editor.refresh();
          this.dom.chkVerified.checked = false;
          // 検出後は選択ツールに戻す（枠のサイズ変更・移動ができるように）
          if (doc.masks.length) this.setTool('select');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        doc.status = 'ready';
        doc.lastError = message;
        failed = true;
        this.setDetectStatus(message, 'error');
        this.setStatus(message);
        this.renderList();
        break;
      }
      this.setProgress((i + 1) / runnable.length);
      this.renderList();
    }
    this.setBusy(false);
    if (!failed) this.setStatus('検出が完了しました');
  }

  private appendDetections(doc: PhotoDoc, detections: Detection[]): number {
    let added = 0;
    for (const d of detections) {
      let box = {
        x: d.box.x * doc.width,
        y: d.box.y * doc.height,
        w: d.box.w * doc.width,
        h: d.box.h * doc.height,
      };
      // 文字はタイトな箱だと端の半文字が残るので、外側に少し広げる
      if (d.category === 'secret') {
        const padX = Math.max(2, Math.round(doc.width * 0.004));
        const padY = Math.max(2, Math.round(doc.height * 0.004));
        const x0 = Math.max(0, box.x - padX);
        const y0 = Math.max(0, box.y - padY);
        const x1 = Math.min(doc.width, box.x + box.w + padX);
        const y1 = Math.min(doc.height, box.y + box.h + padY);
        box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      if (doc.masks.some((m) => iou(m.box, box) > 0.6)) continue;
      doc.masks.push({
        id: uid(),
        kind: 'rect',
        box,
        effect: d.category === 'secret' ? 'fill' : 'mosaic+blur',
        label: d.label,
        source: 'auto',
      });
      added += 1;
    }
    return added;
  }

  // ===== 書き出し =====

  private async exportAll(): Promise<void> {
    if (this.busy) return;
    const ready = this.photos.filter((p) => p.status === 'ready');
    if (!ready.length) {
      this.setExportStatus('書き出せる写真がありません', 'error');
      return;
    }
    const unverified = ready.filter((p) => !p.verified).length;
    if (unverified > 0) {
      const ok = await this.askConfirm({
        title: '未確認の写真があります',
        message: `未確認の写真が ${unverified} 枚あります。\nAI の検出漏れが無いか目視で確認しましたか？\n\nこのまま書き出しますか？`,
        okText: '書き出す',
      });
      if (!ok) return;
    }

    const maxLongSide = Number(this.dom.expMaxSide.value) || null;
    const quality = Number(this.dom.expQuality.value) || 0.86;

    this.setBusy(true);
    this.setExportStatus('書き出し中…');
    try {
      const files: Record<string, Uint8Array> = {};
      for (let i = 0; i < ready.length; i += 1) {
        const doc = ready[i];
        this.setStatus(`書き出し中: ${doc.name} (${i + 1}/${ready.length})`);
        const canvas = renderMasked(doc.raster, doc.masks, maxLongSide);
        const blob = await canvasToJpeg(canvas, quality);
        const name = this.uniqueName(files, `${baseName(doc.name)}_masked.jpg`);
        files[name] = new Uint8Array(await blob.arrayBuffer());
        this.setProgress((i + 1) / ready.length);
      }

      if (ready.length === 1) {
        const [name, data] = Object.entries(files)[0];
        download(new Blob([blobPart(data)], { type: 'image/jpeg' }), name);
      } else {
        const zip = zipSync(files, { level: 0 });
        download(new Blob([blobPart(zip)], { type: 'application/zip' }), `rm_${stamp()}.zip`);
      }

      this.setExportStatus(`${ready.length} 枚を書き出しました（JPEG・EXIF削除）`, 'ok');
      this.setStatus('書き出しが完了しました');
    } catch (err) {
      this.setExportStatus(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      this.setBusy(false);
    }
  }

  private uniqueName(used: Record<string, unknown>, name: string): string {
    if (!(name in used)) return name;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let i = 2;
    while (`${base}_${i}${ext}` in used) i += 1;
    return `${base}_${i}${ext}`;
  }

  // ===== 表示更新 =====

  private afterEdit(): void {
    const doc = this.current();
    if (doc) {
      this.setStatus(`${doc.name}（${doc.masks.length} か所）`);
    }
    this.renderList();
  }

  private renderList(): void {
    const list = this.dom.photoList;
    list.textContent = '';
    this.dom.photoCount.textContent = `${this.photos.length} 枚`;

    for (const doc of this.photos) {
      const li = document.createElement('li');
      li.className = 'photo-item' + (doc.id === this.currentId ? ' is-active' : '');
      li.dataset.id = doc.id;

      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = '';
      if (doc.thumbnail) img.src = doc.thumbnail;

      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = doc.name;
      const sub = document.createElement('span');
      sub.className = 'sub';
      const dot = document.createElement('i');
      dot.className = `dot ${this.dotClass(doc)}`;
      const label = document.createElement('span');
      label.textContent = this.statusLabel(doc);
      sub.append(dot, label);
      meta.append(name, sub);
      li.append(img, meta);
      list.append(li);
    }
  }

  private dotClass(doc: PhotoDoc): string {
    if (doc.status === 'error' || doc.lastError) return 'error';
    if (doc.status === 'detecting' || doc.status === 'decoding') return 'detecting';
    if (doc.verified) return 'verified';
    if (doc.status === 'ready') return 'ready';
    return '';
  }

  private statusLabel(doc: PhotoDoc): string {
    if (doc.status === 'decoding') return '読み込み中';
    if (doc.status === 'detecting') return '検出中';
    if (doc.status === 'error') return '読み込みエラー';
    const count = `${doc.masks.length} か所`;
    if (doc.lastError) return `検出エラー・${count}`;
    return doc.verified ? `${count}・確認済み` : count;
  }

  private setStatus(text: string): void {
    this.dom.statusText.textContent = text;
  }

  private setDetectStatus(text: string, kind?: 'ok' | 'error' | 'alert' | 'alert error'): void {
    this.dom.detectStatus.textContent = text;
    this.dom.detectStatus.className = 'note' + (kind ? ` ${kind}` : '');
  }

  private setExportStatus(text: string, kind?: 'ok' | 'error'): void {
    this.dom.exportStatus.textContent = text;
    this.dom.exportStatus.className = 'note' + (kind ? ` ${kind}` : '');
  }

  private setProgress(value: number): void {
    const bar = this.dom.progressBar;
    bar.hidden = false;
    const fill = bar.firstElementChild as HTMLElement | null;
    if (fill) fill.style.width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
    window.clearTimeout(this.progressTimer);
    this.progressTimer = window.setTimeout(() => {
      bar.hidden = true;
      if (fill) fill.style.width = '0%';
    }, 1200);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    for (const btn of [this.dom.btnDetectCurrent, this.dom.btnDetectAll, this.dom.btnExport, this.dom.btnClearAll]) {
      btn.disabled = busy;
    }
  }
}
