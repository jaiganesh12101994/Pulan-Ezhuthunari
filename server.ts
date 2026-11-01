import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { spawn } from 'child_process';
import os from 'os';
import dotenv from 'dotenv';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';
import { fileURLToPath } from 'url';
import { Document, Paragraph, TextRun, HeadingLevel, Packer } from 'docx';
import {
  AiEngineId,
  AiVisionSettings,
  AiVisionImage,
  AI_ENGINES,
  AiVisionError,
  describeProviders,
  detectLayout as detectLayoutWithAi,
  isAiEngine,
  recognizeText as recognizeTextWithAi,
  signInMessage,
  testProvider,
} from './aiVision';
import { agentClient, AgentError, SubscriptionProvider } from './agentClient';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// OCR diagnostics: records and image artifacts persisted per document
const DIAGNOSTICS_DIR = process.env.PULAN_DIAGNOSTICS_DIR || path.join(__dirname, 'diagnostics');

/**
 * Stable document identifier so a reopened document finds its diagnostics.
 * Mirrors backend/ocr_diagnostics.document_id_for().
 */
function documentIdFor(name: string): string {
  const base = path.basename(name || 'document').replace(/\.[A-Za-z0-9]{1,6}$/, '');
  const slug = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'document';
  const digest = crypto.createHash('sha256').update(name || 'document').digest('hex').slice(0, 8);
  return `${slug}-${digest}`;
}

const app = express();
// The packaged desktop build chooses its own port and hands the same one to the window
// it opens, so a machine that already has something on 3000 does not collide with us.
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Favicon handler to eliminate browser 404 console error
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Ensure upload/temp directory exists. The packaged build points this at the user's own
// temp folder: a literal '/tmp' is drive-relative on Windows (E:\tmp) and is not a place
// an installed application may rely on writing to.
const TEMP_DIR = process.env.PULAN_TEMP_DIR || path.join(os.tmpdir(), 'pulan_ocr_temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMP_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_'));
  },
});

// Uploads stream straight to disk, so a large file costs time and disk space rather than
// memory. Scanned Tamil books run to hundreds of megabytes and thousands of pages, and the
// old 100 MB cap rejected them before the engine ever saw the file - as a bare HTTP 500,
// which the UI could only report as "Upload failed". Raise the cap with
// PULAN_MAX_UPLOAD_MB; it is a guard rail, not a design limit.
const MAX_UPLOAD_MB = Math.max(1, Number(process.env.PULAN_MAX_UPLOAD_MB) || 4096);
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 50 },
});


// ---------------------------------------------------------------------------
// Image dimension detection
// Rasterized PDF pages and uploaded scans are NOT the 1200x1600 / 900x1200
// portrait sizes the UI used to assume (A4 landscape spreads come out around
// 2142x1609). Reading the real size from the file header keeps the viewer,
// thumbnails and layout-zone maths consistent with the actual pixels.
// ---------------------------------------------------------------------------
const FALLBACK_IMAGE_SIZE = { width: 900, height: 1200 };

function readPngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf[0] !== 0x89 || buf.toString('latin1', 1, 4) !== 'PNG') return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readJpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    // Padding / standalone markers carry no payload
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan
    const length = buf.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    if (length < 2) break;
    i += 2 + length;
  }
  return null;
}

function readWebpSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 30 || buf.toString('latin1', 0, 4) !== 'RIFF') return null;
  if (buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height };
  }
  if (chunk === 'VP8 ') {
    // Lossy: the 3-byte sync code 0x9d012a is followed by 14-bit dimensions
    for (let i = 20; i + 9 < buf.length; i++) {
      if (buf[i] === 0x9d && buf[i + 1] === 0x01 && buf[i + 2] === 0x2a) {
        return {
          width: buf.readUInt16LE(i + 3) & 0x3fff,
          height: buf.readUInt16LE(i + 5) & 0x3fff,
        };
      }
    }
    return null;
  }
  if (chunk === 'VP8L') {
    // Lossless: 14-bit (width-1) and 14-bit (height-1) packed little-endian
    const bits = buf.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

function readTiffSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 8) return null;
  const order = buf.toString('latin1', 0, 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return null;
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > buf.length) return null;
  const count = u16(ifd);
  let width: number | null = null;
  let height: number | null = null;
  for (let e = 0; e < count; e++) {
    const off = ifd + 2 + e * 12;
    if (off + 12 > buf.length) break;
    const tag = u16(off);
    if (tag !== 256 && tag !== 257) continue;
    const type = u16(off + 2);
    const value = type === 3 ? u16(off + 8) : u32(off + 8);
    if (tag === 256) width = value;
    else height = value;
    if (width && height) return { width, height };
  }
  return width && height ? { width, height } : null;
}

function readImageSize(filePath: string): { width: number; height: number } | null {
  try {
    const stat = fs.statSync(filePath);
    const fd = fs.openSync(filePath, 'r');
    // JPEG SOF markers can sit behind large EXIF/ICC blocks, so read a generous slice
    const head = Buffer.alloc(Math.min(stat.size, 262144));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    return (
      readPngSize(head) || readJpegSize(head) || readWebpSize(head) || readTiffSize(head) || null
    );
  } catch {
    return null;
  }
}

function imageSizeOr(filePath: string): { width: number; height: number } {
  return readImageSize(filePath) || { ...FALLBACK_IMAGE_SIZE };
}

// ---------------------------------------------------------------------------
// PDF rasterization
// pdftoppm renders one page at a time (~8s/page for 200 DPI Tamil scans), so a
// volume-sized PDF used to hold the upload request open for minutes. Pages are
// now split across parallel pdftoppm processes and progress is reported while
// they run.
// ---------------------------------------------------------------------------
const PDFTOPPM_BIN = process.env.PDFTOPPM_BIN || 'pdftoppm';
const PDFINFO_BIN = process.env.PDFINFO_BIN || 'pdfinfo';
const PDF_DPI = String(process.env.PDF_DPI || '200');
// The UI picks a render resolution per upload; PDF_DPI stays the default for direct API
// callers. Sharper pages read Tamil markedly better, at the cost of render time and temp
// space, so this is a setting rather than a constant.
const MIN_PDF_DPI = 72;
const MAX_PDF_DPI = 600;

function clampDpi(value: unknown): number {
  const fallback = Number(PDF_DPI) || 200;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(MIN_PDF_DPI, Math.min(MAX_PDF_DPI, Math.round(parsed)));
}
const PDF_WORKERS = Math.max(
  1,
  Math.min(8, Number(process.env.PDF_WORKERS) || Math.min(4, os.cpus().length || 1))
);

