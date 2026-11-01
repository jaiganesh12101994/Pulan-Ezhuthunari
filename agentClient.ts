/**
 * Client for the Claude subscription sidecar (`backend/agent/sidecar.py`).
 *
 * The sidecar is a long-lived Python process that drives the Claude Agent SDK,
 * which drives the Claude Code CLI signed in to a Claude subscription. This module
 * is only the transport: it starts the process, frames newline-delimited JSON in
 * both directions, correlates answers with requests, and forwards the events the
 * sidecar streams (text deltas, tool calls, the session report, usage and errors).
 *
 * No credential ever passes through here. The sidecar strips `ANTHROPIC_API_KEY`
 * and friends from the CLI's environment before the SDK is used, so the
 * subscription is billed rather than the API.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

// This module is ESM, so its own directory comes from import.meta.url rather than
// the `__dirname` that server.ts defines for itself.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface AgentFrame {
  id?: string | number;
  event: string;
  [key: string]: unknown;
}

export interface AgentResult {
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export interface AgentCliVerdict {
  path: string | null;
  source: string;
  found: boolean;
  usable: boolean;
  reason: string | null;
}

/** The subscriptions this app can sign in to from inside the panel. */
export type SubscriptionProvider = 'claude' | 'chatgpt' | 'google';

/** The provider's own answer about the subscription sign-in. */
export interface AuthStatus {
  provider: SubscriptionProvider;
  cli?: AgentCliVerdict;
  available: boolean;
  loggedIn: boolean | null;
  authMethod: string | null;
  account: string | null;
  configDirectory?: string | null;
  message: string | null;
  [key: string]: unknown;
}

/** A sign-in waiting for the code the user pastes. */
export interface LoginStart {
  provider: string;
  url: string | null;
  instructions: string;
  command?: string;
  email?: string | null;
  state?: string;
}

export interface LoginResult {
  ok?: boolean;
  state?: string;
  message?: string;
  account?: string | null;
  authMethod?: string | null;
  status?: AuthStatus;
  url?: string | null;
  instructions?: string;
  /** Set by an install: the command that was run and what it printed. */
  command?: string;
  output?: string;
}

/** How a sign-in stands, as the panel polls it. */
export interface LoginState {
  outcome: 'waiting' | 'signed_in' | 'failed' | 'none';
  message?: string;
  tail?: string;
  status?: AuthStatus;
  state?: {
    running: boolean;
    finished: boolean;
    exitCode: number | null;
    url: string | null;
  };
}

export interface AgentStatus {
  sdkInstalled?: boolean;
  sdkVersion?: string | null;
  bundledCli?: string | null;
  bundledCliVersion?: string | null;
  cli?: AgentCliVerdict;
  account?: string;
  model?: string;
  maxTurns?: number;
  tools?: string[];
  sessionOpen?: boolean;
  [key: string]: unknown;
}

export interface SignInReport {
  status: 'signed_in' | 'not_signed_in' | 'cli_not_found' | 'timeout' | 'error' | 'unknown';
  signedIn: boolean;
  message: string;
  account?: string;
  credential?: string | null;
  model?: string | null;
  cliVersion?: string | null;
  tools?: string[];
  cli?: AgentCliVerdict;
  sdkVersion?: string | null;
  answer?: string;
  detail?: string | null;
  [key: string]: unknown;
}

export interface VisionRequest {
  /** `layout` asks for zones, `ocr` asks for a transcription. */
  action: 'layout' | 'ocr';
  /** Built by `aiVision.ts`, so there is exactly one copy of the prompts. */
  prompt: string;
  imagePath: string;
  width: number;
  height: number;
  pageId?: string;
  pageNumber?: number;
  documentId?: string;
  documentName?: string;
  zones?: Array<Record<string, unknown>>;
  selection?: Record<string, unknown> | null;
  /** Long edge the page is scaled to before it is handed to the model. */
  maxEdge?: number;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
}

export class AgentError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'AgentError';
  }
}

/** Frames that end a request; every other frame is streamed on the way. */
const TERMINAL_EVENTS = new Set([
  'done',
  'error',
  'status',
  'sign-in',
  'auth-status',
  'login',
  'login-state',
  'install',
  'logout',
]);

/** How long an idle sidecar is kept before it is shut down. */
const IDLE_SHUTDOWN_MS = Number(process.env.PULAN_AGENT_IDLE_MS) || 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = Number(process.env.PULAN_AGENT_TIMEOUT_MS) || 240000;

