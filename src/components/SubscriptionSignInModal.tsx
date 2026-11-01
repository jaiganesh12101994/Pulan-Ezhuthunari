import React, { useCallback, useEffect, useState } from 'react';
import {
  X,
  ShieldCheck,
  ExternalLink,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  LogOut,
  Copy,
  Download,
} from 'lucide-react';

interface SubscriptionSignInModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Which subscription this panel signs in to. */
  provider: 'claude' | 'chatgpt' | 'google';
  /** Optional path to the provider's executable, taken from the engine options. */
  cliPath?: string;
  /** Called after a sign-in or sign-out, so the caller can refresh what it shows. */
  onChanged?: () => void;
}

interface AuthStatus {
  provider: string;
  available: boolean;
  loggedIn: boolean | null;
  authMethod: string | null;
  account: string | null;
  message: string | null;
  cli?: { path: string | null; source: string; usable: boolean; reason: string | null };
  /** Set when the provider's tool is missing: the command that installs it. */
  installable?: boolean;
  installCommand?: string;
}

type Phase = 'loading' | 'idle' | 'starting' | 'awaiting-code' | 'submitting' | 'done';

/**
 * Sign in to a Claude or ChatGPT subscription from inside the app.
 *
 * Neither provider publishes an OAuth flow a third-party app may use, so the only
 * supported sign-in is the provider's own. This panel runs it for you: it shows the
 * authorization link, opens it, and takes the code back. No terminal, and this app
 * never sees a password or a token — the provider's own tool keeps the credential.
 */