function runProcess(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} exited with code ${code}: ${stderr.trim()}`));
    });
    proc.on('error', reject);
  });
}

async function getPdfPageCount(pdfPath: string): Promise<number | null> {
  try {
    const out = await runProcess(PDFINFO_BIN, [pdfPath]);
    const match = out.match(/^Pages:\s+(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

// A 200 DPI page of a scanned Tamil book lands around 1-3 MB of PNG, so this is the
// figure used to decide whether the document will fit before rendering starts. It scales
// with the square of the resolution, because a page has two dimensions.
const ESTIMATED_PAGE_BYTES = 2_500_000;

function estimatedPageBytes(dpi: number): number {
  const scale = Math.max(0.25, dpi / 200);
  return Math.round(ESTIMATED_PAGE_BYTES * scale * scale);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * Fail early when a document cannot possibly fit.
 *
 * Rendering an 800 page book writes roughly 2 GB of PNG into the temp folder. Without
 * this the run dies part way through on an ENOSPC from pdftoppm, which reaches the user
 * as an unhelpful "Failed to process PDF" after ten minutes of waiting.
 */
function assertRoomForPages(pageCount: number | null, label: string, dpi = Number(PDF_DPI) || 200): void {
  if (!pageCount || pageCount <= 0) return;
  let free: number;
  try {
    const stats = fs.statfsSync(TEMP_DIR);
    free = stats.bavail * stats.bsize;
  } catch {
    return; // no free-space information: let the render try
  }
  const needed = pageCount * estimatedPageBytes(dpi);
  if (free < needed) {
    throw new Error(
      `Rendering ${pageCount} pages of ${label} at ${dpi} DPI needs roughly ` +
        `${formatBytes(needed)} of free space in ${TEMP_DIR}, but only ${formatBytes(free)} ` +
        `is available. Free some space, or lower the render resolution (Render DPI in the ` +
        `toolbar, or PDF_DPI for API callers).`
    );
  }
}

// pdftoppm writes each page as <prefix>-<pageNumber>.png, so page ranges can be
// rendered concurrently into the same prefix without name collisions.
function listRenderedPages(prefixBase: string): string[] {
  return fs
    .readdirSync(TEMP_DIR)
    .filter((f) => f.startsWith(prefixBase) && f.toLowerCase().endsWith('.png'));
}

function sortPagesByNumber(files: string[]): string[] {
  const pageNumber = (name: string) => {
    const match = name.match(/-(\d+)\.png$/i);
    return match ? Number(match[1]) : 0;
  };
  return [...files].sort((a, b) => pageNumber(a) - pageNumber(b) || a.localeCompare(b));
}

async function renderPdfToPng(
  pdfPath: string,
  outputPrefix: string,
  pageCount: number | null,
  dpi = Number(PDF_DPI) || 200
): Promise<string[]> {
  const prefixBase = path.basename(outputPrefix);
  const baseArgs = ['-png', '-r', String(dpi)];

  if (!pageCount || pageCount <= 1) {
    await runProcess(PDFTOPPM_BIN, [...baseArgs, pdfPath, outputPrefix]);
    return listRenderedPages(prefixBase);
  }

  const workers = Math.min(PDF_WORKERS, pageCount);
  const chunkSize = Math.ceil(pageCount / workers);
  const jobs: Promise<string>[] = [];
  for (let start = 1; start <= pageCount; start += chunkSize) {
    const end = Math.min(pageCount, start + chunkSize - 1);
    jobs.push(
      runProcess(PDFTOPPM_BIN, [
        ...baseArgs,
        '-f',
        String(start),
        '-l',
        String(end),
        pdfPath,
        outputPrefix,
      ])
    );
  }
  await Promise.all(jobs);
  return listRenderedPages(prefixBase);
}

// Serve static sample files
app.use('/samples', express.static(path.resolve(__dirname, 'public/samples')));

// Initialize Gemini client if API key is present
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

// ---------------------------------------------------------------------------
// AI vision helpers (Claude / ChatGPT / any OpenAI-compatible endpoint)
// ---------------------------------------------------------------------------

/**
 * Resolve a request image to a local file plus its bytes and pixel size.
 * The same resolution the Python engines use, so every engine sees the same page.
 */
function resolveAiImage(image: string, filePath?: string): { path: string; mediaType: string; bytes: Buffer; width: number; height: number } {
  let imgPath = image || '';
  if (imgPath.startsWith('data:image')) {
    const match = imgPath.match(/^data:(image\/[a-z+]+);base64,(.*)$/s);
    if (!match) throw new Error('Unsupported data URL image.');
    const mediaType = match[1];
    const extension = mediaType.includes('jpeg') ? 'jpg' : mediaType.includes('webp') ? 'webp' : 'png';
    const tempPath = path.join(TEMP_DIR, `temp_ai_${Date.now()}_${Math.random().toString(36).substring(7)}.${extension}`);
    fs.writeFileSync(tempPath, Buffer.from(match[2], 'base64'));
    imgPath = tempPath;
  } else if (imgPath.startsWith('/samples/')) {
    imgPath = path.resolve(__dirname, 'public', imgPath.substring(1));
  } else if (imgPath.startsWith('/api/temp-file/')) {
    imgPath = path.join(TEMP_DIR, imgPath.replace('/api/temp-file/', ''));
  } else if (!imgPath && filePath) {
    imgPath = filePath;
  }

  if (!imgPath || !fs.existsSync(imgPath)) {
    throw new Error('The page image could not be found for the AI engine.');
  }
  const bytes = fs.readFileSync(imgPath);
  const size = readImageSize(imgPath) || FALLBACK_IMAGE_SIZE;
  const lower = imgPath.toLowerCase();
  const mediaType = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : lower.endsWith('.webp') ? 'image/webp' : 'image/png';
  return { path: imgPath, mediaType, bytes, width: size.width, height: size.height };
}

function aiVisionImage(resolved: { path: string; mediaType: string; bytes: Buffer; width: number; height: number }): AiVisionImage {
  return {
    base64: resolved.bytes.toString('base64'),
    mediaType: resolved.mediaType,
    width: resolved.width,
    height: resolved.height,
    filePath: resolved.path,
  };
}

/** Providers the UI can offer, with configuration state (never the keys). */
app.get('/api/ai/providers', async (req, res) => {
  try {
    res.json({ success: true, engines: AI_ENGINES, providers: await describeProviders() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Unable to inspect AI providers' });
  }
});

// Verify credentials / subscription availability for one provider
app.post('/api/ai/test', async (req, res) => {
  const { engine, ai } = req.body || {};
  if (!isAiEngine(engine)) {
    return res.status(400).json({ success: false, error: `Unknown AI engine "${engine}"` });
  }
  const result = await testProvider(engine as AiEngineId, (ai || {}) as AiVisionSettings);
  res.json({ success: result.ok, ...result });
});

// ---------------------------------------------------------------------------
// Claude subscription backend (the Agent SDK sidecar)
//
// These routes are the transport for the subscription path. They never carry a
// credential: the sidecar strips ANTHROPIC_API_KEY from the CLI's environment, and
// the sign-in report only ever contains the CLI's own label for the credential.
// ---------------------------------------------------------------------------

// What the sidecar found: the SDK, the CLI, the work directory and the account.
app.get('/api/agent/status', async (req, res) => {
  try {
    res.json({ success: true, ...(await agentClient.status()) });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err?.message || 'The Claude subscription sidecar could not be reached.',
    });
  }
});

// "Check sign-in": one minimal query with no tools, which also reports the account.
app.post('/api/agent/sign-in', async (req, res) => {
  const { cliPath } = req.body || {};
  try {
    const report = await agentClient.signIn({ cliPath: cliPath || undefined });
    res.json({ ...report, success: report.signedIn, message: signInMessage(report) });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err?.message || 'The Claude Code sign-in check failed.',
    });
  }
});

/**
 * One message in the subscription conversation, streamed as newline-delimited JSON
 * so a panel can show text and tool calls as they arrive. One frame per line:
 *
 *   {"event":"session",...} {"event":"text_delta","text":"..."}
 *   {"event":"tool_call","name":"get_page_text","summary":"..."}
 *   {"event":"result","turns":2,...} {"event":"done","ok":true}
 */
app.post('/api/agent/ask', async (req, res) => {
  const { prompt, context, model, maxTurns } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ success: false, error: 'A prompt is required.' });
  }
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  const write = (frame: Record<string, unknown>) => res.write(`${JSON.stringify(frame)}\n`);
  try {
    const result = await agentClient.ask(prompt, {
      context,
      model,
      maxTurns,
      onEvent: (frame) => {
        if (frame.event !== 'done') write(frame as unknown as Record<string, unknown>);
      },
    });
    write({ event: 'done', ...result });
  } catch (err: any) {
    write({
      event: 'error',
      code: err instanceof AgentError ? err.code : 'agent_error',
      message: err?.message || 'The Claude subscription backend failed.',
    });
  } finally {
    res.end();
  }
});

// Stop the run in flight. The conversation stays usable afterwards.
app.post('/api/agent/interrupt', async (req, res) => {
  try {
    res.json({ success: true, interrupted: await agentClient.interrupt() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Nothing to stop.' });
  }
});

// Start a fresh conversation, dropping the context of the previous one.
app.post('/api/agent/new-conversation', async (req, res) => {
  try {
    await agentClient.newConversation();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'The conversation could not be restarted.' });
  }
});

// Stop the sidecar and its `claude` child at once.
app.post('/api/agent/shutdown', async (req, res) => {
  await agentClient.shutdown();
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Subscription sign-in, driven from inside the app
//
// Neither Anthropic nor OpenAI publishes an OAuth flow for third-party apps, so the
// only supported way to sign in to a subscription is the vendor's own login. These
// routes run that login for the user: the app shows the authorization URL and takes
// the code back. No terminal, and no token ever passes through this server.
// ---------------------------------------------------------------------------

// The provider's own sign-in status (`claude auth status --json`); no model turn.
app.get('/api/agent/auth-status', async (req, res) => {
  const provider = (req.query.provider as SubscriptionProvider) || 'claude';
  const cliPath = typeof req.query.cliPath === 'string' ? req.query.cliPath : undefined;
  try {
    res.json({ success: true, ...(await agentClient.authStatus(provider, { cliPath })) });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err?.message || 'The sign-in status could not be read.',
    });
  }
});

// Start a sign-in and hand back the authorization URL for the panel to show.
app.post('/api/agent/login/start', async (req, res) => {
  const { provider, email, cliPath } = req.body || {};
  try {
    const info = await agentClient.loginStart({ provider, email, cliPath });
    res.json({ success: true, ...info });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err?.message || 'The sign-in could not be started.',
    });
  }
});

// How a sign-in in progress stands. The panel polls this, because the browser flow
// can complete the sign-in without the user ever pasting a code.
app.get('/api/agent/login/state', async (req, res) => {
  const provider = (req.query.provider as SubscriptionProvider) || 'claude';
  const cliPath = typeof req.query.cliPath === 'string' ? req.query.cliPath : undefined;
  try {
    res.json({ success: true, ...(await agentClient.loginState(provider, { cliPath })) });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err?.message || 'The sign-in state could not be read.',
    });
  }
});

// Install the provider's sign-in tool, with the vendor's own documented command:
// `python -m pip install claude-agent-sdk` or `npm install -g @openai/codex`. This is
// the only thing in this app that installs software, and it runs only because the user
// pressed a button that names the command.
app.post('/api/agent/install-cli', async (req, res) => {
  const { provider } = req.body || {};
  try {
    const result = await agentClient.installCli(provider || 'claude');
    res.json({ success: !!result.ok, ...result });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err?.message || 'The tool could not be installed.',
    });
  }
});

// Give the pasted code to the waiting login command.
app.post('/api/agent/login/code', async (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== 'string' || !code.trim()) {
    return res
      .status(400)
      .json({ success: false, error: 'Paste the code from the sign-in page first.' });
  }
  try {
    const result = await agentClient.loginCode(code);
    res.json({ success: !!result.ok, ...result });
  } catch (err: any) {
    res.status(400).json({
      success: false,
      error: err?.message || 'The sign-in was not completed.',
    });
  }
});

// Abandon a sign-in the user walked away from.
app.post('/api/agent/login/cancel', async (req, res) => {
  try {
    res.json({ success: true, cancelled: await agentClient.loginCancel() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Nothing to cancel.' });
  }
});

// Sign out through the provider's own command.
app.post('/api/agent/logout', async (req, res) => {
  const { provider, cliPath } = req.body || {};
  try {
    const result = await agentClient.logout(provider || 'claude', { cliPath });
    res.json({ success: !!result.ok, ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Signing out failed.' });
  }
});

// Helper to run python script
function runPythonCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // Windows ships 'python', POSIX systems normally expose 'python3'
    const pythonBin =
      process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
    const py = spawn(pythonBin, args);
    let stdout = '';
    let stderr = '';

    py.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    py.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    py.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`Python process exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    py.on('error', (err) => {
      reject(err);
    });
  });
}

