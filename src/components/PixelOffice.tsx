import React, { useRef, useEffect, useState } from 'react';
import type { AgentState, AgentActivity } from '../../shared/types';
import { GameEngine } from '../game/GameEngine';
import './PixelOffice.css';

interface Props {
  agents: AgentState[];
}

/** Map OpenClaw agent activity to pixel animation state */
function activityToAnimState(activity: AgentActivity): string {
  switch (activity) {
    case 'typing':
    case 'running_command':
      return 'typing';
    case 'thinking':
    case 'reading':
      return 'reading';
    case 'waiting_input':
      return 'waiting';
    case 'sleeping':
      return 'idle';
    case 'error':
      return 'error';
    case 'idle':
    default:
      return 'idle';
  }
}

export const PixelOffice: React.FC<Props> = ({ agents }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Initialize game engine
  useEffect(() => {
    if (!canvasRef.current || engineRef.current) return;

    const engine = new GameEngine(canvasRef.current, {
      tileSize: 32,
      gridWidth: 24,
      gridHeight: 16,
    });

    engineRef.current = engine;
    engine.start();
    setLoaded(true);

    return () => {
      engine.stop();
      engineRef.current = null;
    };
  }, []);

  // Sync agent states to game engine
  useEffect(() => {
    if (!engineRef.current || !loaded) return;

    const engine = engineRef.current;

    // Remove characters for disabled/missing agents
    const currentIds = engine.getCharacterIds();
    const activeIds = agents.filter(a => a.pixelEnabled).map(a => a.id);
    for (const id of currentIds) {
      if (!activeIds.includes(id)) {
        engine.removeCharacter(id);
      }
    }

    // Add or update characters
    for (const agent of agents) {
      if (!agent.pixelEnabled) continue;

      const animState = activityToAnimState(agent.activity);

      if (!currentIds.includes(agent.id)) {
        // Find an open seat for this agent
        const seat = engine.assignSeat(agent.id);
        engine.addCharacter({
          id: agent.id,
          name: agent.name,
          x: seat.x,
          y: seat.y,
          state: animState,
          model: agent.model,
          spriteId: agent.characterSpriteId,
        });
      } else {
        engine.updateCharacter(agent.id, {
          state: animState,
          model: agent.model,
          name: agent.name,
        });
      }
    }
  }, [agents, loaded]);

  return (
    <div className="pixel-office">
      <canvas
        ref={canvasRef}
        className="office-canvas"
      />
    </div>
  );
};
