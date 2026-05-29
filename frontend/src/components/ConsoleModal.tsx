import { useEffect, useRef, useState } from 'react';
import type { ConsoleSession } from '../services/dashboardService';
import type { ResourceRecord } from '../types/dashboard';

type ConsoleModalProps = {
  session: ConsoleSession;
  resource: ResourceRecord;
  type: 'qemu' | 'lxc';
  onClose: () => void;
};

function websocketUrl(path: string) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}

export function ConsoleModal({ session, resource, type, onClose }: ConsoleModalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<{ disconnect: () => void; sendCtrlAltDel: () => void } | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let mounted = true;
    let didConnect = false;
    let connectionTimer: ReturnType<typeof setTimeout> | undefined;

    async function connect() {
      try {
        const { default: RFB } = await import('@novnc/novnc');
        if (!mounted || !containerRef.current) {
          return;
        }

        const rfb = new RFB(containerRef.current, websocketUrl(session.websocketPath), {
          credentials: {},
          wsProtocols: ['binary'],
        });
        rfb.scaleViewport = true;
        rfb.resizeSession = true;
        rfb.viewOnly = false;
        rfb.addEventListener('connect', () => {
          didConnect = true;
          if (connectionTimer) {
            clearTimeout(connectionTimer);
          }
          if (mounted) {
            setConnected(true);
            setError('');
          }
        });
        rfb.addEventListener('disconnect', (event) => {
          const detail = (event as Event & { detail?: { clean?: boolean } }).detail;
          if (mounted) {
            setConnected(false);
            if (!didConnect) {
              setError('Console connection closed before it finished connecting.');
            } else if (detail?.clean === false) {
              setError('Console connection was interrupted.');
            }
          }
        });
        rfb.addEventListener('securityfailure', () => {
          if (mounted) {
            setError('Console security negotiation failed. Create a new console session and try again.');
          }
        });
        rfbRef.current = rfb;
        connectionTimer = setTimeout(() => {
          if (mounted && !didConnect) {
            setError('Console is still connecting. Check network access to the Proxmox host and try reopening the console.');
          }
        }, 15000);
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Unable to open console.');
        }
      }
    }

    void connect();

    return () => {
      mounted = false;
      if (connectionTimer) {
        clearTimeout(connectionTimer);
      }
      rfbRef.current?.disconnect();
      rfbRef.current = null;
    };
  }, [session.websocketPath]);

  const expiresAt = new Date(session.expiresAt).toLocaleTimeString();

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 p-4">
      <section
        className={`mx-auto flex h-full flex-col rounded-lg border border-slate-700 bg-slate-950 shadow-xl ${
          fullscreen ? 'max-w-none' : 'max-w-6xl'
        }`}
      >
        <header className="flex flex-col gap-3 border-b border-slate-800 px-4 py-3 text-white sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-cyan-300">
              {type === 'qemu' ? 'VM Console' : 'Container Console'}
            </p>
            <h2 className="text-base font-semibold">
              {resource.name || resource.vmid} on {resource.node}
            </h2>
            <p className="text-xs text-slate-400">
              {connected ? 'Connected' : 'Connecting'} - Session expires at {expiresAt}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-md border border-slate-600 px-3 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-800 disabled:opacity-50"
              disabled={type !== 'qemu'}
              onClick={() => rfbRef.current?.sendCtrlAltDel()}
              type="button"
            >
              Ctrl Alt Del
            </button>
            <button
              className="rounded-md border border-slate-600 px-3 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-800"
              onClick={() => setFullscreen((current) => !current)}
              type="button"
            >
              {fullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            </button>
            <button
              className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-slate-200"
              onClick={onClose}
              type="button"
            >
              Close
            </button>
          </div>
        </header>

        {error ? (
          <div className="border-b border-red-900 bg-red-950 px-4 py-3 text-sm text-red-100">{error}</div>
        ) : null}

        <div className="min-h-0 flex-1 bg-black">
          <div className="h-full w-full" ref={containerRef} />
        </div>
      </section>
    </div>
  );
}