interface Pending {
  resolve: (frames: AgentFrame[]) => void;
  reject: (error: Error) => void;
  frames: AgentFrame[];
  onEvent?: (frame: AgentFrame) => void;
  timer: NodeJS.Timeout;
}

class AgentClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | null = null;
  private stderrTail: string[] = [];
  private lastSignIn: SignInReport | null = null;
  private lastAuth: AuthStatus | null = null;

  /** The last sign-in report, so the UI can show the account without asking again. */
  get lastReport(): SignInReport | null {
    return this.lastSignIn;
  }

  /** The last `auth status` answer, for the panel's badge. */
  get lastAuthStatus(): AuthStatus | null {
    return this.lastAuth;
  }

  get running(): boolean {
    return !!this.child && !this.child.killed;
  }

  private scriptPath(): string {
    return path.resolve(MODULE_DIR, 'backend', 'agent', 'sidecar.py');
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const pythonBin =
      process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
    const child = spawn(pythonBin, [this.scriptPath()], {
      cwd: MODULE_DIR,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    }) as ChildProcessWithoutNullStreams;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail.push(...String(chunk).split('\n').filter(Boolean));
      this.stderrTail = this.stderrTail.slice(-40);
    });
    child.on('error', (err) => {
      this.failAll(new AgentError(`The Claude subscription sidecar could not start: ${err.message}`));
      this.child = null;
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      const detail = this.stderrTail.slice(-4).join(' | ');
      this.failAll(
        new AgentError(
          `The Claude subscription sidecar stopped (exit ${code}).${detail ? ` ${detail}` : ''}`,
          'sidecar_stopped'
        )
      );
    });
    this.child = child;
    return child;
  }

  /** Split stdout into frames: one JSON object per line. */
  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let frame: AgentFrame;
    try {
      frame = JSON.parse(line);
    } catch {
      // Anything that is not a frame is diagnostic noise from the CLI.
      this.stderrTail.push(line.slice(0, 400));
      this.stderrTail = this.stderrTail.slice(-40);
      return;
    }
    const key = frame.id === undefined ? undefined : String(frame.id);
    if (!key) return;
    const pending = this.pending.get(key);
    if (!pending) return;
    if (frame.event === 'sign-in') this.lastSignIn = frame as unknown as SignInReport;
    if (frame.event === 'auth-status') this.lastAuth = frame as unknown as AuthStatus;
    pending.onEvent?.(frame);
    pending.frames.push(frame);
    if (TERMINAL_EVENTS.has(frame.event)) {
      clearTimeout(pending.timer);
      this.pending.delete(key);
      pending.resolve(pending.frames);
    }
  }

  private failAll(error: Error): void {
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(key);
      pending.reject(error);
    }
  }

  private request(
    op: string,
    payload: Record<string, unknown> = {},
    options: { onEvent?: (frame: AgentFrame) => void; timeoutMs?: number } = {}
  ): Promise<AgentFrame[]> {
    const child = this.ensureProcess();
    const id = String(this.nextId++);
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    return new Promise<AgentFrame[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const detail = this.stderrTail.slice(-4).join(' | ');
        reject(
          new AgentError(
            `Claude Code did not answer within ${Math.round(timeoutMs / 1000)}s.` +
              (detail ? ` It said: ${detail}` : ''),
            'timeout'
          )
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, frames: [], onEvent: options.onEvent, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`);
      } catch (err: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AgentError(`The sidecar could not be written to: ${err.message}`));
      }
      this.scheduleIdleShutdown();
    });
  }

  private scheduleIdleShutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.shutdown(), IDLE_SHUTDOWN_MS);
    this.idleTimer.unref?.();
  }

  private finalText(frames: AgentFrame[]): string {
    const done = frames.find((frame) => frame.event === 'done');
    if (done && typeof done.text === 'string') return done.text;
    return frames
      .filter((frame) => frame.event === 'text_delta')
      .map((frame) => String(frame.text ?? ''))
      .join('');
  }

  /** What the sidecar found out about the SDK, the CLI and the work directory. */
  async status(): Promise<AgentStatus> {
    const frames = await this.request('status', {}, { timeoutMs: 60000 });
    const frame = frames.find((item) => item.event === 'status');
    if (!frame) throw new AgentError('The sidecar did not report its status.');
    return frame as unknown as AgentStatus;
  }

  /**
   * The "Check sign-in" action: one minimal query with no tools, which proves the
   * CLI runs, an account answers, and which credential paid for it.
   */
  async signIn(options: { cliPath?: string; timeoutMs?: number } = {}): Promise<SignInReport> {
    const frames = await this.request(
      'sign-in',
      options.cliPath ? { cli: options.cliPath } : {},
      { timeoutMs: options.timeoutMs || 180000 }
    );
    const frame = frames.find((item) => item.event === 'sign-in');
    if (!frame) throw new AgentError('The sidecar did not report a sign-in result.');
    this.lastSignIn = frame as unknown as SignInReport;
    return this.lastSignIn;
  }

  // -- subscription sign-in, driven from the panel ----------------------

  /**
   * The provider's own answer about the sign-in (`claude auth status --json`). This
   * is the supported, machine-readable way to ask, and it costs no model turn.
   */
  async authStatus(
    provider: SubscriptionProvider = 'claude',
    options: { cliPath?: string } = {}
  ): Promise<AuthStatus> {
    const frames = await this.request(
      'auth-status',
      { provider, ...(options.cliPath ? { cli: options.cliPath } : {}) },
      { timeoutMs: 90000 }
    );
    const frame = frames.find((item) => item.event === 'auth-status');
    if (!frame) throw new AgentError('The sign-in status could not be read.');
    this.lastAuth = frame as unknown as AuthStatus;
    return this.lastAuth;
  }

  /**
   * Begin a sign-in. The provider's own command is started for the user, and the
   * authorization URL comes back so the panel can show it and open it.
   */
  async loginStart(
    options: { provider?: SubscriptionProvider; email?: string; cliPath?: string } = {}
  ): Promise<LoginStart> {
    const frames = await this.request(
      'login-start',
      {
        provider: options.provider || 'claude',
        email: options.email || undefined,
        ...(options.cliPath ? { cli: options.cliPath } : {}),
      },
      { timeoutMs: 90000 }
    );
    const frame = frames.find((item) => item.event === 'login');
    if (!frame) throw new AgentError('The sign-in could not be started.');
    return frame as unknown as LoginStart;
  }

  /**
   * How a sign-in in progress stands. The panel polls this, because the browser flow
   * can complete the sign-in without the user ever pasting a code.
   */
  async loginState(
    provider: SubscriptionProvider = 'claude',
    options: { cliPath?: string } = {}
  ): Promise<LoginState> {
    const frames = await this.request(
      'login-state',
      { provider, ...(options.cliPath ? { cli: options.cliPath } : {}) },
      { timeoutMs: 90000 }
    );
    const frame = frames.find((item) => item.event === 'login-state');
    if (!frame) throw new AgentError('The sign-in state could not be read.');
    if (frame.status) this.lastAuth = frame.status as unknown as AuthStatus;
    return frame as unknown as LoginState;
  }

  /**
   * Install the provider's sign-in tool, with the vendor's own documented command.
   * Only ever called because the user pressed a button that names the command.
   */
  async installCli(provider: SubscriptionProvider = 'claude'): Promise<LoginResult> {
    const frames = await this.request('install-cli', { provider }, { timeoutMs: 15 * 60 * 1000 });
    const frame = frames.find((item) => item.event === 'install');
    if (frame) {
      if (frame.status) this.lastAuth = frame.status as unknown as AuthStatus;
      return frame as unknown as LoginResult;
    }
    const failure = frames.find((item) => item.event === 'error');
    throw new AgentError(
      String(failure?.message || 'The tool could not be installed.'),
      String(failure?.code || '')
    );
  }

  /** Hand the pasted code back; resolves once the provider's command has finished. */
  async loginCode(code: string, options: { timeoutMs?: number } = {}): Promise<LoginResult> {
    const frames = await this.request(
      'login-code',
      { code },
      { timeoutMs: options.timeoutMs || 240000 }
    );
    const frame = frames.find((item) => item.event === 'login');
    if (frame) return frame as unknown as LoginResult;
    const failure = frames.find((item) => item.event === 'error');
    throw new AgentError(
      String(failure?.message || 'The sign-in was not completed.'),
      String(failure?.code || '')
    );
  }

  /**
   * Abandon a sign-in, so nothing is left waiting for a code. This always asks: the
   * sidecar is started if it is not running, so a stale client state cannot silently
   * skip the cancel and leave a login process waiting.
   */
  async loginCancel(): Promise<boolean> {
    const frames = await this.request('login-cancel', {}, { timeoutMs: 30000 });
    const done = frames.find((item) => item.event === 'done');
    return Boolean(done?.cancelled);
  }

  /** Sign out through the provider's own command. */
  async logout(
    provider: SubscriptionProvider = 'claude',
    options: { cliPath?: string } = {}
  ): Promise<LoginResult> {
    const frames = await this.request(
      'logout',
      { provider, ...(options.cliPath ? { cli: options.cliPath } : {}) },
      { timeoutMs: 180000 }
    );
    const frame = frames.find((item) => item.event === 'logout');
    if (!frame) throw new AgentError('Signing out gave no answer.');
    if (frame.status) this.lastAuth = frame.status as unknown as AuthStatus;
    return frame as unknown as LoginResult;
  }

  /**
   * One page, one question: layout zones or a transcription. Returns the answer and
   * the model Claude Code reported using, so the caller never has to guess.
   */
  async vision(request: VisionRequest): Promise<{ text: string; model: string | null }> {
    const frames = await this.request(
      'vision',
      {
        prompt: request.prompt,
        // A one-shot page read may fetch the page and crop a region, and nothing else.
        tools:
          request.action === 'layout'
            ? ['get_page_image']
            : ['get_page_image', 'get_line_image'],
        maxTurns: request.maxTurns || 4,
        model: request.model,
        timeout: Math.round((request.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000),
        context: {
          documentId: request.documentId,
          documentName: request.documentName,
          engines: ['claude'],
          languages: [],
          currentPageId: request.pageId || 'page-1',
          selection: request.selection || null,
          // The tools scale the page to this before the model sees it.
          maxEdge: request.maxEdge,
          pages: [
            {
              pageId: request.pageId || 'page-1',
              pageNumber: request.pageNumber ?? 1,
              width: request.width,
              height: request.height,
              renderDpi: null,
              imagePath: request.imagePath,
              zones: request.zones || [],
            },
          ],
        },
      },
      { timeoutMs: (request.timeoutMs || DEFAULT_TIMEOUT_MS) + 30000 }
    );
    const failure = frames.find((frame) => frame.event === 'error');
    if (failure) {
      throw new AgentError(
        String(failure.message || 'Claude Code reported an error.'),
        String(failure.code || '')
      );
    }
    const text = this.finalText(frames).trim();
    if (!text) {
      throw new AgentError(
        'Claude Code returned nothing for this page. Try again, or use one of the offline engines.'
      );
    }
    const session = frames.find((frame) => frame.event === 'session');
    return {
      text,
      model: typeof session?.model === 'string' && session.model ? session.model : null,
    };
  }

  /** One message in the persistent review conversation, streaming as it arrives. */
  async ask(
    prompt: string,
    options: {
      context?: Record<string, unknown>;
      model?: string;
      maxTurns?: number;
      onEvent?: (frame: AgentFrame) => void;
      timeoutMs?: number;
    } = {}
  ): Promise<AgentResult> {
    const frames = await this.request(
      'ask',
      { prompt, context: options.context, model: options.model, maxTurns: options.maxTurns },
      { onEvent: options.onEvent, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS }
    );
    const done = frames.find((frame) => frame.event === 'done');
    if (done) return done as unknown as AgentResult;
    // An error frame ends the request as soon as it arrives, so the precise code and
    // message live there rather than in a later summary.
    const failure = frames.find((frame) => frame.event === 'error');
    if (failure) {
      return {
        ok: false,
        code: String(failure.code || 'agent_error'),
        message: String(failure.message || 'Claude Code reported an error.'),
      };
    }
    return { ok: false, code: 'no_result', message: 'Claude Code gave no answer.' };
  }

  /** Stop the run in flight; the conversation stays usable. */
  async interrupt(): Promise<boolean> {
    if (!this.running) return false;
    const frames = await this.request('interrupt', {}, { timeoutMs: 30000 });
    return Boolean(frames.find((frame) => frame.event === 'done')?.interrupted);
  }

  /** Close the conversation, so the next question starts with no context. */
  async newConversation(): Promise<void> {
    if (!this.running) return;
    await this.request('new-conversation', {}, { timeoutMs: 30000 });
  }

  /** Stop the sidecar, so no orphan `claude` process is left behind. */
  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    this.child = null;
    // Anything still in flight fails now, with a clear reason, rather than waiting
    // for its own timeout.
    this.failAll(new AgentError('The Claude subscription sidecar was stopped.', 'sidecar_stopped'));
    if (!child || child.killed) return;
    try {
      child.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`);
      child.stdin.end();
    } catch {
      /* already gone */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Kill the sidecar at once. Only for process exit, where nothing can be awaited. */
  killNow(): void {
    try {
      this.child?.kill();
    } catch {
      /* already gone */
    }
    this.child = null;
  }
}

export const agentClient = new AgentClient();

// However this server exits, no `claude` process may be left behind.
process.once('exit', () => agentClient.killNow());


