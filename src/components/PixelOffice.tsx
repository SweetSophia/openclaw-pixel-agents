import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { AgentState, AgentActivity, PlacedFurniture } from '../../shared/types';
import type { LayoutDoc } from '../hooks/useLayoutStore';
import { GameEngine } from '../game/GameEngine';
import './PixelOffice.css';

interface Props {
  agents: AgentState[];
  editorMode: boolean;
  activeLayout: LayoutDoc | null;
  selectedFurnitureType: string | null;
  onPlaceFurniture: (type: string, gridX: number, gridY: number) => void;
  onSelectFurniture: (id: string | null) => void;
  onMoveFurniture: (id: string, gridX: number, gridY: number) => void;
  onCharacterClick?: (agentId: string) => void;
}

function activityToAnimState(activity: AgentActivity): string {
  switch (activity) {
    case 'typing': case 'running_command': return 'typing';
    case 'thinking': case 'reading': return 'reading';
    case 'waiting_input': return 'waiting';
    case 'sleeping': return 'idle';
    case 'error': return 'error';
    default: return 'idle';
  }
}

export const PixelOffice: React.FC<Props> = ({
  agents, editorMode, activeLayout,
  selectedFurnitureType,
  onPlaceFurniture, onSelectFurniture, onMoveFurniture,
  onCharacterClick,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Initialize engine
  useEffect(() => {
    if (!canvasRef.current || engineRef.current) return;
    const ac = new AbortController();
    const engine = new GameEngine(canvasRef.current, {
      tileSize: 32, gridWidth: 24, gridHeight: 16,
    });
    engineRef.current = engine;

    engine.init(ac.signal).then(() => {
      if (ac.signal.aborted) return;
      engine.start();
      setLoaded(true);
    });

    return () => { ac.abort(); engine.stop(); engineRef.current = null; };
  }, []);

  // Wire editor callbacks (stable ref)
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setEditorCallbacks({ onPlaceFurniture, onSelectFurniture, onMoveFurniture });
  }, [onPlaceFurniture, onSelectFurniture, onMoveFurniture]);

  // Wire game callbacks (character click)
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !onCharacterClick) return;
    engine.setGameCallbacks({ onCharacterClick });
  }, [onCharacterClick]);

  // Sync editor mode
  useEffect(() => {
    engineRef.current?.setEditorMode(editorMode);
  }, [editorMode]);

  // Sync selected furniture type
  useEffect(() => {
    engineRef.current?.setSelectedFurnitureType(selectedFurnitureType);
  }, [selectedFurnitureType]);

  // Load layout data into engine
  useEffect(() => {
    if (!engineRef.current || !activeLayout) return;
    engineRef.current.setLayout(activeLayout.furniture, activeLayout.seats);
  }, [activeLayout?.id, activeLayout?.furniture?.length]);

  // Sync agent states
  useEffect(() => {
    if (!engineRef.current || !loaded) return;
    const engine = engineRef.current;

    const currentIds = engine.getCharacterIds();
    const agentIds = agents.map(a => a.id);
    const activeIds = agents.filter(a => a.pixelEnabled).map(a => a.id);

    // Remove characters no longer in this room's agent list (handles room switches)
    for (const id of currentIds) {
      if (!agentIds.includes(id) || !activeIds.includes(id)) {
        engine.removeCharacter(id);
      }
    }

    for (const agent of agents) {
      if (!agent.pixelEnabled) continue;
      const animState = activityToAnimState(agent.activity);
      if (!currentIds.includes(agent.id)) {
        const seat = engine.assignSeat(agent.id);
        engine.addCharacter({
          id: agent.id, name: agent.name,
          x: seat.x, y: seat.y,
          state: animState, model: agent.model, spriteId: agent.characterSpriteId,
          lastMessage: agent.lastMessage,
        });
      } else {
        engine.updateCharacter(agent.id, {
          state: animState, model: agent.model, name: agent.name,
          lastMessage: agent.lastMessage,
        });
      }

      // Sync sub-agents
      if (agent.subAgents) {
        const activeSubIds = new Set(agent.subAgents.map(s => s.id));
        // Spawn new sub-agents
        for (const sub of agent.subAgents) {
          if (sub.status === 'running' && !engine.getCharacterIds().includes(sub.id)) {
            engine.spawnSubAgent(agent.id, sub.id, sub.name || sub.id);
          } else if (sub.status !== 'running') {
            engine.killSubAgent(sub.id);
          }
        }
        // Kill sub-agents no longer in the list
        for (const cid of engine.getCharacterIds()) {
          if (cid.startsWith('sub-') && !activeSubIds.has(cid)) {
            engine.killSubAgent(cid);
          }
        }
      }
    }
  }, [agents, loaded]);

  return (
    <div className="pixel-office" style={{ position: 'relative' }}>
      <canvas ref={canvasRef} className="office-canvas" />
      {editorMode && (
        <div className="editor-badge">✏️ EDIT MODE</div>
      )}
    </div>
  );
};