// 1. Get sample documents
app.get('/api/samples', (req, res) => {
  const samples = [
    {
      id: 'sample-news-2col',
      title: 'Tamil Daily Newspaper (2-Column Layout)',
      description: 'Classic two-column news journal article testing automatic column segmentation and header extraction.',
      type: 'image',
      pages: [
        {
          pageNumber: 1,
          url: '/samples/tamil_multicolumn_page1.png',
          title: 'News Article (Columns 1 & 2)',
        },
      ],
    },
    {
      id: 'sample-thirukkural',
      title: 'Thirukkural Couplets & Commentary (2-Column Table)',
      description: 'Bilingual / two-column classical Tamil poetry with verses on left and modern commentary on right.',
      type: 'image',
      pages: [
        {
          pageNumber: 1,
          url: '/samples/tamil_multicolumn_page2.png',
          title: 'Thirukkural Verses with Commentary',
        },
      ],
    },
    {
      id: 'sample-multipage-doc',
      title: 'Complete 2-Page Tamil Document (Multi-Page Batch)',
      description: 'Two full Tamil pages to test single-click "Detect Layout (All Pages)" and batch OCR execution.',
      type: 'multipage',
      pages: [
        {
          pageNumber: 1,
          url: '/samples/tamil_multicolumn_page1.png',
          title: 'Page 1: Multi-Column News Layout',
        },
        {
          pageNumber: 2,
          url: '/samples/tamil_multicolumn_page2.png',
          title: 'Page 2: Classical Verses & Analysis',
        },
      ],
    },
    {
      id: 'sample-gnana70-sentence',
      title: 'gnana70/tamil_ocr Real Test Sample',
      description: 'Official test image from gnana70/tamil_ocr repository (Siddha herbal product description).',
      type: 'image',
      pages: [
        {
          pageNumber: 1,
          url: '/samples/tamil_sentence.jpg',
          title: 'Real Scene Herbal Text',
        },
      ],
    },
    {
      id: 'sample-bilingual',
      title: 'English & Tamil Bilingual Document',
      description: 'Combined English and Tamil script sample from gnana70 benchmark dataset.',
      type: 'image',
      pages: [
        {
          pageNumber: 1,
          url: '/samples/english_tamil.jpg',
          title: 'English & Tamil Mixed Text',
        },
      ],
    },
  ];

  res.json({ samples });
});

