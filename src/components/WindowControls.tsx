import React, { useCallback, useEffect, useState } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';

/**
 * The bridge a packaged desktop build (Electron, Tauri, ...) injects before the app
 * loads, so these buttons can drive the real OS window. Every method is optional:
 * whatever is missing falls back to what a browser can do, or the button is disabled.
 *
 *   window.pulanDesktop = {
 *     minimize: () => ipcRenderer.send('window:minimize'),
 *     toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
 *     close: () => ipcRenderer.send('window:close'),
 *     isMaximized: () => mainWindow.isMaximized(),
 *     onMaximizedChange: (listener) => {
 *       mainWindow.on('maximize', () => listener(true));
 *       mainWindow.on('unmaximize', () => listener(false));
 *     },
 *   };
 */
interface DesktopWindowBridge {
  minimize?: () => void;
  toggleMaximize?: () => void;
  close?: () => void;
  isMaximized?: () => boolean | Promise<boolean>;
  onMaximizedChange?: (listener: (maximized: boolean) => void) => void;
}

function readBridge(): DesktopWindowBridge | null {
  const candidate = (window as unknown as { pulanDesktop?: unknown }).pulanDesktop;
  return candidate && typeof candidate === 'object' ? (candidate as DesktopWindowBridge) : null;
}

/**
 * Minimise / maximise / close for the top panel.
 *
 * A browser tab has no window to control, so each button does the nearest honest thing
 * and says so in its tooltip: maximise uses the Fullscreen API, close calls
 * `window.close()` (which the browser honours only for a tab that a script opened), and
 * minimise has no equivalent at all, so it is disabled until a desktop build provides
 * the bridge above.
 */
export const WindowControls: React.FC = () => {
  // Read the bridge once. A packaged build injects it before the app starts, so a later
  // appearance would mean something replaced the global mid-session.
  const [bridge] = useState<DesktopWindowBridge | null>(readBridge);
  const [isMaximized, setIsMaximized] = useState(false);

  const fullscreenAvailable = typeof document !== 'undefined' && document.fullscreenEnabled === true;
  const canMinimize = Boolean(bridge?.minimize);
  const canMaximize = Boolean(bridge?.toggleMaximize) || fullscreenAvailable;

  // Maximise means two different things: the OS window in a packaged build, and the page
  // in a browser. Only one of them is in play, so only one of them is watched.
  useEffect(() => {
    if (bridge?.toggleMaximize) {
      if (bridge.isMaximized) {
        Promise.resolve(bridge.isMaximized())
          .then((value) => setIsMaximized(Boolean(value)))
          .catch(() => setIsMaximized(false));
      }
      bridge.onMaximizedChange?.(setIsMaximized);
      return;
    }

    const onFullscreenChange = () => setIsMaximized(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    onFullscreenChange();
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, [bridge]);

  const handleMinimize = useCallback(() => {
    bridge?.minimize?.();
  }, [bridge]);

  const handleToggleMaximize = useCallback(() => {
    if (bridge?.toggleMaximize) {
      bridge.toggleMaximize();
      return;
    }
    if (!document.fullscreenEnabled) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen().catch(() => {});
  }, [bridge]);

  const handleClose = useCallback(() => {
    if (bridge?.close) {
      bridge.close();
      return;
    }
    window.close();
  }, [bridge]);

  const controlClass =
    'h-7 w-11 flex items-center justify-center text-slate-600 transition-colors disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-slate-600';

  return (
    <div className="flex items-center">
      <button
        onClick={handleMinimize}
        disabled={!canMinimize}
        aria-label="Minimise"
        title={canMinimize ? 'Minimise' : 'Minimise — available in the packaged desktop build'}
        className={`${controlClass} hover:bg-[#e2e8f0] hover:text-slate-900`}
      >
        <Minus className="w-3.5 h-3.5" />
      </button>

      <button
        onClick={handleToggleMaximize}
        disabled={!canMaximize}
        aria-label={isMaximized ? 'Restore' : 'Maximise'}
        title={
          bridge?.toggleMaximize
            ? isMaximized
              ? 'Restore down'
              : 'Maximise'
            : 'Toggle full screen (a browser tab has no window to maximise)'
        }
        className={`${controlClass} hover:bg-[#e2e8f0] hover:text-slate-900`}
      >
        {isMaximized ? <Copy className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
      </button>

      <button
        onClick={handleClose}
        aria-label="Close"
        title={
          bridge?.close
            ? 'Close'
            : 'Close window (a browser tab can only be closed by the script that opened it)'
        }
        className={`${controlClass} hover:bg-[#dc2626] hover:text-white`}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
