import React, { useState, useCallback, useEffect, useRef } from 'react';
import { PixelOffice } from './components/PixelOffice';
import { AgentSidebar } from './components/AgentSidebar';
import { AgentDetailPanel } from './components/AgentDetailPanel';
import { LayoutEditor } from './components/LayoutEditor';
import { SoundControls } from './components/SoundControls';
import { RoomSwitcher } from './components/RoomSwitcher';
import MessageTicker from './components/MessageTicker';
import { useAgentStore } from './hooks/useAgentStore';
import { useLayoutStore } from './hooks/useLayoutStore';
import { sfx } from './audio/SoundFX';
import { newEntityId } from './util/id';
import type { PlacedFurniture } from '../shared/types';
import './App.css';

export const App: React.FC = () => {
  const { agents, connected, toggleAgent, toggleAll, updateTags, updateRecipe, activeRoomId, setActiveRoomId, roomAgents } = useAgentStore();
  const {
    layouts, activeLayout, isDirty, saveStatus, catalog,
    loadLayoutById, saveActiveLayout, createLayout, deleteLayout, updateFurniture,
  } = useLayoutStore();

  const [editorMode, setEditorMode] = useState(false);
  const [selectedFurnitureType, setSelectedFurnitureType] = useState<string | null>(null);
  const [selectedFurnitureId, setSelectedFurnitureId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [deleteMode, setDeleteMode] = useState(false);
  // Agents drawer (≤1024px the sidebar is off-canvas; see AgentSidebar.css)
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const enabledAgentCount = agents.filter(a => a.pixelEnabled).length;

  // Escape closes the agents drawer.
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebarOpen]);

  // Close the drawer when leaving drawer mode (viewport crosses above
  // 1024px) — otherwise the backdrop would linger over the desktop layout.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(min-width: 1025px)');
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setSidebarOpen(false);
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  // The top bar wraps to two (very narrow: three) rows depending on width,
  // so --topbar-h is derived from the RENDERED header height rather than a
  // fixed guess. CSS values in App.css remain the pre-JS fallback. Editor
  // toolbar, sidebar, and drawer all offset from this var.
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const header = headerRef.current;
    if (!header || typeof ResizeObserver === 'undefined') return;
    const syncTopbarHeight = () => {
      document.documentElement.style.setProperty(
        '--topbar-h',
        `${Math.ceil(header.getBoundingClientRect().height)}px`,
      );
    };
    syncTopbarHeight();
    const observer = new ResizeObserver(syncTopbarHeight);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  // Place new furniture
  const handlePlaceFurniture = useCallback((type: string, gridX: number, gridY: number) => {
    if (!activeLayout) return;
    const newFurniture: PlacedFurniture[] = [
      ...activeLayout.furniture,
      {
        id: newEntityId(type.toLowerCase()),
        type,
        x: gridX,
        y: gridY,
        rotation: 0,
      },
    ];
    updateFurniture(newFurniture);
  }, [activeLayout, updateFurniture]);

  // Move existing furniture
  const handleMoveFurniture = useCallback((id: string, gridX: number, gridY: number) => {
    if (!activeLayout) return;
    const newFurniture = activeLayout.furniture.map(f =>
      f.id === id ? { ...f, x: gridX, y: gridY } : f
    );
    updateFurniture(newFurniture);
  }, [activeLayout, updateFurniture]);

  // Select furniture (or delete in delete mode)
  const handleSelectFurniture = useCallback((id: string | null) => {
    if (deleteMode && id) {
      // In delete mode, clicking furniture deletes it immediately.
      // Use functional updater so rapid clicks always read the latest list.
      updateFurniture(prev => prev.filter(f => f.id !== id));
      sfx.click();
      return;
    }
    setSelectedFurnitureId(id);
    setSelectedFurnitureType(null);
  }, [deleteMode, updateFurniture]);

  // Toolbar rotations increment the latest store value. Canvas rotations pass
  // the exact angle already applied by GameEngine, avoiding a second 90° turn
  // when the engine and React temporarily share the same furniture object.
  const handleRotateFurniture = useCallback((id: string, rotation?: number) => {
    updateFurniture(furniture => furniture.map(f =>
      f.id === id
        ? { ...f, rotation: rotation ?? ((f.rotation || 0) + 90) % 360 }
        : f
    ));
  }, [updateFurniture]);

  // Delete furniture
  const handleDeleteFurniture = useCallback((id: string) => {
    if (!activeLayout) return;
    const newFurniture = activeLayout.furniture.filter(f => f.id !== id);
    updateFurniture(newFurniture);
    setSelectedFurnitureId(null);
  }, [activeLayout, updateFurniture]);

  // Character click handler
  const handleCharacterClick = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
  }, []);

  // Toggle delete mode
  const handleToggleDeleteMode = useCallback(() => {
    setDeleteMode(prev => {
      const next = !prev;
      if (next) {
        // Entering delete mode — clear placement and selection
        setSelectedFurnitureType(null);
        setSelectedFurnitureId(null);
      }
      return next;
    });
  }, []);

  return (
    <div className="app">
      <header className="app-header" ref={headerRef}>
        <h1 aria-label="OpenClaw Pixel Agents"><span aria-hidden="true">🖥️ </span><span className="brand-text">OpenClaw Pixel Agents</span></h1>
        <RoomSwitcher
          activeRoomId={activeRoomId}
          onRoomChange={setActiveRoomId}
          agents={agents}
        />
        <div className="header-controls">
          <button
            className={`sidebar-toggle ${sidebarOpen ? 'active' : ''}`}
            onClick={() => setSidebarOpen(open => !open)}
            aria-label="Toggle agents panel"
            aria-expanded={sidebarOpen}
          >
            👥 {enabledAgentCount}
          </button>
          <button
            className={`editor-toggle ${editorMode ? 'active' : ''}`}
            onClick={() => setEditorMode(!editorMode)}
          >
            {editorMode ? '✏️ Editor ON' : '✏️ Editor'}
          </button>
          <span
            className={`connection-status ${connected ? 'connected' : 'disconnected'}`}
            aria-label={connected ? 'Connected' : 'Disconnected'}
          >
            {connected ? '●' : '○'}<span className="status-text">{connected ? ' Connected' : ' Disconnected'}</span>
          </span>
          <SoundControls />
        </div>
      </header>
      <main className="app-main">
        <div className="office-wrapper">
          {editorMode && (
            <LayoutEditor
              catalog={catalog}
              activeLayout={activeLayout}
              isDirty={isDirty}
              saveStatus={saveStatus}
              layouts={layouts}
              editorMode={editorMode}
              selectedFurnitureType={selectedFurnitureType}
              selectedFurnitureId={selectedFurnitureId}
              deleteMode={deleteMode}
              onSelectFurnitureType={(type) => {
                setDeleteMode(false);
                setSelectedFurnitureType(type);
              }}
              onSelectFurnitureId={handleSelectFurniture}
              onPlaceFurniture={handlePlaceFurniture}
              onMoveFurniture={handleMoveFurniture}
              onRotateFurniture={handleRotateFurniture}
              onDeleteFurniture={handleDeleteFurniture}
              onToggleDeleteMode={handleToggleDeleteMode}
              onSave={() => saveActiveLayout()}
              onLoad={loadLayoutById}
              onCreate={createLayout}
              onDeleteLayout={deleteLayout}
              onToggleEditor={() => { setEditorMode(false); setDeleteMode(false); }}
            />
          )}
          <PixelOffice
            agents={roomAgents}
            editorMode={editorMode}
            deleteMode={deleteMode}
            activeLayout={activeLayout}
            selectedFurnitureType={selectedFurnitureType}
            onPlaceFurniture={handlePlaceFurniture}
            onSelectFurniture={handleSelectFurniture}
            onMoveFurniture={handleMoveFurniture}
            onRotateFurniture={handleRotateFurniture}
            onCharacterClick={handleCharacterClick}
          />
        </div>
      </main>
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      {/* Sidebar + backdrop are direct .app children: inside .app-main's
          z-10 stacking context they'd be capped below the ticker (150) and
          top bar (300). position:fixed keeps geometry identical. */}
      <AgentSidebar
        agents={agents}
        onToggle={toggleAgent}
        onToggleAll={toggleAll}
        onSelectAgent={setSelectedAgentId}
        onUpdateTags={updateTags}
        onUpdateRecipe={updateRecipe}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <AgentDetailPanel
        agent={selectedAgentId ? agents.find(a => a.id === selectedAgentId) ?? null : null}
        onClose={() => setSelectedAgentId(null)}
      />
      <MessageTicker />
    </div>
  );
};