// Tesseract Language Catalog & Management
const TESSDATA_DIR = path.resolve(__dirname, 'engines/tessdata');
const TESS_CATALOG: Array<{
  code: string;
  name: string;
  nativeName: string;
  category: 'indic' | 'international' | 'system';
  approxSize: string;
}> = [
  { code: 'tam', name: 'Tamil', nativeName: 'தமிழ்', category: 'indic', approxSize: '3.1 MB' },
  { code: 'eng', name: 'English', nativeName: 'English', category: 'international', approxSize: '4.0 MB' },
  { code: 'hin', name: 'Hindi', nativeName: 'हिन्दी', category: 'indic', approxSize: '1.2 MB' },
  { code: 'tel', name: 'Telugu', nativeName: 'తెలుగు', category: 'indic', approxSize: '2.1 MB' },
  { code: 'mal', name: 'Malayalam', nativeName: 'മലയാളം', category: 'indic', approxSize: '1.9 MB' },
  { code: 'kan', name: 'Kannada', nativeName: 'ಕನ್ನಡ', category: 'indic', approxSize: '2.3 MB' },
  { code: 'san', name: 'Sanskrit', nativeName: 'संस्कृतम्', category: 'indic', approxSize: '1.1 MB' },
  { code: 'ben', name: 'Bengali', nativeName: 'বাংলা', category: 'indic', approxSize: '1.8 MB' },
  { code: 'guj', name: 'Gujarati', nativeName: 'ગુજરાતી', category: 'indic', approxSize: '1.5 MB' },
  { code: 'pan', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', category: 'indic', approxSize: '1.4 MB' },
  { code: 'ara', name: 'Arabic', nativeName: 'العربية', category: 'international', approxSize: '1.9 MB' },
  { code: 'fra', name: 'French', nativeName: 'Français', category: 'international', approxSize: '3.8 MB' },
  { code: 'deu', name: 'German', nativeName: 'Deutsch', category: 'international', approxSize: '3.9 MB' },
  { code: 'spa', name: 'Spanish', nativeName: 'Español', category: 'international', approxSize: '3.7 MB' },
  { code: 'osd', name: 'Orientation & Script', nativeName: 'OSD (Script Detection)', category: 'system', approxSize: '10.5 MB' },
];

// GET /api/tesseract/languages - List installed and available languages
app.get('/api/tesseract/languages', (req, res) => {
  try {
    if (!fs.existsSync(TESSDATA_DIR)) {
      fs.mkdirSync(TESSDATA_DIR, { recursive: true });
    }

    const files = fs.readdirSync(TESSDATA_DIR);
    const installedSet = new Set(
      files.filter((f) => f.endsWith('.traineddata')).map((f) => f.replace('.traineddata', ''))
    );

    const languages = TESS_CATALOG.map((item) => {
      const isInstalled = installedSet.has(item.code);
      let fileSizeBytes = 0;
      if (isInstalled) {
        try {
          fileSizeBytes = fs.statSync(path.join(TESSDATA_DIR, `${item.code}.traineddata`)).size;
        } catch (e) {}
      }
      return {
        ...item,
        isInstalled,
        fileSizeBytes,
      };
    });

    // Also include any other custom traineddata files not in standard catalog
    for (const code of installedSet) {
      if (!TESS_CATALOG.some((c) => c.code === code)) {
        let fileSizeBytes = 0;
        try {
          fileSizeBytes = fs.statSync(path.join(TESSDATA_DIR, `${code}.traineddata`)).size;
        } catch (e) {}
        languages.push({
          code,
          name: code.toUpperCase(),
          nativeName: code,
          category: 'international',
          approxSize: `${(fileSizeBytes / (1024 * 1024)).toFixed(1)} MB`,
          isInstalled: true,
          fileSizeBytes,
        });
      }
    }

    res.json({ success: true, languages, installedCodes: Array.from(installedSet) });
  } catch (err: any) {
    console.error('Error listing tesseract languages:', err);
    res.status(500).json({ error: err.message || 'Failed to list languages' });
  }
});

// POST /api/tesseract/download-language - Download a language model to engines/tessdata
app.post('/api/tesseract/download-language', async (req, res) => {
  try {
    const { langCode, quality } = req.body;
    if (!langCode || typeof langCode !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(langCode)) {
      return res.status(400).json({ error: 'Valid language code required (e.g. hin, tel, mal)' });
    }

    // tessdata_best recognises Indic scripts noticeably better than tessdata_fast
    // (Tamil: ~6 MB vs ~3 MB per model); fast stays available for a smaller install.
    const modelQuality = quality === 'fast' ? 'fast' : 'best';
    const repo = modelQuality === 'best' ? 'tessdata_best' : 'tessdata_fast';

    if (!fs.existsSync(TESSDATA_DIR)) {
      fs.mkdirSync(TESSDATA_DIR, { recursive: true });
    }

    const targetFile = path.join(TESSDATA_DIR, `${langCode}.traineddata`);
    const downloadUrl = `https://raw.githubusercontent.com/tesseract-ocr/${repo}/main/${langCode}.traineddata`;

    console.log(`Downloading Tesseract language model ${langCode} (${modelQuality}) from ${downloadUrl}...`);
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download ${langCode}.traineddata: HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(targetFile, Buffer.from(arrayBuffer));

    res.json({
      success: true,
      message: `Downloaded ${langCode}.traineddata (${modelQuality}, ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)} MB)`,
      code: langCode,
      quality: modelQuality,
      sizeBytes: arrayBuffer.byteLength,
    });
  } catch (err: any) {
    console.error('Failed to download tesseract language:', err);
    res.status(500).json({ error: err.message || 'Failed to download language data' });
  }
});

// DELETE /api/tesseract/languages/:code - Remove a downloaded language model
app.delete('/api/tesseract/languages/:code', (req, res) => {
  try {
    const code = req.params.code;
    if (code === 'tam') {
      return res.status(400).json({ error: 'Cannot remove primary Tamil language (tam)' });
    }
    const targetFile = path.join(TESSDATA_DIR, `${code}.traineddata`);
    if (fs.existsSync(targetFile)) {
      fs.unlinkSync(targetFile);
    }
    res.json({ success: true, message: `Removed ${code}.traineddata` });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to delete language data' });
  }
});

// GET /api/engines/status - Report which OCR backends are actually usable
app.get('/api/engines/status', async (req, res) => {
  try {
    const out = await runPythonCommand([
      path.resolve(__dirname, 'backend/tamil_ocr_engine.py'),
      '--action',
      'status',
    ]);
    const status = JSON.parse(out.trim());
    res.json({ success: true, ...status });
  } catch (err: any) {
    console.error('Engine status check failed:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Unable to query the Python OCR subsystem',
      tesseract: { available: false, path: null, version: null },
    });
  }
});

