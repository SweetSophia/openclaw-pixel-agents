import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { boundView, fitScale, MAX_VIEW_ZOOM, zoomView, type View } from '../game/viewportGeometry';
import './CanvasViewport.css';

export interface CanvasViewportHandle { zoomAt(factor: number, clientX: number, clientY: number, dx?: number, dy?: number): void }
interface Props { width: number; height: number; interactionKey: string; children: React.ReactNode; overlay?: React.ReactNode }
const FIT: View = { zoom: 1, x: 0, y: 0 };

export const CanvasViewport = forwardRef<CanvasViewportHandle, Props>(function CanvasViewport(
  { width, height, interactionKey, children, overlay }, ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<HTMLDivElement>(null);
  const panButtonRef = useRef<HTMLButtonElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const [view, setView] = useState(FIT);
  const [panning, setPanning] = useState(false);
  const world = { width, height };
  const bounded = boundView(view, available, world);
  const scale = fitScale(available, world) * bounded.zoom;

  useLayoutEffect(() => {
    const root = rootRef.current!;
    const stage = stageRef.current!;
    const app = root.closest('.app');
    const summary = app?.querySelector('.activity-toggle');
    const update = () => {
      if (summary && app instanceof HTMLElement) {
        const dock = summary.closest('.activity-dock')!;
        const gap = parseFloat(getComputedStyle(dock).bottom) || 0;
        const bottom = `${summary.getBoundingClientRect().height + gap + 12}px`;
        if (app.style.getPropertyValue('--office-bottom') !== bottom) app.style.setProperty('--office-bottom', bottom);
      }
      const rect = stage.getBoundingClientRect();
      setAvailable(old => old.width === rect.width && old.height === rect.height ? old : { width: rect.width, height: rect.height });
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    for (const element of [stage, summary]) if (element) observer?.observe(element);
    // The dock's media-query bottom gap can change without a size change.
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect(); window.removeEventListener('resize', update);
      if (app instanceof HTMLElement) app.style.removeProperty('--office-bottom');
    };
  }, []);

  useEffect(() => { setPanning(false); pointers.current.clear(); }, [interactionKey]);
  useEffect(() => {
    pointers.current.clear();
    if (panning) panRef.current?.focus();
    const cancel = () => pointers.current.clear();
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, [panning]);

  const zoomAt = (factor: number, clientX?: number, clientY?: number, dx = 0, dy = 0) => {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const rect = stageRef.current!.getBoundingClientRect();
    const point = { x: clientX === undefined ? 0 : clientX - rect.left - rect.width / 2,
      y: clientY === undefined ? 0 : clientY - rect.top - rect.height / 2 };
    setView(old => zoomView(boundView(old, available, world), factor, point, available, world, { x: dx, y: dy }));
  };
  useImperativeHandle(ref, () => ({ zoomAt }));

  const fit = () => { setView(FIT); setPanning(false); pointers.current.clear(); };
  const move = (dx: number, dy: number) => setView(old => {
    const current = boundView(old, available, world);
    return boundView({ ...current, x: current.x + dx, y: current.y + dy }, available, world);
  });
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const before = [...pointers.current.values()];
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (before.length === 1) { move(event.clientX - previous.x, event.clientY - previous.y); return; }
    const after = [...pointers.current.values()];
    const center = (points: typeof before) => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
    const distance = (points: typeof before) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    const oldCenter = center(before), newCenter = center(after);
    if (distance(before) > 0) zoomAt(distance(after) / distance(before), newCenter.x, newCenter.y,
      newCenter.x - oldCenter.x, newCenter.y - oldCenter.y);
  };
  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => { pointers.current.delete(event.pointerId); };

  return <div ref={rootRef} className="canvas-controller">
    <div className="canvas-controls" role="group" aria-label="Office view controls">
      <button type="button" onClick={fit} aria-label="Fit office">Fit</button>
      <button type="button" onClick={() => zoomAt(0.8)} disabled={bounded.zoom <= 1} aria-label="Zoom out">−</button>
      <span className="canvas-zoom" title="Office zoom relative to Fit">{Math.round(bounded.zoom * 100)}%</span>
      <button type="button" onClick={() => zoomAt(1.25)} disabled={bounded.zoom >= MAX_VIEW_ZOOM} aria-label="Zoom in">+</button>
      <button ref={panButtonRef} type="button" aria-label="Pan office" aria-pressed={panning}
        onClick={() => setPanning(old => !old)}>✥ Pan</button>
    </div>
    <div ref={stageRef} className="office-viewport">
      <div className="office-world" style={{ width: width * scale, height: height * scale,
        left: bounded.x ? `calc(50% + ${bounded.x}px)` : '50%', top: bounded.y ? `calc(50% + ${bounded.y}px)` : '50%' }}>
        {children}
      </div>
      {panning && <div ref={panRef} className="office-pan-surface" role="region" aria-label="Pan office view" tabIndex={0}
        onContextMenu={event => event.preventDefault()}
        onPointerDown={event => {
          if (event.button !== 0 || pointers.current.size >= 2) return;
          event.preventDefault();
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }} onPointerMove={pointerMove} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={endPointer}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPanning(false); panButtonRef.current?.focus(); return; }
          const directions: Record<string, [number, number]> = { ArrowLeft: [-48, 0], ArrowRight: [48, 0], ArrowUp: [0, -48], ArrowDown: [0, 48] };
          const delta = directions[event.key];
          if (delta) { event.preventDefault(); move(...delta); }
        }}>
        <span className="pan-instructions">Drag to pan · Arrow keys to move · Esc to return</span>
      </div>}
      {overlay}
    </div>
  </div>;
});
