import { touchDistance } from './inputGeometry';

export interface EditorCallbacks {
  onPlaceFurniture: (type: string, gridX: number, gridY: number) => void;
  onSelectFurniture: (id: string | null) => void;
  onMoveFurniture: (id: string, gridX: number, gridY: number) => void;
  onRotateFurniture: (id: string, rotation: number) => void;
}

export interface FurnitureHit {
  id: string;
  x: number;
  y: number;
}

export interface FurnitureRotation {
  id: string;
  rotation: number;
}

export interface EditorControllerHost {
  screenToGrid: (clientX: number, clientY: number) => { gridX: number; gridY: number } | null;
  findFurnitureAt: (gridX: number, gridY: number) => FurnitureHit | null;
  previewFurnitureMove: (id: string, gridX: number, gridY: number) => void;
  rotateFurnitureAt: (gridX: number, gridY: number) => FurnitureRotation | null;
  findCharacterAt: (gridX: number, gridY: number) => string | null;
  hasSelectedAgent: () => boolean;
  handleTouchGridTap: (gridX: number, gridY: number) => void;
  /**
   * Return the rotated footprint dimensions (anchor-relative) of a
   * furniture type. Used to make the drag clamp footprint-aware: a
   * DESK is 3×2, so an anchor at `gridWidth - 2` would extend into
   * the 1-tile wall. `null` is returned for unknown types (clamps fall
   * back to the safe default of `[1, gridW-2]`).
   */
  getFootprint: (type: string, rotation: number) => { width: number; height: number } | null;
  /**
   * Convenience for the dragging case: look up the rotated footprint of
   * the furniture currently being dragged by id. Returns `null` if the
   * id is unknown (clamps fall back to the safe default).
   */
  getFootprintForId: (id: string) => { width: number; height: number } | null;
}

export interface EditorControllerSounds {
  place: () => void;
  pickup: () => void;
}

export interface EditorControllerConfig {
  gridWidth: number;
  gridHeight: number;
}

interface TouchDragState {
  id: string;
  offsetX: number;
  offsetY: number;
}

export class EditorController {
  private static readonly TAP_THRESHOLD = 12;
  private static readonly DOUBLE_TAP_MS = 300;

