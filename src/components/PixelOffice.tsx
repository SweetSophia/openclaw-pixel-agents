import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { AgentState, PlacedFurniture } from '../../shared/types';
import type { LayoutDoc } from '../hooks/useLayoutStore';
import { GameEngine } from '../game/GameEngine';
import { recomposeAgent } from '../game/SpriteLoader';
import type { CharacterRecipe } from '../game/CharacterComposer';
import './PixelOffice.css';

interface Props {
  agents: AgentState[];
  editorMode: boolean;
  deleteMode: boolean;
  activeLayout: LayoutDoc | null;
  selectedFurnitureType: string | null;
  onPlaceFurniture: (type: string, gridX: number, gridY: number) => void;
  onSelectFurniture: (id: string | null) => void;
  onMoveFurniture: (id: string, gridX: number, gridY: number) => void;
  onCharacterClick?: (agentId: string) => void;
}

export const PixelOffice: React.FC<Props> = ({
  agents, editorMode, deleteMode, activeLayout,
  selectedFurnitureType,
  onPlaceFurniture, onSelectFurniture, onMoveFurniture,
  onCharacterClick,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const [loaded, setLoaded] = useState(false);
  const prevRecipesRef = useRef<Record<string, string>>({});

  // Initialize engine
  useEffect(() => {
    if (!canvasRef.current || engineRef.current) return;
    const ac = new AbortController();
    const engine = new GameEngine(canvasRef.current, {
      tileSize: 32, gridWidth: 24, gridHeight: 16,
    });
    engineRef.current = engine;

    engine.init(ac.signal, import.meta.env.DEV).then(() => {
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

  // Sync delete mode into engine so it can suppress drag/pickup SFX
  useEffect(() => {
    engineRef.current?.setDeleteMode(deleteMode);
  }, [deleteMode]);

  // Sync selected furniture type
  useEffect(() => {
    engineRef.current?.setSelectedFurnitureType(selectedFurnitureType);
  }, [selectedFurnitureType]);

  // Load layout data into engine
  // Use serialised keys so moves, rotations, deletions, and seat changes are all detected
  const furnitureKey = activeLayout?.furniture
    ? JSON.stringify(activeLayout.furniture.map(f => `${f.id}:${f.x},${f.y},${f.rotation}`))
    : '';
  const seatsKey = activeLayout?.seats
    ? JSON.stringify(activeLayout.seats)
    : '';
  useEffect(() => {
    if (!engineRef.current || !activeLayout) return;
    engineRef.current.setLayout(activeLayout.furniture, activeLayout.seats);
  }, [activeLayout?.id, furnitureKey, seatsKey]);

  // Sync agent recipes → recompute sprites
  useEffect(() => {
    if (!engineRef.current || !loaded) return;
    const prev = prevRecipesRef.current;
    const curr: Record<string, string> = {};
    for (const agent of agents) {
      if (!agent.recipe || !agent.pixelEnabled) continue;
      const key = `${agent.recipe.bodyIndex}-${agent.recipe.hairIndex}-${agent.recipe.outfitIndex}`;
      curr[agent.id] = key;
      if (prev[agent.id] !== key) {
        const sprite = recomposeAgent(agent.id, agent.recipe);
        if (sprite) engineRef.current!.setCharacterSprite(agent.id, sprite);
      }
    }
    prevRecipesRef.current = curr;
  }, [agents, loaded]);

  // Sync agent states
  useEffect(() => {
    if (!engineRef.current || !loaded) return;
    const engine = engineRef.current;

    const currentIdsArray = engine.getCharacterIds();
    const currentIds = new Set(currentIdsArray);
    const agentIds = new Set(agents.map(a => a.id));
    const activeIds = new Set(agents.filter(a => a.pixelEnabled).map(a => a.id));

    // Remove characters no longer in this room's agent list (handles room switches)
    // Skip sub-agent IDs — they are managed by the dedicated sub-agent cleanup loop below
    for (const id of currentIdsArray) {
      if (id.startsWith('sub-')) continue;
      if (!agentIds.has(id) || !activeIds.has(id)) {
        engine.removeCharacter(id);
      }
    }

    const allActiveSubIds = new Set<string>();

    for (const agent of agents) {
      if (!agent.pixelEnabled) continue;
      if (!currentIds.has(agent.id)) {
        const seat = engine.assignSeat(agent.id);
        engine.addCharacter({
          id: agent.id, name: agent.name,
          x: seat.x, y: seat.y,
          state: agent.activity, model: agent.model, spriteId: agent.characterSpriteId,
          lastMessage: agent.lastMessage,
        });
      } else {
        engine.updateCharacter(agent.id, {
          state: agent.activity, model: agent.model, name: agent.name,
          lastMessage: agent.lastMessage,
        });
      }

      // Sync sub-agents
      if (agent.subAgents) {
        // Spawn new sub-agents
        for (const sub of agent.subAgents) {
          if (sub.status === 'running') {
            allActiveSubIds.add(sub.id);
            if (!currentIds.has(sub.id)) {
              engine.spawnSubAgent(agent.id, sub.id, sub.name || sub.id);
              currentIds.add(sub.id); // Prevent re-spawning
            } else {
              // Resurrect if it was previously marked as dying
              engine.removeCharacter(sub.id);
              engine.spawnSubAgent(agent.id, sub.id, sub.name || sub.id);
            }
          } else {
            engine.killSubAgent(sub.id);
          }
        }
      }
    }

    // Kill sub-agents no longer in the list (across all parents)
    for (const cid of engine.getCharacterIds()) {
      if (cid.startsWith('sub-') && !allActiveSubIds.has(cid)) {
        engine.killSubAgent(cid);
      }
    }
  }, [agents, loaded]);

  return (
    <div className="pixel-office" style={{ position: 'relative' }}>
      <canvas ref={canvasRef} className="office-canvas" />
    </div>
  );
};
