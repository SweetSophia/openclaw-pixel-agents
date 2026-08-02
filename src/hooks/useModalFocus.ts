import { useLayoutEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface ModalFocusOptions {
  overlayRef: RefObject<HTMLElement | null>;
  initialFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

function getFocusableElements(overlay: HTMLElement): HTMLElement[] {
  return Array.from(overlay.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

function isDisabledFormControl(element: Element | null): boolean {
  return (
    element instanceof HTMLButtonElement
    || element instanceof HTMLInputElement
    || element instanceof HTMLSelectElement
    || element instanceof HTMLTextAreaElement
  ) && element.disabled;
}

/**
 * Enforces the shared keyboard contract for simple modal dialogs.
 *
 * The overlay must be portaled as a direct child of document.body. This lets
 * the hook make every background body child inert without hiding or disabling
 * the dialog itself. Focus enters the dialog on mount, wraps on Tab, is pulled
 * back after an unexpected escape, and returns to the invoking control when
 * the dialog unmounts. Callers must serialize modal entry; this hook does not
 * manage a modal stack. A trigger's `data-focus-return` identity is sampled at
 * mount and must remain stable for that open lifecycle (issue #105).
 */
export function useModalFocus({ overlayRef, initialFocusRef, onClose }: ModalFocusOptions) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusReturnId = previousFocus?.dataset.focusReturn;
    const background = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay)
      .map(element => ({ element, wasInert: element.hasAttribute('inert') }));

    for (const { element } of background) element.setAttribute('inert', '');

    const focusInside = () => {
      const preferred = initialFocusRef.current;
      if (preferred && !preferred.hasAttribute('disabled')) {
        preferred.focus();
        return;
      }
      (getFocusableElements(overlay)[0] ?? overlay).focus();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = getFocusableElements(overlay);
      if (focusable.length === 0) {
        event.preventDefault();
        overlay.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !overlay.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !overlay.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !overlay.contains(event.target)) focusInside();
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    const focusabilityObserver = new MutationObserver(() => {
      const active = document.activeElement;
      if (!active || !overlay.contains(active) || isDisabledFormControl(active)) focusInside();
    });
    focusabilityObserver.observe(overlay, {
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled'],
    });
    focusInside();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      focusabilityObserver.disconnect();
      for (const { element, wasInert } of background) {
        if (!wasInert) element.removeAttribute('inert');
      }
      const replacement = focusReturnId
        ? Array.from(
          document.querySelectorAll<HTMLElement>('[data-focus-return]'),
        ).find(element => (
          element.dataset.focusReturn === focusReturnId && !isDisabledFormControl(element)
        ))
        : null;
      const fallback = Array.from(
        document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).find(element => !overlay.contains(element));
      const restoreTarget = previousFocus?.isConnected && !isDisabledFormControl(previousFocus)
        ? previousFocus
        : replacement ?? fallback;
      restoreTarget?.focus();
    };
  }, [initialFocusRef, overlayRef]);
}