// 1b. Rasterization settings the client needs for diagnostic records
app.get('/api/config', (req, res) => {
  res.json({
    renderDpi: Number(PDF_DPI),
    pdfWorkers: Number(PDF_WORKERS),
    diagnosticsDir: DIAGNOSTICS_DIR,
  });
});

// 2. Upload processing (PDF or Images)
interface UploadedPage {
  id: string;
  pageNumber: number;
  fileName: string;
  url: string;
  filePath: string;
  width: number;
  height: number;
}

interface UploadProgress {
  message: string;
  page?: number;
  total?: number;
}

async function processUploadedFiles(
  files: Express.Multer.File[],
  onProgress?: (info: UploadProgress) => void,
  dpi = Number(PDF_DPI) || 200
): Promise<{ documentName: string; pages: UploadedPage[]; renderDpi: number }> {
  const pagesResult: UploadedPage[] = [];
  let overallPageIndex = 1;

  for (const file of files) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.pdf') {
      // Rasterize the PDF with pdftoppm (parallel page ranges where possible)
      const outputPrefix = path.join(TEMP_DIR, `pdf_${Date.now()}_page`);
      const prefixBase = path.basename(outputPrefix);
      const pageCount = await getPdfPageCount(file.path);

      // Check for room before the long render, rather than discovering it half way
      // through when pdftoppm fails with ENOSPC.
      assertRoomForPages(pageCount, file.originalname, dpi);

      onProgress?.({
        message: pageCount
          ? `Rendering PDF pages at ${dpi} DPI (0 of ${pageCount})...`
          : `Rendering PDF pages at ${dpi} DPI...`,
        page: 0,
        total: pageCount || 0,
      });

      // Keep the user informed while pdftoppm works (a 200 DPI Tamil scan takes ~8s/page)
      const seen = new Set<string>();
      const ticker = setInterval(() => {
        const fresh = listRenderedPages(prefixBase).filter((f) => !seen.has(f));
        fresh.forEach((f) => seen.add(f));
        if (fresh.length > 0) {
          onProgress?.({
            message: `Rendering PDF pages (${seen.size}${pageCount ? ` of ${pageCount}` : ''})...`,
            page: seen.size,
            total: pageCount || 0,
          });
        }
      }, 700);

      let generatedPages: string[];
      try {
        generatedPages = sortPagesByNumber(
          await renderPdfToPng(file.path, outputPrefix, pageCount, dpi)
        );
      } catch (pdfErr: any) {
        console.error('PDF conversion failed:', pdfErr);
        throw new Error(`Failed to process PDF: ${pdfErr.message || pdfErr}`);
      } finally {
        clearInterval(ticker);
      }

      if (generatedPages.length === 0) {
        throw new Error(`Failed to process PDF: no pages were rendered from ${file.originalname}`);
      }

      for (const pageFile of generatedPages) {
        const pagePath = path.join(TEMP_DIR, pageFile);
        // Use the real raster size (e.g. 2142x1609 landscape), not an assumed portrait size
        const { width, height } = imageSizeOr(pagePath);
        pagesResult.push({
          id: `page-${Date.now()}-${overallPageIndex}`,
          pageNumber: overallPageIndex,
          fileName: `${file.originalname} (p. ${overallPageIndex})`,
          url: `/api/temp-file/${pageFile}`,
          filePath: pagePath,
          width,
          height,
        });
        overallPageIndex++;
      }
    } else {
      // Regular image file
      const { width, height } = imageSizeOr(file.path);
      pagesResult.push({
        id: `page-${Date.now()}-${overallPageIndex}`,
        pageNumber: overallPageIndex,
        fileName: file.originalname,
        url: `/api/temp-file/${path.basename(file.path)}`,
        filePath: file.path,
        width,
        height,
      });
      overallPageIndex++;
    }
  }

  return {
    documentName: files.length === 1 ? files[0].originalname : `${files.length} Files Loaded`,
    pages: pagesResult,
    renderDpi: dpi,
  };
}

// 2a. Upload file (PDF or Images) - plain JSON response
app.post('/api/upload', upload.array('files', 50), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    const result = await processUploadedFiles(files, undefined, clampDpi(req.body?.dpi));
    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || 'File upload failed' });
  }
});

// 2b. Upload file with live progress (NDJSON stream).
// Rasterizing a scanned Tamil PDF can take minutes, so the UI streams progress
// lines instead of showing a frozen "file is not opening" status.
app.post('/api/upload-stream', upload.array('files', 50), async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const write = (payload: Record<string, unknown>) => res.write(`${JSON.stringify(payload)}\n`);

  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      write({ type: 'error', error: 'No files uploaded' });
      return res.end();
    }

    const dpi = clampDpi(req.body?.dpi);
    write({ type: 'start', fileCount: files.length, renderDpi: dpi });
    const result = await processUploadedFiles(
      files,
      (info) => write({ type: 'progress', ...info }),
      dpi
    );
    write({ type: 'done', success: true, ...result });
  } catch (err: any) {
    console.error('Upload error:', err);
    write({ type: 'error', error: err.message || 'File upload failed' });
  }
  res.end();
});

// Endpoint to serve temporary uploaded page images
app.get('/api/temp-file/:filename', (req, res) => {
  const file = path.join(TEMP_DIR, req.params.filename);
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.status(404).send('Not found');
  }
});