export const SubscriptionSignInModal: React.FC<SubscriptionSignInModalProps> = ({
  isOpen,
  onClose,
  provider,
  cliPath,
  onChanged,
}) => {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [url, setUrl] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<string>('');
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [copied, setCopied] = useState(false);

  const label =
    provider === 'claude'
      ? 'Claude subscription'
      : provider === 'google'
      ? 'Google subscription (Gemini)'
      : 'ChatGPT subscription';

  const check = useCallback(async () => {
    setPhase('loading');
    setMessage(null);
    try {
      const params = new URLSearchParams({ provider });
      if (cliPath) params.set('cliPath', cliPath);
      const res = await fetch(`/api/agent/auth-status?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'The sign-in status could not be read.');
      setStatus(data as AuthStatus);
      setOk(!!data.loggedIn);
      setPhase('idle');
    } catch (err: any) {
      setMessage(err.message || 'The sign-in status could not be read.');
      setOk(false);
      setPhase('idle');
    }
  }, [provider, cliPath]);

  useEffect(() => {
    // A fresh check each time the panel opens is the point of this effect.
    if (isOpen) void check();
  }, [isOpen, check]);

  /**
   * Claude Code completes the sign-in itself once the browser has authorised: it
   * prints "Login successful." and exits without ever needing a pasted code. So while
   * the panel is waiting for a code it also asks how the sign-in actually stands, and
   * finishes on its own when the answer is "signed in".
   */
  useEffect(() => {
    if (!isOpen || phase !== 'awaiting-code') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const params = new URLSearchParams({ provider });
        if (cliPath) params.set('cliPath', cliPath);
        const res = await fetch(`/api/agent/login/state?${params.toString()}`);
        const data = await res.json();
        if (cancelled || !res.ok) return;
        if (data.outcome === 'signed_in') {
          if (data.status) setStatus(data.status as AuthStatus);
          setOk(true);
          setMessage(data.message || 'Signed in.');
          setUrl(null);
          setCode('');
          setPhase('done');
          onChanged?.();
        } else if (data.outcome === 'failed') {
          setOk(false);
          setMessage(data.message || 'The sign-in did not finish. Press Sign in again.');
          setUrl(null);
          setCode('');
          setPhase('idle');
        }
      } catch {
        // a failed poll is not fatal: the next one may succeed
      }
    };
    const timer = setInterval(poll, 2500);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isOpen, phase, provider, cliPath, onChanged]);

  const start = async () => {
    setPhase('starting');
    setMessage(null);
    try {
      const res = await fetch('/api/agent/login/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, email: email.trim() || undefined, cliPath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'The sign-in could not be started.');
      if (data.state === 'done') {
        // It finished while the browser was still open — no code needed.
        if (data.status) setStatus(data.status as AuthStatus);
        setOk(true);
        setMessage(data.message || 'Signed in.');
        setUrl(null);
        setPhase('done');
        onChanged?.();
        return;
      }
      setUrl(data.url || null);
      setInstructions(data.instructions || '');
      setCode('');
      setPhase('awaiting-code');
    } catch (err: any) {
      setMessage(err.message || 'The sign-in could not be started.');
      setOk(false);
      setPhase('idle');
    }
  };

  /**
   * Install the provider's sign-in tool, with the vendor's own documented command. The
   * panel shows the command before running it, and the app itself downloads nothing.
   */
  const install = async () => {
    setPhase('submitting');
    setMessage(null);
    try {
      const res = await fetch('/api/agent/install-cli', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'The tool could not be installed.');
      if (data.status) setStatus(data.status as AuthStatus);
      setOk(true);
      setMessage(data.message || 'Installed.');
      setPhase('done');
      onChanged?.();
    } catch (err: any) {
      setOk(false);
      setMessage(err.message || 'The tool could not be installed.');
      setPhase('idle');
    }
  };

  const submit = async () => {
    setPhase('submitting');
    setMessage(null);
    try {
      const res = await fetch('/api/agent/login/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'The sign-in was not completed.');
      }
      setOk(true);
      setMessage(data.message || 'Signed in.');
      if (data.status) setStatus(data.status as AuthStatus);
      setUrl(null);
      setCode('');
      setPhase('done');
      onChanged?.();
    } catch (err: any) {
      setMessage(err.message || 'The sign-in was not completed.');
      setOk(false);
      setPhase('awaiting-code');
    }
  };

  const cancelLogin = async () => {
    try {
      await fetch('/api/agent/login/cancel', { method: 'POST' });
    } catch {
      /* the panel is closing anyway */
    }
    setUrl(null);
    setCode('');
    setPhase('idle');
  };

  const signOut = async () => {
    setPhase('submitting');
    setMessage(null);
    try {
      const res = await fetch('/api/agent/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, cliPath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Signing out failed.');
      if (data.status) setStatus(data.status as AuthStatus);
      setOk(false);
      setMessage(data.message || 'Signed out.');
      setPhase('done');
      onChanged?.();
    } catch (err: any) {
      setMessage(err.message || 'Signing out failed.');
      setPhase('idle');
    }
  };

  const close = () => {
    if (phase === 'awaiting-code' || phase === 'submitting') void cancelLogin();
    onClose();
  };

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the field can be selected by hand instead */
    }
  };

  if (!isOpen) return null;

  const busy = phase === 'loading' || phase === 'starting' || phase === 'submitting';
  // The code panel stays on screen while the code is being checked, so the user sees
  // the button working rather than the panel vanishing.
  const awaiting = phase === 'awaiting-code' || phase === 'submitting';
  const signedIn = status?.loggedIn === true;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[#ffffff] border border-[#cbd5e1] rounded-lg shadow-2xl max-w-xl w-full text-slate-800 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="p-4 border-b border-[#e2e8f0] bg-[#f1f5f9] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-blue-500 inline-block shadow-sm"></span>
            <h3 className="text-sm font-semibold text-slate-900">Sign in — {label}</h3>
          </div>
          <button onClick={close} className="p-1 rounded hover:bg-[#e2e8f0] text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 text-xs text-slate-700">
          {/* Where things stand */}
          <div
            className={`flex items-start gap-2 p-2.5 rounded border ${
              busy
                ? 'bg-[#f1f5f9] border-[#cbd5e1]'
                : signedIn
                ? 'bg-emerald-50 border-emerald-200'
                : 'bg-amber-50 border-amber-200'
            }`}
          >
            {busy ? (
              <Loader2 className="w-4 h-4 mt-0.5 animate-spin text-slate-500" />
            ) : signedIn ? (
              <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-600" />
            ) : (
              <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600" />
            )}
            <div className="space-y-1 min-w-0">
              <div className="font-medium text-slate-900">
                {busy
                  ? 'Checking…'
                  : signedIn
                  ? `Signed in as ${status?.account || 'your subscription'}`
                  : status?.available
                  ? 'Not signed in'
                  : 'The sign-in tool was not found'}
              </div>
              {signedIn && status?.authMethod && (
                <div className="text-[10px] text-slate-600">
                  Method reported: {status.authMethod}
                </div>
              )}
              {status?.cli?.path && (
                <div className="text-[10px] text-slate-500 font-mono break-all">
                  {status.cli.path}
                </div>
              )}
            </div>
          </div>

          {status?.message && !busy && !signedIn && (
            <div className="text-slate-600">{status.message}</div>
          )}

          {message && (
            <div
              className={`p-2 rounded border ${
                ok
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-rose-50 border-rose-200 text-rose-800'
              }`}
            >
              {message}
            </div>
          )}

          {/* Already signed in: re-check, or sign out */}
          {signedIn && !awaiting && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={check}
                  disabled={busy}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded text-[11px] font-medium bg-[#f1f5f9] hover:bg-[#e2e8f0] text-slate-800 border border-[#cbd5e1] disabled:opacity-50"
                >
                  <ShieldCheck className="w-3.5 h-3.5" /> Check again
                </button>
                <button
                  onClick={signOut}
                  disabled={busy}
                  title={
                    provider === 'google'
                      ? 'Removes the Antigravity credential from the system keyring, which signs the Antigravity app out too'
                      : 'Sign out through the provider’s own command'
                  }
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded text-[11px] font-medium bg-[#f1f5f9] hover:bg-[#e2e8f0] text-slate-800 border border-[#cbd5e1] disabled:opacity-50"
                >
                  <LogOut className="w-3.5 h-3.5" /> Sign out
                </button>
              </div>
              {provider === 'google' && (
                <div className="text-[10px] text-slate-500">
                  Signing out removes the credential Antigravity shares, so the Antigravity
                  app will ask you to sign in again as well.
                </div>
              )}
            </div>
          )}

          {/* Not signed in: start the sign-in */}
          {status?.available && !signedIn && !awaiting && (
            <div className="space-y-2">
              {provider === 'claude' && (
                <label className="flex items-center gap-1 text-[11px] text-slate-600">
                  <span className="w-16 shrink-0">Email</span>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="optional — pre-fills the sign-in page"
                    className="flex-1 min-w-0 bg-[#ffffff] text-slate-800 border border-[#cbd5e1] rounded px-1.5 py-1 text-[11px] outline-hidden"
                  />
                </label>
              )}
              <button
                onClick={start}
                disabled={busy}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded text-[11px] font-medium bg-blue-700 hover:bg-blue-600 text-white border border-blue-500/40 disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="w-3.5 h-3.5" />
                )}
                Sign in
              </button>
            </div>
          )}

          {/* The provider's tool is missing: say what installs it, and offer to do it */}
          {status && !status.available && !awaiting && (
            <div className="space-y-2">
              <label className="flex items-center gap-1 text-[11px] text-slate-600">
                <span className="w-16 shrink-0">Command</span>
                <input
                  readOnly
                  value={status.installCommand || ''}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 min-w-0 bg-[#f8fafc] text-slate-700 border border-[#cbd5e1] rounded px-1.5 py-1 text-[10px] font-mono outline-hidden"
                />
              </label>
              <button
                onClick={install}
                disabled={busy}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded text-[11px] font-medium bg-blue-700 hover:bg-blue-600 text-white border border-blue-500/40 disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                Install it for me
              </button>
              <div className="text-[10px] text-slate-500">
                Runs that command on this computer. The app itself downloads nothing, and
                you can install it yourself instead if you prefer.
              </div>
            </div>
          )}

          {/* Waiting for the code from the sign-in page */}
          {awaiting && (
            <div className="space-y-2">
              <div className="text-slate-600">{instructions}</div>
              {url ? (
                <div className="flex items-center gap-1">
                  <input
                    readOnly
                    value={url}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 min-w-0 bg-[#f8fafc] text-slate-700 border border-[#cbd5e1] rounded px-1.5 py-1 text-[10px] font-mono outline-hidden"
                  />
                  <button
                    onClick={copyUrl}
                    title="Copy the link"
                    className="p-1.5 rounded bg-[#f1f5f9] hover:bg-[#e2e8f0] text-slate-700 border border-[#cbd5e1]"
                  >
                    {copied ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    title="Open the sign-in page"
                    className="flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-medium bg-[#f1f5f9] hover:bg-[#e2e8f0] text-slate-800 border border-[#cbd5e1]"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> Open
                  </a>
                </div>
              ) : (
                <div className="text-slate-600">
                  A browser window should have opened. Finish signing in there, then press Check
                  again.
                </div>
              )}
              {provider !== 'google' && (
                <label className="flex items-center gap-1 text-[11px] text-slate-600">
                  <span className="w-16 shrink-0">Code</span>
                  <input
                    type="text"
                    value={code}
                    autoFocus
                    onChange={(e) => setCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && code.trim()) void submit();
                    }}
                    placeholder="Code (only if the page shows one)"
                    className="flex-1 min-w-0 bg-[#ffffff] text-slate-800 border border-[#cbd5e1] rounded px-1.5 py-1 text-[11px] outline-hidden"
                  />
                </label>
              )}
              <div className="flex items-center gap-2">
                {provider !== 'google' && (
                  <button
                    onClick={submit}
                    disabled={!code.trim() || phase === 'submitting'}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded text-[11px] font-medium bg-blue-700 hover:bg-blue-600 text-white border border-blue-500/40 disabled:opacity-50"
                  >
                    {phase === 'submitting' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    )}
                    Continue
                  </button>
                )}
                <button
                  onClick={cancelLogin}
                  disabled={phase === 'submitting'}
                  className="px-2.5 py-1.5 rounded text-[11px] font-medium bg-[#f1f5f9] hover:bg-[#e2e8f0] text-slate-800 border border-[#cbd5e1] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={check}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded text-[11px] font-medium bg-[#f1f5f9] hover:bg-[#e2e8f0] text-slate-800 border border-[#cbd5e1]"
                >
                  <ShieldCheck className="w-3.5 h-3.5" /> Check now
                </button>
              </div>
              <div className="text-[10px] text-slate-500">
                {provider === 'google'
                  ? "Watching for Google's sign-in — paste the code below if the page shows one. Its browser step waits about a minute, so if it expires, press Sign in again for a fresh link."
                  : 'Watching for the sign-in to finish — no code needed if the page does not show one.'}
              </div>
            </div>
          )}

          <div className="text-[10px] text-slate-500 border-t border-[#e2e8f0] pt-2 leading-relaxed">
            This app never sees your password or your tokens. The sign-in is performed by{' '}
            {provider === 'claude'
              ? 'Claude Code'
              : provider === 'google'
              ? "Google's Antigravity CLI"
              : 'the ChatGPT CLI'}
            , which stores the credential itself; the app only reads whether the sign-in
            succeeded. Usage draws on the same subscription limits as the provider's own
            apps.
            {provider === 'google' &&
              ' Google retired the Gemini CLI for individual plans, so the Antigravity CLI is the supported way to use a Google AI plan here.'}
          </div>


        </div>
      </div>
    </div>
  );
};

