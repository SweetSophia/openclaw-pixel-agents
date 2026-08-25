/**
 * Contract test for the React↔engine reconciliation of sub-agents (issue #102).
 *
 * The GameEngine module is the mocked boundary here BY DESIGN: the engine's own
 * lifecycle primitives (spawn / kill / revive / fade) are pinned by
 * src/game/GameEngine.integration.test.ts running the real engine. This file pins
 * only the adapter contract — which engine method each server-status
 * reconciliation must call:
 *
 *   running + missing           ⇒ spawnSubAgent (exactly once)
 *   running + present + dying   ⇒ reviveSubAgent (NEVER remove+respawn)
 *   completed / failed          ⇒ killSubAgent
 *   absent from server list     ⇒ killSubAgent (sweep)
 *   parent leaves the room      ⇒ killSubAgent (sweep) + removeCharacter(parent)
 *
 * This is the exact wiring whose remove-and-respawn branch caused issue #102.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentState, SubAgentInfo } from '../../shared/types';
import { PixelOffice } from './PixelOffice';
import { GameEngine } from '../game/GameEngine';
import { recomposeAgent } from '../game/SpriteLoader';

vi.mock('../game/GameEngine', () => {
  class MockGameEngine {
    static latest: MockGameEngine;
    characters = new Set<string>();
    dying = new Set<string>();

    constructor(_canvas: HTMLCanvasElement, _config: unknown) {
      MockGameEngine.latest = this;
    }

    init = vi.fn().mockResolvedValue(undefined);
    start = vi.fn();
    stop = vi.fn();
    setEditorCallbacks = vi.fn();
    setGameCallbacks = vi.fn();
    setEditorMode = vi.fn();
    setDeleteMode = vi.fn();
    setSelectedFurnitureType = vi.fn();
    setLayout = vi.fn();
    setCharacterSprite = vi.fn();
    getCharacterIds = vi.fn(() => Array.from(this.characters));
    assignSeat = vi.fn(() => ({ x: 3, y: 3 }));
    addCharacter = vi.fn((data: { id: string }) => {
      this.characters.add(data.id);
    });
    updateCharacter = vi.fn();
    removeCharacter = vi.fn((id: string) => {
      this.characters.delete(id);
      this.dying.delete(id);
    });
    spawnSubAgent = vi.fn((_parentId: string, subId: string, _name: string) => {
      this.characters.add(subId);
    });
    killSubAgent = vi.fn((subId: string) => {
      if (this.characters.has(subId)) this.dying.add(subId);
    });
    reviveSubAgent = vi.fn((subId: string) => {
      this.dying.delete(subId);
    });
    isCharacterDying = vi.fn((id: string) => this.dying.has(id));
  }
  return { GameEngine: MockGameEngine };
});

vi.mock('../game/SpriteLoader', () => ({ recomposeAgent: vi.fn(() => null) }));

interface EngineSpy {
  characters: Set<string>;
  dying: Set<string>;
  spawnSubAgent: ReturnType<typeof vi.fn>;
  killSubAgent: ReturnType<typeof vi.fn>;
  reviveSubAgent: ReturnType<typeof vi.fn>;
  removeCharacter: ReturnType<typeof vi.fn>;
  setCharacterSprite: ReturnType<typeof vi.fn>;
  setLayout: ReturnType<typeof vi.fn>;
}

const engineOf = () => (GameEngine as unknown as { latest: EngineSpy }).latest;

const baseProps = {
  editorMode: false,
  deleteMode: false,
  activeLayout: null,
  selectedFurnitureType: null,
  onPlaceFurniture: vi.fn(),
  onSelectFurniture: vi.fn(),
  onMoveFurniture: vi.fn(),
  onRotateFurniture: vi.fn(),
};

const parentWith = (subAgents: SubAgentInfo[]): AgentState => ({
  id: 'cybera',
  name: 'Cybera',
  activity: 'typing',
  model: 'm',
  sessionKey: 'k',
  active: true,
  lastActivity: 1,
  pixelEnabled: true,
  tags: [],
  subAgents,
});

const sub = (id: string, status: SubAgentInfo['status']): SubAgentInfo => ({
  id,
  name: id,
  spawnedAt: 1,
  status,
});

describe('PixelOffice sub-agent reconciliation contract (issue #102)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns a running sub-agent exactly once across repeated reconciliations', async () => {
    const { rerender } = render(
      <PixelOffice {...baseProps} agents={[parentWith([sub('sub-1', 'running')])]} />,
    );
    await waitFor(() => expect(engineOf().spawnSubAgent).toHaveBeenCalledTimes(1));

    // Several server updates, status still `running` — the pre-fix code
    // remove+respawned here once the engine-side lifetime expired.
    for (let i = 0; i < 5; i++) {
      rerender(<PixelOffice {...baseProps} agents={[parentWith([sub('sub-1', 'running')])]} />);
    }

    expect(engineOf().spawnSubAgent).toHaveBeenCalledTimes(1);
    expect(engineOf().reviveSubAgent).not.toHaveBeenCalled();
    expect(engineOf().killSubAgent).not.toHaveBeenCalled();
    expect(engineOf().removeCharacter).not.toHaveBeenCalledWith('sub-1');
  });

  it('revives a dying sub-agent in place when status returns to running — never remove+respawn', async () => {
    const { rerender } = render(
      <PixelOffice {...baseProps} agents={[parentWith([sub('sub-1', 'running')])]} />,
    );
    await waitFor(() => expect(engineOf().spawnSubAgent).toHaveBeenCalledTimes(1));

    // Server reports completion: reconciliation kills the sub-agent (fade starts).
    rerender(<PixelOffice {...baseProps} agents={[parentWith([sub('sub-1', 'completed')])]} />);
    expect(engineOf().killSubAgent).toHaveBeenCalledWith('sub-1');
    expect(engineOf().dying.has('sub-1')).toBe(true);

    // Status flips back to running mid-fade: revive in place. THE #102 pin.
    rerender(<PixelOffice {...baseProps} agents={[parentWith([sub('sub-1', 'running')])]} />);
    expect(engineOf().reviveSubAgent).toHaveBeenCalledWith('sub-1');
    expect(engineOf().spawnSubAgent).toHaveBeenCalledTimes(1);
    expect(engineOf().removeCharacter).not.toHaveBeenCalledWith('sub-1');
  });

  it('kills a sub-agent that disappears from the server list (sweep)', async () => {
    const { rerender } = render(
      <PixelOffice {...baseProps} agents={[parentWith([sub('sub-1', 'running')])]} />,
    );
    await waitFor(() => expect(engineOf().spawnSubAgent).toHaveBeenCalledTimes(1));

    rerender(<PixelOffice {...baseProps} agents={[parentWith([])]} />);
    expect(engineOf().killSubAgent).toHaveBeenCalledWith('sub-1');
  });

  it('spawns a genuinely new execution (new sub id) while killing the old one', async () => {
    const { rerender } = render(
      <PixelOffice {...baseProps} agents={[parentWith([sub('sub-1', 'running')])]} />,
    );
    await waitFor(() => expect(engineOf().spawnSubAgent).toHaveBeenCalledTimes(1));

    rerender(<PixelOffice {...baseProps} agents={[parentWith([sub('sub-2', 'running')])]} />);
    expect(engineOf().killSubAgent).toHaveBeenCalledWith('sub-1');
    expect(engineOf().spawnSubAgent).toHaveBeenCalledTimes(2);
    expect(engineOf().spawnSubAgent).toHaveBeenLastCalledWith('cybera', 'sub-2', 'sub-2');
  });

  it('kills sub-agents when the parent is present but pixel-disabled', async () => {
    const { rerender } = render(
      <PixelOffice {...baseProps} agents={[parentWith([sub('sub-1', 'running')])]} />,
    );
    await waitFor(() => expect(engineOf().spawnSubAgent).toHaveBeenCalledTimes(1));

    // Parent stays in the list but visualization is toggled off: the parent
    // character is removed and its sub-agent must not linger (sweep path).
    rerender(
      <PixelOffice
        {...baseProps}
        agents={[{ ...parentWith([sub('sub-1', 'running')]), pixelEnabled: false }]}
      />,
    );
    expect(engineOf().removeCharacter).toHaveBeenCalledWith('cybera');
    expect(engineOf().killSubAgent).toHaveBeenCalledWith('sub-1');
  });

  it('kills sub-agents and removes the character when the parent leaves the room', async () => {
    const { rerender } = render(
      <PixelOffice {...baseProps} agents={[parentWith([sub('sub-1', 'running')])]} />,
    );
    await waitFor(() => expect(engineOf().spawnSubAgent).toHaveBeenCalledTimes(1));

    rerender(<PixelOffice {...baseProps} agents={[]} />);
    expect(engineOf().killSubAgent).toHaveBeenCalledWith('sub-1');
    expect(engineOf().removeCharacter).toHaveBeenCalledWith('cybera');
  });
});

describe('PixelOffice React-to-engine synchronization (issue #163)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resyncs the engine when furniture type changes at the same position', async () => {
    const layout = {
      id: 'default',
      name: 'Default',
      width: 24,
      height: 16,
      furniture: [{ id: 'seat-1', type: 'DESK', x: 4, y: 5, rotation: 0 }],
      seats: {},
      updatedAt: 1,
    };
    const { rerender } = render(
      <PixelOffice {...baseProps} agents={[]} activeLayout={layout} />,
    );
    await waitFor(() => expect(engineOf().setLayout).toHaveBeenCalled());
    engineOf().setLayout.mockClear();

    const replaced = {
      ...layout,
      furniture: [{ ...layout.furniture[0], type: 'SOFA' }],
    };
    rerender(<PixelOffice {...baseProps} agents={[]} activeLayout={replaced} />);

    expect(engineOf().setLayout).toHaveBeenCalledWith(replaced.furniture, replaced.seats);
  });

  it('recomposes the current recipe when a disabled agent is re-enabled', async () => {
    const recipeA = { bodyIndex: 0, hairIndex: 0, outfitIndex: 0 };
    const recipeB = { bodyIndex: 1, hairIndex: 2, outfitIndex: 3 };
    const enabled = { ...parentWith([]), recipe: recipeA };
    const { rerender } = render(
      <PixelOffice {...baseProps} agents={[enabled]} />,
    );
    await waitFor(() => expect(recomposeAgent).toHaveBeenCalledWith('cybera', recipeA));
    vi.mocked(recomposeAgent).mockClear();

    rerender(
      <PixelOffice
        {...baseProps}
        agents={[{ ...enabled, pixelEnabled: false, recipe: recipeB }]}
      />,
    );
    expect(recomposeAgent).not.toHaveBeenCalled();

    rerender(
      <PixelOffice {...baseProps} agents={[{ ...enabled, recipe: recipeB }]} />,
    );
    expect(recomposeAgent).toHaveBeenCalledWith('cybera', recipeB);
  });
});
