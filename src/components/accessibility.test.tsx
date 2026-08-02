import React, { StrictMode, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentState, AgentTag, CharacterRecipe } from '../../shared/types';
import { AgentDetailPanel } from './AgentDetailPanel';
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
    const panelId = settings.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();

    fireEvent.click(settings);
    expect(settings).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(panelId!)).toBeTruthy();
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
      <button>Secondary target</button>
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

function AgentDetailsHarness() {
  const [selectedAgent, setSelectedAgent] = useState<AgentState | null>(null);
  return (
    <>
      <AgentSidebar
        agents={[agent]}
        onToggle={vi.fn()}
        onToggleAll={vi.fn()}
        onSelectAgent={agentId => setSelectedAgent(agentId === agent.id ? agent : null)}
      />
      {selectedAgent && (
        <AgentDetailPanel
          agent={selectedAgent}
          onClose={() => setSelectedAgent(null)}
        />
      )}
    </>
  );
}

function SidebarCustomizerBoundaryHarness() {
  const [agents, setAgents] = useState([agent]);
  return (
    <>
      <button
        onClick={() => setAgents(current => current.map(item => ({
          ...item,
          tags: item.tags?.length ? [] : ['coding'],
        })))}
      >
        Toggle live tags
      </button>
      <AgentSidebar
        agents={agents}
        onToggle={vi.fn()}
        onToggleAll={vi.fn()}
        onUpdateRecipe={async () => {}}
      />
    </>
  );
}

function expectModalContract(
  triggerName: string,
  dialogName: string,
  getInitialFocus: () => HTMLElement,
  initialFocusOutsideTabOrder = false,
) {
  const trigger = screen.getByRole('button', { name: triggerName });
  // Testing Library's low-level fireEvent.click does not perform the browser's
  // pointer-focus step. Focus explicitly so the harness models a real invoking
  // control and the modal can capture the correct restore target.
  trigger.focus();
  fireEvent.click(trigger);

  const dialog = screen.getByRole('dialog', { name: dialogName });
  const initialFocus = getInitialFocus();
  expect(initialFocus).toHaveFocus();

  const appRoot = trigger.closest('div')!;
  expect(appRoot).toHaveAttribute('inert');
  expect(document.body.contains(dialog)).toBe(true);
  expect(appRoot.contains(dialog)).toBe(false);

  const controls = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (initialFocusOutsideTabOrder) {
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true, bubbles: true });
    expect(last).toHaveFocus();
    initialFocus.focus();
  }

  trigger.focus();
  expect(initialFocus).toHaveFocus();

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
  it('opens agent details from Enter and Space, contains focus, and restores the trigger', async () => {
    const user = userEvent.setup();
    render(<AgentDetailsHarness />);

    const trigger = screen.getByRole('button', { name: 'Open details for Cybera' });
    const appRoot = trigger.closest('.agent-sidebar')!.parentElement!;
    trigger.focus();
    await user.keyboard('[Enter]');

    const dialog = screen.getByRole('dialog', { name: 'Cybera' });
    const close = screen.getByRole('button', { name: 'Close details for Cybera' });
    expect(close).toHaveFocus();
    expect(appRoot).toHaveAttribute('inert');
    expect(document.body.contains(dialog)).toBe(true);
    expect(appRoot.contains(dialog)).toBe(false);

    trigger.focus();
    expect(close).toHaveFocus();
    await user.keyboard('[Tab]');
    expect(close).toHaveFocus();
    await user.keyboard('[Escape]');
    expect(screen.queryByRole('dialog', { name: 'Cybera' })).toBeNull();
    expect(trigger).toHaveFocus();
    expect(appRoot).not.toHaveAttribute('inert');

    await user.keyboard('[Space]');
    expect(screen.getByRole('dialog', { name: 'Cybera' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close details for Cybera' }));
    expect(trigger).toHaveFocus();
  });

  it('serializes the sidebar-owned tag and character dialogs', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    render(
      <AgentSidebar
        agents={[agent]}
        onToggle={vi.fn()}
        onToggleAll={vi.fn()}
        onUpdateTags={async () => {}}
        onUpdateRecipe={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add tags for Cybera' }));
    expect(screen.getByRole('dialog', { name: 'Tags for Cybera' })).toBeTruthy();

    const customizer = document.querySelector<HTMLButtonElement>(
      '[aria-label="Customize appearance for Cybera"]',
    )!;
    fireEvent.click(customizer);
    expect(screen.queryByRole('dialog', { name: 'Tags for Cybera' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Customize Cybera' })).toBeTruthy();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it('contains TagEditor focus, makes the background inert, and restores its trigger', () => {
    render(<TagEditorHarness />);
    expectModalContract(
      'Open tag editor',
      'Tags for Cybera',
      () => screen.getByRole('button', { name: 'Cancel' }),
    );
  });

  it('falls back to an enabled background control when the invoking control becomes disabled', () => {
    render(<TagEditorHarness />);
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: 'Open tag editor' });
    trigger.focus();
    fireEvent.click(trigger);
    trigger.disabled = true;
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(trigger).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'Secondary target' })).toHaveFocus();
  });

  it('contains CharacterCustomizer focus, makes the background inert, and restores its trigger', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    render(<CharacterCustomizerHarness />);
    expectModalContract(
      'Open character customizer',
      'Customize Cybera',
      () => screen.getByRole('heading', { name: 'Customize Cybera' }),
      true,
    );
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

  it('restores the replacement customizer trigger after live tags swap its branch', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    render(<SidebarCustomizerBoundaryHarness />);

    const customizer = screen.getByRole('button', { name: 'Customize appearance for Cybera' });
    customizer.focus();
    fireEvent.click(customizer);
    expect(screen.getByRole('dialog', { name: 'Customize Cybera' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle live tags' }));
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });

    expect(screen.queryByRole('dialog', { name: 'Customize Cybera' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Customize appearance for Cybera' })).toHaveFocus();
  });
});
