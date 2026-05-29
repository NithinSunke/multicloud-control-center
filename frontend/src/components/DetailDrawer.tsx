import type { ReactNode } from 'react';

type DetailDrawerProps = {
  children: ReactNode;
  eyebrow?: string;
  footer?: ReactNode;
  onClose: () => void;
  open: boolean;
  title: string;
};

export function DetailDrawer({ children, eyebrow, footer, onClose, open, title }: DetailDrawerProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="detail-drawer-shell" role="presentation">
      <button aria-label="Close drawer overlay" className="detail-drawer-backdrop" onClick={onClose} type="button" />
      <aside aria-modal="true" className="detail-drawer-panel" role="dialog">
        <header className="detail-drawer-header">
          <div>
            {eyebrow ? <p className="detail-drawer-eyebrow">{eyebrow}</p> : null}
            <h2>{title}</h2>
          </div>
          <button className="pm-button pm-button-compact" onClick={onClose} type="button">
            Close
          </button>
        </header>
        <div className="detail-drawer-content">
          {children}
        </div>
        {footer ? <footer className="detail-drawer-footer">{footer}</footer> : null}
      </aside>
    </div>
  );
}