  private _editorMode = false;
  private deleteMode = false;
  private _selectedFurnitureType: string | null = null;
  private _selectedFurnitureId: string | null = null;
  // Rotation of the currently selected furniture type (for placement
  // footprint lookup). Initial value matches `_selectedFurnitureType =
  // null` (no selection = no rotation).
  private _selectedFurnitureRotation = 0;
  private dragging: { id: string } | null = null;
  private callbacks: EditorCallbacks | null = null;
  private _mouseGridX = -1;
  private _mouseGridY = -1;
  private touchStartPos: { x: number; y: number } | null = null;
  private touchCurrentPos: { x: number; y: number } | null = null;
  private lastTapTime = 0;
  private lastTapFurnitureId: string | null = null;
  private pinchStartDist = 0;
  private pinchStartZoom = 1;
  private cameraZoom = 1;
  private touchDragging: TouchDragState | null = null;
  private touchMoved = false;
  private attached = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly config: EditorControllerConfig,
    private readonly host: EditorControllerHost,
    private readonly sounds: EditorControllerSounds,
    private readonly now: () => number = Date.now,
  ) {}

  get editorMode(): boolean { return this._editorMode; }
  get selectedFurnitureType(): string | null { return this._selectedFurnitureType; }
  get selectedFurnitureId(): string | null { return this._selectedFurnitureId; }
  get mouseGridX(): number { return this._mouseGridX; }
  get mouseGridY(): number { return this._mouseGridY; }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.canvas.addEventListener('mousemove', this.handleMouseMove);
    this.canvas.addEventListener('mousedown', this.handleMouseDown);
    this.canvas.addEventListener('mouseup', this.handleMouseUp);
    this.canvas.addEventListener('mouseleave', this.handleMouseLeave);
    this.canvas.addEventListener('contextmenu', this.handleContextMenu);
    this.canvas.addEventListener('touchstart', this.handleTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this.handleTouchMove, { passive: false });
    this.canvas.addEventListener('touchend', this.handleTouchEnd, { passive: false });
    this.canvas.addEventListener('touchcancel', this.handleTouchCancel, { passive: false });
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.canvas.removeEventListener('mousemove', this.handleMouseMove);
    this.canvas.removeEventListener('mousedown', this.handleMouseDown);
    this.canvas.removeEventListener('mouseup', this.handleMouseUp);
    this.canvas.removeEventListener('mouseleave', this.handleMouseLeave);
    this.canvas.removeEventListener('contextmenu', this.handleContextMenu);
    this.canvas.removeEventListener('touchstart', this.handleTouchStart);
    this.canvas.removeEventListener('touchmove', this.handleTouchMove);
    this.canvas.removeEventListener('touchend', this.handleTouchEnd);
    this.canvas.removeEventListener('touchcancel', this.handleTouchCancel);
  }

  setEditorMode(enabled: boolean): void {
    this._editorMode = enabled;
    this._selectedFurnitureType = null;
    this._selectedFurnitureId = null;
    this.lastTapTime = 0;
    this.lastTapFurnitureId = null;
    this.canvas.style.cursor = 'default';
  }

  setEditorCallbacks(callbacks: EditorCallbacks): void { this.callbacks = callbacks; }
  setDeleteMode(enabled: boolean): void { this.deleteMode = enabled; }

  setSelectedFurnitureType(type: string | null): void {
    this._selectedFurnitureType = type;
    this._selectedFurnitureId = null;
  }

  setSelectedFurnitureId(id: string | null): void {
    this._selectedFurnitureId = id;
    this._selectedFurnitureType = null;
  }

  // Issue #164 follow-up: clamp the anchor so the placed footprint stays
  // inside the obstacle map. The obstacle map blocks the outermost tile
  // (1-tile border for walls), so the anchor must satisfy
  // `anchor + footprint - 1 ≤ gridW - 1` (and similarly for height).
  // - 1×1 chair → `footprintW = 1` → bound `[1, gridW - 2]`.
  // - 3×2 DESK  → `footprintW = 3` → bound `[1, gridW - 4]` so the
  //   anchor's rightmost tile doesn't enter the wall.
  // - 2×3 LARGE_PLANT rotated 90° → `footprintW = 3` → same as DESK.
  // The previous `gridWidth - 3` clamp was correct only for the
  // worst-case 3-tile footprint, which left 1×1 furniture two tiles
  // short of the wall. The new clamp threads the footprint through
  // for accuracy.
  private clampX(gridX: number, footprintW = 1): number {
    return Math.max(1, Math.min(this.config.gridWidth - footprintW, gridX));
  }

  private clampY(gridY: number, footprintH = 1): number {
    return Math.max(1, Math.min(this.config.gridHeight - footprintH, gridY));
  }

  private handleMouseMove = (event: MouseEvent): void => {
    const result = this.host.screenToGrid(event.clientX, event.clientY);
    if (!result) return;
    const { gridX, gridY } = result;
    this._mouseGridX = gridX;
    this._mouseGridY = gridY;

    if (this.dragging) {
      // Footprint-aware clamp: for a DESK (3×2) an anchor at `gridW - 2`
      // would extend into the wall — only clamp up to `gridW - 3`. For a
      // 1×1 chair, the anchor can reach `gridW - 2`.
      const fp = this.host.getFootprintForId(this.dragging.id);
      const fw = fp?.width ?? 1;
      const fh = fp?.height ?? 1;
      this.host.previewFurnitureMove(this.dragging.id, this.clampX(gridX, fw), this.clampY(gridY, fh));
    }

    if (this._editorMode) {
      if (this._selectedFurnitureType) {
        this.canvas.style.cursor = 'crosshair';
      } else {
        const overFurniture = this.host.findFurnitureAt(gridX, gridY);
        this.canvas.style.cursor = overFurniture
          ? (this.deleteMode ? 'pointer' : this.dragging ? 'grabbing' : 'grab')
          : 'default';
      }
    } else if (this.host.hasSelectedAgent()) {
      this.canvas.style.cursor = 'crosshair';
    } else {
      this.canvas.style.cursor = this.host.findCharacterAt(gridX, gridY) ? 'pointer' : 'default';
    }
  };

  private handleMouseDown = (event: MouseEvent): void => {
    if (!this._editorMode) return;
    const result = this.host.screenToGrid(event.clientX, event.clientY);
    if (!result) return;
    const { gridX, gridY } = result;

    if (event.button !== 0) return;
    if (this._selectedFurnitureType) {
      // Footprint-aware placement: clamp to the anchor range that keeps
      // the selected furniture's footprint inside the obstacle map.
      const fp = this.host.getFootprint(this._selectedFurnitureType, this._selectedFurnitureRotation);
      const fw = fp?.width ?? 1;
      const fh = fp?.height ?? 1;
      this.callbacks?.onPlaceFurniture(
        this._selectedFurnitureType,
        this.clampX(gridX, fw),
        this.clampY(gridY, fh),
      );
      this.sounds.place();
      return;
    }

    const hit = this.host.findFurnitureAt(gridX, gridY);
    if (hit) {
      if (this.deleteMode) {
        this.callbacks?.onSelectFurniture(hit.id);
        return;
      }
      this._selectedFurnitureId = hit.id;
      this.callbacks?.onSelectFurniture(hit.id);
      this.dragging = { id: hit.id };
      this.sounds.pickup();
    } else {
      this._selectedFurnitureId = null;
      this.callbacks?.onSelectFurniture(null);
    }
  };

  private handleMouseUp = (event: MouseEvent): void => {
    if (!this._editorMode || !this.dragging) return;
    if (event.button !== 0) return;
    const result = this.host.screenToGrid(event.clientX, event.clientY);
    if (!result) return;
    // Footprint-aware drop: clamp using the dragged furniture's footprint.
    const fp = this.host.getFootprintForId(this.dragging.id);
    const fw = fp?.width ?? 1;
    const fh = fp?.height ?? 1;
    this.callbacks?.onMoveFurniture(
      this.dragging.id,
      this.clampX(result.gridX, fw),
      this.clampY(result.gridY, fh),
    );
    this.sounds.place();
    this.dragging = null;
  };

  private handleMouseLeave = (): void => {
    this._mouseGridX = -1;
    this._mouseGridY = -1;
    this.dragging = null;
    this.canvas.style.cursor = 'default';
  };

  private handleContextMenu = (event: MouseEvent): void => {
    if (!this._editorMode) return;
    event.preventDefault();
    const result = this.host.screenToGrid(event.clientX, event.clientY);
    if (!result) return;
    const rotated = this.host.rotateFurnitureAt(result.gridX, result.gridY);
    if (rotated) this.callbacks?.onRotateFurniture(rotated.id, rotated.rotation);
  };

  private handleTouchStart = (event: TouchEvent): void => {
    event.preventDefault();
    if (event.touches.length === 2) {
      this.touchDragging = null;
      this.touchStartPos = null;
      this.touchCurrentPos = null;
      this.touchMoved = true;
      this.lastTapTime = 0;
      this.lastTapFurnitureId = null;
      this.pinchStartDist = touchDistance(event.touches[0], event.touches[1]);
      this.pinchStartZoom = this.cameraZoom;
      return;
    }

    const touch = event.touches[0];
    this.touchStartPos = { x: touch.clientX, y: touch.clientY };
    this.touchCurrentPos = { x: touch.clientX, y: touch.clientY };
    this.touchMoved = false;

    const result = this.host.screenToGrid(touch.clientX, touch.clientY);
    if (!result) return;
    this._mouseGridX = result.gridX;
    this._mouseGridY = result.gridY;

    if (this._editorMode && event.touches.length === 1 && !this._selectedFurnitureType) {
      const hit = this.host.findFurnitureAt(result.gridX, result.gridY);
      if (hit) {
        if (this.deleteMode) {
          this.callbacks?.onSelectFurniture(hit.id);
        } else {
          this.touchDragging = {
            id: hit.id,
            offsetX: result.gridX - hit.x,
            offsetY: result.gridY - hit.y,
          };
          this._selectedFurnitureId = hit.id;
          this.callbacks?.onSelectFurniture(hit.id);
        }
      }
    }
  };

  private handleTouchMove = (event: TouchEvent): void => {
    event.preventDefault();
    if (event.touches.length === 2) {
      const distance = touchDistance(event.touches[0], event.touches[1]);
      if (!this.pinchStartDist || this.pinchStartDist <= 0) {
        if (distance <= 0) return;
        this.pinchStartDist = distance;
        this.pinchStartZoom = this.cameraZoom;
      }
      const scale = distance / this.pinchStartDist;
      this.cameraZoom = Math.max(1, Math.min(4, this.pinchStartZoom * scale));
      this.canvas.style.transform = `scale(${this.cameraZoom})`;
      this.canvas.style.transformOrigin = 'center center';
      return;
    }

    if (!this.touchStartPos) return;
    const touch = event.touches[0];
    const dx = touch.clientX - this.touchStartPos.x;
    const dy = touch.clientY - this.touchStartPos.y;
    if (Math.abs(dx) > EditorController.TAP_THRESHOLD || Math.abs(dy) > EditorController.TAP_THRESHOLD) {
      this.touchMoved = true;
    }
    this.touchCurrentPos = { x: touch.clientX, y: touch.clientY };

    const result = this.host.screenToGrid(touch.clientX, touch.clientY);
    if (!result) return;
    this._mouseGridX = result.gridX;
    this._mouseGridY = result.gridY;

    // A furniture hit becomes a drag only after the touch crosses the
    // tap threshold. This keeps ordinary finger jitter eligible for a tap.
    if (this._editorMode && this.touchDragging && this.touchMoved) {
      // Footprint-aware touch drag clamp.
      const fp = this.host.getFootprintForId(this.touchDragging.id);
      const fw = fp?.width ?? 1;
      const fh = fp?.height ?? 1;
      this.host.previewFurnitureMove(
        this.touchDragging.id,
        this.clampX(result.gridX - this.touchDragging.offsetX, fw),
        this.clampY(result.gridY - this.touchDragging.offsetY, fh),
      );
    }
  };

  private handleTouchEnd = (event: TouchEvent): void => {
    event.preventDefault();
    if (event.touches.length > 0) return;

    if (this._editorMode) {
      const dragging = this.touchDragging;
      this.touchDragging = null;
      if (dragging && this.touchMoved) {
        this.lastTapTime = 0;
        this.lastTapFurnitureId = null;
        if (this.touchCurrentPos) {
          const result = this.host.screenToGrid(this.touchCurrentPos.x, this.touchCurrentPos.y);
          if (result) {
            // Footprint-aware touch drop clamp.
            const fp = this.host.getFootprintForId(dragging.id);
            const fw = fp?.width ?? 1;
            const fh = fp?.height ?? 1;
            this.callbacks?.onMoveFurniture(
              dragging.id,
              this.clampX(result.gridX - dragging.offsetX, fw),
              this.clampY(result.gridY - dragging.offsetY, fh),
            );
            this.sounds.place();
          }
        }
      } else if (!this.touchMoved && this.touchStartPos) {
        const result = this.host.screenToGrid(this.touchStartPos.x, this.touchStartPos.y);
        if (!result) {
          this.touchStartPos = null;
          this.touchCurrentPos = null;
          return;
        }

        const now = this.now();
        if (
          dragging
          && dragging.id === this.lastTapFurnitureId
          && now - this.lastTapTime < EditorController.DOUBLE_TAP_MS
        ) {
          const rotated = this.host.rotateFurnitureAt(result.gridX, result.gridY);
          if (rotated) {
            this.callbacks?.onRotateFurniture(rotated.id, rotated.rotation);
            this.sounds.place();
            this.lastTapTime = 0;
            this.lastTapFurnitureId = null;
            this.touchStartPos = null;
            this.touchCurrentPos = null;
            return;
          }
        }
        this.lastTapTime = now;
        this.lastTapFurnitureId = dragging?.id ?? null;

        if (this._selectedFurnitureType) {
          this.callbacks?.onPlaceFurniture(this._selectedFurnitureType, result.gridX, result.gridY);
          this.sounds.place();
        }
      }
      this.touchStartPos = null;
      this.touchCurrentPos = null;
      return;
    }

    if (this.touchMoved || !this.touchStartPos) {
      this.touchStartPos = null;
      this.touchCurrentPos = null;
      return;
    }

    const result = this.host.screenToGrid(this.touchStartPos.x, this.touchStartPos.y);
    if (result) this.host.handleTouchGridTap(result.gridX, result.gridY);
    this.touchStartPos = null;
    this.touchCurrentPos = null;
  };

  private handleTouchCancel = (): void => {
    this.touchStartPos = null;
    this.touchCurrentPos = null;
    this.touchDragging = null;
    this.touchMoved = false;
    this.lastTapTime = 0;
    this.lastTapFurnitureId = null;
    this._mouseGridX = -1;
    this._mouseGridY = -1;
  };
}