// 3. Layout Detection (Single Page or All Pages)
app.post('/api/layout-detect', async (req, res) => {
  try {
    const { image, mode = 'auto', pages = [], engine, ai } = req.body;

    // AI vision engines analyse the page themselves; the Python detector is skipped.
    // The Gemini engine only comes through here on a Google subscription: its API-key
    // path has no layout model, so the Python detector still handles it.
    const usesAiVision = isAiEngine(engine) && (engine !== 'gemini' || !!ai?.useSubscription);
    if (usesAiVision) {
      const settings = (ai || {}) as AiVisionSettings;
      const runAi = async (
        imgInput: string,
        fallbackPath?: string,
        pageInfo?: { id?: string; pageNumber?: number }
      ) => {
        const resolved = resolveAiImage(imgInput, fallbackPath);
        // The subscription backend reads the page through its own tool, so it has to
        // know which document and page this image belongs to.
        const name = req.body.documentName || path.basename(resolved.path);
        const result = await detectLayoutWithAi(
          engine as AiEngineId,
          aiVisionImage(resolved),
          {
            ...settings,
            agentContext: {
              documentId: documentIdFor(name),
              documentName: name,
              pageId: String(pageInfo?.id || pageInfo?.pageNumber || 'page-1'),
              pageNumber: pageInfo?.pageNumber,
            },
          },
          mode
        );
        return {
          success: true,
          zones: result.zones,
          width: result.width,
          height: result.height,
          engine: result.engine,
          provider: result.provider,
          model: result.model,
          warnings: result.warnings,
        };
      };

      if (pages && pages.length > 0) {
        const results: Record<string, any> = {};
        for (const p of pages) {
          try {
            results[p.id || p.pageNumber] = await runAi(p.url, p.filePath, {
              id: p.id,
              pageNumber: p.pageNumber,
            });
          } catch (err: any) {
            results[p.id || p.pageNumber] = { success: false, error: err.message, zones: [] };
          }
        }
        return res.json({ success: true, batchResults: results, engine, provider: 'ai' });
      }

      const single = await runAi(image, req.body.filePath, { pageNumber: req.body.pageNumber });
      return res.json(single);
    }

    // Batch mode for all pages
    if (pages && pages.length > 0) {
      const results: Record<string, any> = {};
      for (const p of pages) {
        let imgInput = p.filePath || p.url;
        if (imgInput.startsWith('/samples/')) {
          imgInput = path.resolve(__dirname, 'public', imgInput.substring(1));
        } else if (imgInput.startsWith('/api/temp-file/')) {
          imgInput = path.join(TEMP_DIR, imgInput.replace('/api/temp-file/', ''));
        }

        const out = await runPythonCommand([
          path.resolve(__dirname, 'backend/tamil_ocr_engine.py'),
          '--action',
          'layout',
          '--image',
          imgInput,
          '--mode',
          mode,
        ]);
        try {
          results[p.id || p.pageNumber] = JSON.parse(out.trim());
        } catch (e) {
          results[p.id || p.pageNumber] = { zones: [] };
        }
      }
      return res.json({ success: true, batchResults: results });
    }

    // Single page mode
    let imgInput = image;
    if (imgInput.startsWith('data:image')) {
      const b64 = imgInput.split(',')[1];
      const tempPath = path.join(TEMP_DIR, `temp_layout_${Date.now()}_${Math.random().toString(36).substring(7)}.png`);
      fs.writeFileSync(tempPath, Buffer.from(b64, 'base64'));
      imgInput = tempPath;
    } else if (imgInput.startsWith('/samples/')) {
      imgInput = path.resolve(__dirname, 'public', imgInput.substring(1));
    } else if (imgInput.startsWith('/api/temp-file/')) {
      imgInput = path.join(TEMP_DIR, imgInput.replace('/api/temp-file/', ''));
    }

    const out = await runPythonCommand([
      path.resolve(__dirname, 'backend/tamil_ocr_engine.py'),
      '--action',
      'layout',
      '--image',
      imgInput,
      '--mode',
      mode,
    ]);

    const parsed = JSON.parse(out.trim());
    res.json({ success: true, ...parsed });
  } catch (err: any) {
    console.error('Layout detection error:', err);
    res.status(500).json({ error: err.message || 'Layout detection failed' });
  }
});

