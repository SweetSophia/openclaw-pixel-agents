import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useModalFocus } from './useModalFocus';
afterEach(cleanup);
function Harness() {
  const overlayRef = useRef<HTMLDivElement>(null); const initialFocusRef = useRef<HTMLButtonElement>(null); const [agent, setAgent] = useState(false);
  useModalFocus({ overlayRef, initialFocusRef, onClose: vi.fn() });
  return createPortal(<div ref={overlayRef} tabIndex={-1} role="dialog">
    <button ref={initialFocusRef}>Close</button><button onClick={() => setAgent(true)}>Agent tab</button>
    <section hidden={agent}><button>Last Task control</button></section>
    <section hidden><textarea aria-label="Hidden composer" /><button>Hidden Send</button></section>
  </div>, document.body);
}
describe('modal focus with inactive tab panels', () => {
  it('wraps Tab from the last visible Task control instead of a hidden composer', () => {
    render(<Harness />); const last = screen.getByRole('button', { name: 'Last Task control' }); last.focus();
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false); expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true }); expect(last).toHaveFocus();
  });
  it('wraps when the Agent tab hides every Task and Conversation control', () => {
    render(<Harness />); const tab = screen.getByRole('button', { name: 'Agent tab' }); fireEvent.click(tab); tab.focus();
    expect(fireEvent.keyDown(tab, { key: 'Tab' })).toBe(false); expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });
});
