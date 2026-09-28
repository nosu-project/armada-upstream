import { useEffect, useCallback, type RefObject } from 'react';
import { createPortal } from 'react-dom';

interface DropdownPosition {
  top: number;
  left: number;
}

/** Bottom-anchored position: the dropdown's bottom edge hugs the composer top. */
interface DropdownBottomPosition {
  bottom: number;
  left: number;
}

interface UsePortalDropdownOptions {
  textareaRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  isOpen: boolean;
  onClose: () => void;
  /** Max height in px (must match the CSS max-h value). */
  dropdownHeight: number;
  /** Width in px (must match the CSS width value). */
  dropdownWidth?: number;
}

/**
 * Fixed viewport coordinates for a caret-anchored autocomplete dropdown, flipped above on
 * bottom overflow; dismissed on scroll/resize. `renderPortal` escapes overflow clipping and
 * transformed ancestors (e.g. Radix Dialog).
 */
export function usePortalDropdown({
  textareaRef,
  isOpen,
  onClose,
  dropdownHeight,
  dropdownWidth = 280,
}: UsePortalDropdownOptions) {

  const computePosition = useCallback(
    (caretCoords: { top: number; left: number }): DropdownPosition => {
      const textarea = textareaRef.current;
      if (!textarea) return { top: 0, left: 0 };

      const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;
      const rect = textarea.getBoundingClientRect();
      const top = rect.top + caretCoords.top - textarea.scrollTop + lineHeight + 4;
      const left = rect.left + Math.max(0, Math.min(caretCoords.left, textarea.clientWidth - dropdownWidth));

      const flippedTop = rect.top + caretCoords.top - textarea.scrollTop - dropdownHeight - 4;
      const useFlipped = top + dropdownHeight > window.innerHeight && flippedTop > 0;

      return {
        top: useFlipped ? flippedTop : top,
        left: Math.max(8, Math.min(left, window.innerWidth - dropdownWidth - 8)),
      };
    },
    [textareaRef, dropdownHeight, dropdownWidth],
  );

  /** Bottom edge just above the textarea so a short list hugs the composer; `left` tracks the caret. */
  const computeBottomPosition = useCallback(
    (caretCoords: { left: number }): DropdownBottomPosition => {
      const textarea = textareaRef.current;
      if (!textarea) return { bottom: 0, left: 0 };
      const rect = textarea.getBoundingClientRect();
      const left = rect.left + Math.max(0, Math.min(caretCoords.left, textarea.clientWidth - dropdownWidth));
      return {
        bottom: window.innerHeight - rect.top + 6,
        left: Math.max(8, Math.min(left, window.innerWidth - dropdownWidth - 8)),
      };
    },
    [textareaRef, dropdownWidth],
  );

  // Fixed positioning misaligns on scroll/resize; scrolling inside the dropdown is ignored.
  useEffect(() => {
    if (!isOpen) return;
    const handleScroll = (e: Event) => {
      const target = e.target as Node | null;
      if (target instanceof Element && target.closest("[data-autocomplete-dropdown]")) {
        return;
      }
      onClose();
    };
    const handleResize = () => onClose();
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [isOpen, onClose]);

  return { computePosition, computeBottomPosition, renderPortal: createPortal };
}