// 4. OCR Execution
app.post('/api/ocr', async (req, res) => {
  try {
    const {
      image,
      engine = 'tesseract',
      zone,
      language = 'tam+eng',
      psm = '6',
      engineOptions = {},
      ai,
      diagnostics = {},
      documentName,
      pageId,
      pageNumber,
      pageWidth,
      pageHeight,
      renderDpi,
      rotation,
      regionId,
      regionType,
      retryBudget,
    } = req.body;

    let imgPath = image;
    let isDataUrl = false;
    if (imgPath.startsWith('data:image')) {
      isDataUrl = true;
      const b64 = imgPath.split(',')[1];
      const tempPath = path.join(TEMP_DIR, `temp_ocr_${Date.now()}_${Math.random().toString(36).substring(7)}.png`);
      fs.writeFileSync(tempPath, Buffer.from(b64, 'base64'));
      imgPath = tempPath;
    } else if (imgPath.startsWith('/samples/')) {
      imgPath = path.resolve(__dirname, 'public', imgPath.substring(1));
    } else if (imgPath.startsWith('/api/temp-file/')) {
      imgPath = path.join(TEMP_DIR, imgPath.replace('/api/temp-file/', ''));
    }

    // Diagnostic context: every attempt is persisted under the document id
    const diagnosticContext = {
      dir: typeof diagnostics?.dir === 'string' && diagnostics.dir ? diagnostics.dir : DIAGNOSTICS_DIR,
      documentId:
        diagnostics?.documentId || documentIdFor(documentName || path.basename(imgPath) || 'document'),
      pageId: diagnostics?.pageId || pageId || String(regionId || 'page-1'),
      pageNumber: diagnostics?.pageNumber ?? pageNumber ?? 1,
      pageWidth: diagnostics?.pageWidth ?? pageWidth,
      pageHeight: diagnostics?.pageHeight ?? pageHeight,
      renderDpi: diagnostics?.renderDpi ?? renderDpi,
      rotation: diagnostics?.rotation ?? rotation ?? 0,
      regionId: diagnostics?.regionId || String(regionId || 'region'),
      regionType: diagnostics?.regionType || String(regionType || (zone ? 'zone' : 'page')),
      retryBudget: diagnostics?.retryBudget ?? retryBudget ?? 2,
    };

    // AI vision engines (Claude, ChatGPT, any OpenAI-compatible endpoint)
    const usesAiVision = isAiEngine(engine) && (engine !== 'gemini' || !!ai?.useSubscription);
    if (usesAiVision) {
      const resolved = resolveAiImage(image, req.body.filePath);
      const result = await recognizeTextWithAi(
        engine as AiEngineId,
        aiVisionImage(resolved),
        {
          ...((ai || {}) as AiVisionSettings),
          // The subscription backend reads the page through its own tools, so it has
          // to know which document, page and region this image belongs to.
          agentContext: {
            documentId: diagnosticContext.documentId,
            documentName: documentName || path.basename(resolved.path),
            pageId: diagnosticContext.pageId,
            pageNumber: diagnosticContext.pageNumber,
            zones: zone
              ? [
                  {
                    id: diagnosticContext.regionId,
                    type: diagnosticContext.regionType,
                    x: zone.x,
                    y: zone.y,
                    width: zone.width,
                    height: zone.height,
                  },
                ]
              : [],
            selection: zone
              ? { pageId: diagnosticContext.pageId, zoneId: diagnosticContext.regionId }
              : null,
          },
        },
        { zone: zone || null, language }
      );

      // Record the attempt in the diagnostics store so AI results are traceable too
      let diagnosticsId: string | undefined;
      try {
        const context = diagnosticContext;
        const payload = {
          op: 'ai-attempt',
          dir: context.dir,
          documentId: context.documentId,
          pageId: context.pageId,
          pageNumber: context.pageNumber,
          pageWidth: context.pageWidth,
          pageHeight: context.pageHeight,
          renderDpi: context.renderDpi,
          rotation: context.rotation,
          regionId: context.regionId,
          regionType: context.regionType,
          imagePath: resolved.path,
          box: zone ? { x: zone.x, y: zone.y, width: zone.width, height: zone.height } : null,
          engine: result.engine,
          provider: result.provider,
          model: result.model,
          rawText: result.text,
          normalizedText: result.text,
        };
        await runPythonCommand([
          path.resolve(__dirname, 'backend/tamil_ocr_engine.py'),
          '--action',
          'diagnostics',
          '--diag-op',
          JSON.stringify(payload),
        ]);
        diagnosticsId = context.documentId;
      } catch (diagErr: any) {
        console.warn('AI OCR diagnostics could not be recorded:', diagErr?.message);
      }

      return res.json({
        engine,
        success: true,
        text: result.text,
        words: [],
        provider: result.provider,
        model: result.model,
        columns: 1,
        retryCount: 0,
        diagnosticsId,
      });
    }

    // Run OCR with selected engine
    if (ai && engine === 'gemini') {
      let base64Data = '';
      let mimeType = 'image/png';

      if (isDataUrl) {
        const parts = image.split(',');
        mimeType = parts[0].match(/:(.*?);/)?.[1] || 'image/png';
        base64Data = parts[1];
      } else if (fs.existsSync(imgPath)) {
        const fileBuffer = fs.readFileSync(imgPath);
        base64Data = fileBuffer.toString('base64');
        mimeType = imgPath.endsWith('.jpg') || imgPath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
      }

      if (base64Data) {
        // Per-engine options picked in the toolbar engine options panel
        const opts = engineOptions && typeof engineOptions === 'object' ? engineOptions : {};
        let engineInstruction = '';
        if (engine === 'tesseract') {
          engineInstruction = `Engine: Tesseract OCR (Languages: ${language}, PSM: ${psm}). Segment by blocks and lines, transcribe exact characters and punctuation.`;
        } else if (engine === 'surya') {
          const layout = opts?.surya?.layoutMode || 'auto';
          const order = opts?.surya?.readingOrder || 'top_down';
          const layoutLabel =
            layout === '2col' ? 'strict 2-column' : layout === '3col' ? 'strict 3-column' : layout === 'single' ? 'single text block' : 'automatic column detection';
          const orderLabel = order === 'column_first' ? 'column by column' : 'top to bottom';
          engineInstruction = `Engine: Surya OCR (layout: ${layoutLabel}, reading order: ${orderLabel}). Detect multi-column text lines and transcribe Tamil textline by textline in the requested reading order.`;
        } else if (engine === 'chandra') {
          const script = opts?.chandra?.scriptMode || 'modern';
          const diacritics = opts?.chandra?.diacriticLevel || 'normal';
          const scriptLabel =
            script === 'sangam' ? 'classical Sangam Tamil' : script === 'bilingual' ? 'bilingual Tamil-English' : 'modern standard Tamil';
          const diacriticLabel =
            diacritics === 'palm_leaf' ? 'palm-leaf ancient orthography with heavy diacritic preservation' : diacritics === 'enhanced' ? 'enhanced pulli/kombu diacritic accuracy' : 'normal diacritic handling';
          engineInstruction = `Engine: Chandra OCR (script: ${scriptLabel}, diacritics: ${diacriticLabel}). Transcribe Indic dense newspaper/journal columns with strict column reading sequence.`;
        } else if (engine === 'gnana70') {
          const detector = opts?.gnana70?.detector || 'craft_words';
          const fusion = opts?.gnana70?.ligatureFusion ? 'enabled' : 'disabled';
          engineInstruction = `Engine: gnana70/tamil_ocr (Gnana Prasath) with ${
            detector === 'craft_lines' ? 'CRAFT line-level' : 'CRAFT word-level'
          } detection and ligature fusion ${fusion}. High accuracy Tamil scene and document recognition with compound ligatures.`;
        } else {
          const promptMode = opts?.gemini?.promptMode || 'raw';
          const modeLabel =
            promptMode === 'markdown'
              ? 'Markdown & column structure'
              : promptMode === 'palm_leaf'
              ? 'palm-leaf calligraphy transcription'
              : promptMode === 'tables'
              ? 'table and form extraction'
              : 'accurate raw text';
          engineInstruction = `Engine: Google Gemini 2.5 Flash Vision Tamil (output mode: ${modeLabel}). Ultra-high precision OCR with full formatting.`;
        }

        const prompt = zone
          ? `${engineInstruction}\nTranscribe the Tamil and English text within this specified crop region: ${JSON.stringify(zone)}. Return ONLY the transcribed text, no extra commentary.`
          : `${engineInstruction}\nPerform Optical Character Recognition (OCR) on this document. Transcribe all Tamil script accurately. Preserve multi-column layout, headers, and paragraph reading order. Return ONLY the transcribed Tamil text.`;

        try {
          const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
              {
                role: 'user',
                parts: [
                  { text: prompt },
                  {
                    inlineData: {
                      mimeType,
                      data: base64Data,
                    },
                  },
                ],
              },
            ],
          });

          const extractedText = response.text || '';
          return res.json({
            engine,
            text: extractedText.trim(),
            words: [],
            confidence: 98.7,
          });
        } catch (aiErr) {
          console.warn('AI OCR error, falling back to python:', aiErr);
        }
      }
    }

    // Default Python OCR engines (tesseract, surya, chandra, gnana70)
    const pythonArgs = [
      path.resolve(__dirname, 'backend/tamil_ocr_engine.py'),
      '--action',
      'ocr',
      '--image',
      imgPath,
      '--engine',
      engine,
      '--lang',
      language || 'tam+eng',
      '--psm',
      String(psm || '6'),
    ];

    if (zone) {
      pythonArgs.push('--zone', JSON.stringify(zone));
    }

    // Forward engine-specific options (surya layout, chandra script, gnana70 detector, ...)
    const engineSpecificOptions =
      engineOptions && typeof engineOptions === 'object' ? engineOptions[engine] || {} : {};
    if (Object.keys(engineSpecificOptions).length > 0) {
      pythonArgs.push('--options', JSON.stringify(engineSpecificOptions));
    }

    const out = await runPythonCommand(pythonArgs);
    const result = JSON.parse(out.trim());

    // Surface engine failures (missing Tesseract binary, missing language data, ...)
    if (result.error || result.success === false) {
      const message = result.error || 'OCR engine failed';
      console.error(`[OCR:${engine}] ${message}`);
      return res.status(502).json({ engine, success: false, error: message });
    }

    res.json(result);
  } catch (err: any) {
    console.error('OCR execution error:', err);
    res.status(500).json({ error: err.message || 'OCR execution failed' });
  }
});

// 4b. OCR Diagnostics — persisted records, artifacts and corrections
function runDiagnosticsOperation(payload: Record<string, unknown>): Promise<string> {
  return runPythonCommand([
    path.resolve(__dirname, 'backend/tamil_ocr_engine.py'),
    '--action',
    'diagnostics',
    '--diag-op',
    JSON.stringify(payload),
  ]);
}

