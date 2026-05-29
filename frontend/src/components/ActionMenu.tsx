import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type ActionMenuItem = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'primary' | 'danger' | 'warning';
};

type ActionMenuProps = {
  label?: string;
  items: ActionMenuItem[];
};

function itemClass(tone: ActionMenuItem['tone']) {
  if (tone === 'danger') {
    return 'text-red-700 hover:bg-red-50 focus:bg-red-50';
  }
  if (tone === 'warning') {
    return 'text-amber-700 hover:bg-amber-50 focus:bg-amber-50';
  }
  if (tone === 'primary') {
    return 'text-blue-800 hover:bg-blue-50 focus:bg-blue-50';
  }
  return 'text-slate-700 hover:bg-slate-50 focus:bg-slate-50';
}

export function ActionMenu({ label = 'Actions', items }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; width: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  function updateMenuPosition() {
    const button = buttonRef.current;
    if (!button) {
      return;
    }
    const rect = button.getBoundingClientRect();
    const width = 208;
    const viewportPadding = 12;
    const left = Math.min(
      Math.max(viewportPadding, rect.right - width),
      Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
    );
    const estimatedHeight = Math.min(360, Math.max(44, items.length * 40 + 8));
    const opensUp = rect.bottom + estimatedHeight + viewportPadding > window.innerHeight && rect.top > estimatedHeight;
    setMenuPosition({
      left,
      top: opensUp ? Math.max(viewportPadding, rect.top - estimatedHeight - 8) : rect.bottom + 8,
      width,
    });
  }

  useLayoutEffect(() => {
    if (open) {
      updateMenuPosition();
    }
  }, [open, items.length]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function closeOnOutsideClick(event: MouseEvent) {
      const target = event.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target)
      ) {
        setOpen(false);
      }
    }

    function reposition() {
      updateMenuPosition();
    }

    document.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, items.length]);

  return (
    <div className="relative inline-flex">
      <button
        aria-expanded={open}
        className="pm-button pm-button-compact min-w-28 justify-between"
        ref={buttonRef}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {label}
        <span aria-hidden="true" className="text-slate-400">v</span>
      </button>
      {open && menuPosition ? createPortal(
        <div
          className="fixed z-[1000] max-h-[360px] overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-xl shadow-slate-300/70"
          ref={menuRef}
          style={{ left: menuPosition.left, top: menuPosition.top, width: menuPosition.width }}
        >
          {items.map((item) => (
            <button
              className={`block w-full px-3 py-2 text-left text-xs font-semibold outline-none disabled:cursor-not-allowed disabled:bg-white disabled:text-slate-400 ${itemClass(item.tone)}`}
              disabled={item.disabled}
              key={item.label}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
