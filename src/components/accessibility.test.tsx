import React, { StrictMode, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentState, AgentTag, CharacterRecipe } from '../../shared/types';
import { AgentSidebar } from './AgentSidebar';
import { CharacterCustomizer } from './CharacterCustomizer';
import { SoundControls } from './SoundControls';
import { TagEditor } from './TagEditor';
import { sfx } from '../audio/SoundFX';

vi.mock('./AgentPortrait', () => ({ AgentPortrait: () => null }));
vi.mock('../audio/SoundFX', () => ({
  sfx: {
    muted: false,
    volume: 0.5,
    ambienceOn: false,
    click: vi.fn(),
    setMuted: vi.fn(),
    setVolume: vi.fn(),
    toggleAmbience: vi.fn(),
  },
}));

const agent: AgentState = {
  id: 'cybera',
  name: 'Cybera',
  activity: 'typing',
  model: 'openai/codex',
  sessionKey: 'agent:cybera',
  active: true,
  lastActivity: 1,
  pixelEnabled: true,
  tags: [],
  recipe: { bodyIndex: 0, hairIndex: 0, outfitIndex: 0 },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('AgentSidebar primary keyboard action (issue #105)', () => {
  it('uses a named native button for agent details without swallowing sibling actions', () => {
    const onSelectAgent = vi.fn();
    const onToggle = vi.fn();
    render(
      <AgentSidebar
        agents={[agent]}
        onToggle={onToggle}
        onToggleAll={vi.fn()}
        onSelectAgent={onSelectAgent}
      />,
    );

    const details = screen.getByRole('button', { name: 'Open details for Cybera' });
    expect(details.tagName).toBe('BUTTON');
    expect(details).toHaveAttribute('type', 'button');
    details.focus();
    expect(details).toHaveFocus();
    fireEvent.click(details);
    expect(onSelectAgent).toHaveBeenCalledWith('cybera');

    fireEvent.click(screen.getByRole('button', { name: 'Hide Cybera from office' }));
    expect(onToggle).toHaveBeenCalledWith('cybera', false);
    expect(onSelectAgent).toHaveBeenCalledTimes(1);
  });
});

describe('SoundControls disclosure relationship (issue #105)', () => {
  it('names the settings button and connects it to the expanded panel', () => {
    render(<SoundControls />);
    const settings = screen.getByRole('button', { name: 'Sound settings' });
    expect(settings).toHaveAttribute('aria-expanded', 'false');
    expect(settings).toHaveAttribute('aria-controls', 'sound-settings-panel');

    fireEvent.click(settings);
    expect(settings).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('sound-settings-panel')).toBeTruthy();
  });

  it('reinstalls the one-shot unlock listener during a StrictMode effect replay', () => {
    render(<StrictMode><SoundControls /></StrictMode>);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(sfx.click).toHaveBeenCalledOnce();
  });

  it('removes pending unlock listeners on unmount', () => {
    const { unmount } = render(<SoundControls />);
    unmount();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(sfx.click).not.toHaveBeenCalled();
  });
});

function TagEditorHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open tag editor</button>
      {open && (
        <TagEditor
          agentId="cybera"
          agentName="Cybera"
          currentTags={[]}
          onUpdateTags={async (_agentId: string, _tags: AgentTag[]) => {}}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function CharacterCustomizerHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open character customizer</button>
      {open && (
        <CharacterCustomizer
          agentId="cybera"
          agentName="Cybera"
          currentRecipe={{ bodyIndex: 0, hairIndex: 0, outfitIndex: 0 }}
          onUpdateRecipe={async (_agentId: string, _recipe: CharacterRecipe) => {}}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function PendingTagEditorHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open pending tag editor</button>
      {open && (
        <TagEditor
          agentId="cybera"
          agentName="Cybera"
          currentTags={[]}
          onUpdateTags={() => new Promise(() => {})}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function PendingCharacterCustomizerHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open pending character customizer</button>
      {open && (
        <CharacterCustomizer
          agentId="cybera"
          agentName="Cybera"
          currentRecipe={{ bodyIndex: 0, hairIndex: 0, outfitIndex: 0 }}
          onUpdateRecipe={() => new Promise(() => {})}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function SidebarTagBoundaryHarness() {
  const [agents, setAgents] = useState([agent]);
  return (
    <AgentSidebar
      agents={agents}
      onToggle={vi.fn()}
      onToggleAll={vi.fn()}
      onUpdateTags={async (agentId, tags) => {
        setAgents(current => current.map(item => (
          item.id === agentId ? { ...item, tags } : item
        )));
      }}
    />
  );
}

function expectModalContract(
  triggerName: string,
  dialogName: string,
  cancelName: string,
) {
  const trigger = screen.getByRole('button', { name: triggerName });
  // Testing Library's low-level fireEvent.click does not perform the browser's
  // pointer-focus step. Focus explicitly so the harness models a real invoking
  // control and the modal can capture the correct restore target.
  trigger.focus();
  fireEvent.click(trigger);

  const dialog = screen.getByRole('dialog', { name: dialogName });
  const cancel = screen.getByRole('button', { name: cancelName });
  expect(cancel).toHaveFocus();

  const appRoot = trigger.closest('div')!;
  expect(appRoot).toHaveAttribute('inert');
  expect(document.body.contains(dialog)).toBe(true);
  expect(appRoot.contains(dialog)).toBe(false);

  trigger.focus();
  expect(cancel).toHaveFocus();

  const controls = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  const first = controls[0];
  const last = controls[controls.length - 1];
  last.focus();
  fireEvent.keyDown(document, { key: 'Tab', bubbles: true });
  expect(first).toHaveFocus();

  first.focus();
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true, bubbles: true });
  expect(last).toHaveFocus();

  const escaped = vi.fn();
  window.addEventListener('keydown', escaped);
  fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
  window.removeEventListener('keydown', escaped);
  expect(escaped).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull();
  expect(trigger).toHaveFocus();
  expect(appRoot).not.toHaveAttribute('inert');
}

describe('shared modal focus contract (issue #105)', () => {
  it('contains TagEditor focus, makes the background inert, and restores its trigger', () => {
    render(<TagEditorHarness />);
    expectModalContract('Open tag editor', 'Tags for Cybera', 'Cancel');
  });

  it('contains CharacterCustomizer focus, makes the background inert, and restores its trigger', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    render(<CharacterCustomizerHarness />);
    expectModalContract('Open character customizer', 'Customize Cybera', 'Cancel');
  });

  it('re-anchors TagEditor focus when the focused Save button becomes disabled', async () => {
    render(<PendingTagEditorHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open pending tag editor' }));
    const dialog = screen.getByRole('dialog', { name: 'Tags for Cybera' });
    const save = screen.getByRole('button', { name: 'Save' });
    save.focus();
    fireEvent.click(save);
    await waitFor(() => {
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      expect(document.activeElement).not.toBe(save);
    });
  });

  it('re-anchors CharacterCustomizer focus when the focused Apply button becomes disabled', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    render(<PendingCharacterCustomizerHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open pending character customizer' }));
    const dialog = screen.getByRole('dialog', { name: 'Customize Cybera' });
    const apply = screen.getByRole('button', { name: 'Apply' });
    apply.focus();
    fireEvent.click(apply);
    await waitFor(() => {
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      expect(document.activeElement).not.toBe(apply);
    });
  });

  it('restores the replacement tag trigger across zero/nonzero tag saves', async () => {
    render(<SidebarTagBoundaryHarness />);

    const addTags = screen.getByRole('button', { name: 'Add tags for Cybera' });
    addTags.focus();
    fireEvent.click(addTags);
    fireEvent.click(screen.getByRole('button', { name: /^★?\s*coding$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Tags for Cybera' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Edit tags for Cybera' })).toHaveFocus();
    });

    const editTags = screen.getByRole('button', { name: 'Edit tags for Cybera' });
    fireEvent.click(editTags);
    fireEvent.click(screen.getByRole('button', { name: /^★?\s*coding$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Tags for Cybera' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Add tags for Cybera' })).toHaveFocus();
    });
  });
});