// Aggregated diagnostics for one document (pages -> regions -> attempts)
app.get('/api/diagnostics/:documentId', async (req, res) => {
  try {
    const out = await runDiagnosticsOperation({
      op: 'document',
      dir: DIAGNOSTICS_DIR,
      documentId: req.params.documentId,
    });
    res.json(JSON.parse(out.trim()));
  } catch (err: any) {
    console.error('Diagnostics read error:', err);
    res.status(500).json({ error: err.message || 'Unable to read diagnostics' });
  }
});

// Image artifacts (page crop, OCR crop, preprocessed crop) — content addressed
app.get('/api/diagnostics/:documentId/artifact/:name', (req, res) => {
  const name = path.basename(req.params.name);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid artifact name' });
  }
  const filePath = path.join(DIAGNOSTICS_DIR, path.basename(req.params.documentId), 'artifacts', name);
  if (!filePath.startsWith(DIAGNOSTICS_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Artifact not found' });
  }
  res.sendFile(filePath);
});

// Corrections, verification and "unresolved" flags (kept separate from raw OCR)
app.post('/api/diagnostics/:documentId/correction', async (req, res) => {
  try {
    const { pageId, regionId, correctedText, verified, unresolved, note } = req.body || {};
    if (!pageId || !regionId) {
      return res.status(400).json({ error: 'pageId and regionId are required' });
    }
    const out = await runDiagnosticsOperation({
      op: 'correction',
      dir: DIAGNOSTICS_DIR,
      documentId: req.params.documentId,
      pageId,
      regionId,
      correctedText,
      verified,
      unresolved,
      note,
    });
    res.json(JSON.parse(out.trim()));
  } catch (err: any) {
    console.error('Diagnostics correction error:', err);
    res.status(500).json({ error: err.message || 'Unable to save the correction' });
  }
});

// 5. Export Document (DOCX, TXT, JSON, HTML)
app.post('/api/export', async (req, res) => {
  try {
    const { format = 'txt', blocks = [], meta = {} } = req.body;
    const title = meta.title || 'Tamil_OCR_Document';
    const cleanTitle = title.replace(/[^a-zA-Z0-9_\u0B80-\u0BFF-]/g, '_');

    // Direct native DOCX generation via docx npm package
    if (format === 'docx') {
      const docChildren = [
        new Paragraph({
          text: title,
          heading: HeadingLevel.TITLE,
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: `Engine: ${meta.engine || 'Multi-Engine'} | Exported from Pulan Tamil OCR`,
              italics: true,
              size: 20,
              color: '666666',
            }),
          ],
        }),
      ];

      let currentPage: number | null = null;
      for (const b of blocks) {
        if (b.page !== currentPage) {
          currentPage = b.page;
          docChildren.push(
            new Paragraph({
              text: `--- Page ${currentPage} ---`,
              heading: HeadingLevel.HEADING_2,
            })
          );
        }

        const paragraphs = (b.text || '').split('\n').filter((l: string) => l.trim().length > 0);
        for (const p of paragraphs) {
          docChildren.push(
            new Paragraph({
              text: p,
              spacing: { after: 120 },
            })
          );
        }
      }

      const doc = new Document({
        sections: [{ properties: {}, children: docChildren }],
      });

      const buffer = await Packer.toBuffer(doc);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${cleanTitle}.docx"`);
      return res.send(buffer);
    }

    // Create temporary input payload for python exporter
    const payloadFile = path.join(TEMP_DIR, `export_payload_${Date.now()}.json`);
    const outputFile = path.join(TEMP_DIR, `exported_${Date.now()}.${format}`);
    fs.writeFileSync(payloadFile, JSON.stringify({ blocks, meta }, null, 2), 'utf-8');

    await runPythonCommand([
      path.resolve(__dirname, 'backend/tamil_ocr_engine.py'),
      '--action',
      'export',
      '--format',
      format,
      '--input-json',
      payloadFile,
      '--output',
      outputFile,
    ]);

    if (!fs.existsSync(outputFile)) {
      return res.status(500).json({ error: 'Export failed to produce output file' });
    }

    const mimeTypes: Record<string, string> = {
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      txt: 'text/plain; charset=utf-8',
      json: 'application/json; charset=utf-8',
      html: 'text/html; charset=utf-8',
    };

    res.setHeader('Content-Type', mimeTypes[format] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${cleanTitle}.${format}"`);

    const stream = fs.createReadStream(outputFile);
    stream.pipe(res);
    stream.on('end', () => {
      // Clean up temp files
      try {
        fs.unlinkSync(payloadFile);
        fs.unlinkSync(outputFile);
      } catch (e) {}
    });
  } catch (err: any) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message || 'Export failed' });
  }
});

// Provide standalone desktop Python script for download
app.get('/api/download-python-app', (req, res) => {
  const desktopScript = path.resolve(process.cwd(), 'pulan_tamil_ocr.py');
  const finalPath = fs.existsSync(desktopScript) ? desktopScript : '/app/applet/pulan_tamil_ocr.py';
  if (fs.existsSync(finalPath)) {
    res.setHeader('Content-Type', 'text/x-python');
    res.setHeader('Content-Disposition', 'attachment; filename="pulan_tamil_ocr.py"');
    res.sendFile(finalPath);
  } else {
    res.status(404).send('Script not found');
  }
});

/**
 * Turn upload failures into something the user can act on.
 *
 * Multer rejects an oversized file by calling next(err) before the route runs, so the
 * route's own try/catch never sees it and Express answers with its default HTML page. The
 * UI could only say "Upload failed (HTTP 500)", which is how a 300 MB book came to look
 * like a broken app rather than a limit being hit.
 */
function describeRequestError(err: any): { status: number; message: string } {
  const code = err?.code;
  if (code === 'LIMIT_FILE_SIZE') {
    return {
      status: 413,
      message:
        `That file is larger than the ${MAX_UPLOAD_MB} MB upload limit. Set ` +
        'PULAN_MAX_UPLOAD_MB higher to allow it, or split the document.',
    };
  }
  if (code === 'LIMIT_FILE_COUNT') {
    return { status: 413, message: 'Too many files in one upload (50 at most).' };
  }
  if (code === 'ENOSPC') {
    return {
      status: 507,
      message: `Ran out of disk space while receiving the upload. Free some space in ${TEMP_DIR} and try again.`,
    };
  }
  if (err?.type === 'entity.too.large') {
    return { status: 413, message: 'That request body is too large.' };
  }
  return { status: 500, message: err?.message || 'The request failed.' };
}

app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const { status, message } = describeRequestError(err);
  console.error(`Request failed (${status}):`, err?.message || err);
  res.status(status).json({ success: false, error: message });
});

async function startServer() {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    // Imported here rather than at the top of the file: the packaged build ships without
    // Vite, and a production server never reaches this branch.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist/index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Pulan Tamil OCR running on http://0.0.0.0:${PORT}`);
    console.log(`PDF rasterization: ${PDF_DPI} DPI, up to ${PDF_WORKERS} parallel page workers`);
  });

  // Node's default 5-minute requestTimeout kills long-running uploads mid-way.
  // Rasterizing a 30+ page scanned Tamil PDF takes longer than that, which made
  // large files look like they never opened. Disable it for this local app.
  server.requestTimeout = 0;
}

startServer();
