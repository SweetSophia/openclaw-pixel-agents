import React, { useState, useCallback } from 'react';
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
import type { PlacedFurniture } from '../shared/types';
import './App.css';

export const App: React.FC = () => {
  const { agents, connected, toggleAgent, toggleAll, updateTags, updateRecipe, activeRoomId, setActiveRoomId, roomAgents } = useAgentStore();
  const {
    layouts, activeLayout, catalog,
    loadLayoutById, saveActiveLayout, createLayout, deleteLayout, updateFurniture,
  } = useLayoutStore();

  const [editorMode, setEditorMode] = useState(false);
  const [selectedFurnitureType, setSelectedFurnitureType] = useState<string | null>(null);
  const [selectedFurnitureId, setSelectedFurnitureId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [deleteMode, setDeleteMode] = useState(false);

  // Place new furniture
  const handlePlaceFurniture = useCallback((type: string, gridX: number, gridY: number) => {
    if (!activeLayout) return;
    const newFurniture: PlacedFurniture[] = [
      ...activeLayout.furniture,
      {
        id: `${type.toLowerCase()}-${Date.now()}`,
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

  // Rotate selected furniture
  const handleRotateFurniture = useCallback((id: string) => {
    if (!activeLayout) return;
    const newFurniture = activeLayout.furniture.map(f =>
      f.id === id ? { ...f, rotation: ((f.rotation || 0) + 90) % 360 } : f
    );
    updateFurniture(newFurniture);
  }, [activeLayout, updateFurniture]);

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
      <header className="app-header">
        <h1>🖥️ OpenClaw Pixel Agents</h1>
        <div className="header-controls">
          <button
            className={`editor-toggle ${editorMode ? 'active' : ''}`}
            onClick={() => setEditorMode(!editorMode)}
          >
            {editorMode ? '✏️ Editor ON' : '✏️ Editor'}
          </button>
          <span className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? '● Connected' : '○ Disconnected'}
          </span>
          <SoundControls />
        </div>
      </header>
      <RoomSwitcher
        activeRoomId={activeRoomId}
        onRoomChange={setActiveRoomId}
        agents={agents}
      />
      <main className="app-main">
        <div className="office-wrapper">
          {editorMode && (
            <LayoutEditor
              catalog={catalog}
              activeLayout={activeLayout}
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
            onCharacterClick={handleCharacterClick}
          />
        </div>
        <AgentSidebar
          agents={agents}
          onToggle={toggleAgent}
          onToggleAll={toggleAll}
          onSelectAgent={setSelectedAgentId}
          onUpdateTags={updateTags}
          onUpdateRecipe={updateRecipe}
        />
      </main>
      <AgentDetailPanel
        agent={selectedAgentId ? agents.find(a => a.id === selectedAgentId) ?? null : null}
        onClose={() => setSelectedAgentId(null)}
      />
      <MessageTicker />
    </div>
  );
};
