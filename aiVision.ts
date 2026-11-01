/**
 * AI vision providers for Pulan Ezhuthunari.
 *
 * Three ways to run layout detection and OCR with a large vision model:
 *
 *  - `claude`            Anthropic Claude: the Messages API with an API key, or the
 *                        Claude subscription through `agentClient` (the Claude Agent
 *                        SDK sidecar driving the signed-in Claude Code CLI)
 *  - `chatgpt`           OpenAI GPT vision (API key, or the local `codex` CLI for a
 *                        ChatGPT subscription)
 *  - `openai-compatible` any endpoint that speaks the OpenAI chat-completions API
 *                        with image parts: Ollama, LM Studio, vLLM, OpenRouter,
 *                        Groq, Together, DeepSeek, Azure-style gateways, ...
 *
 * Both actions return the shapes the rest of the app already uses, so the viewer,
 * the zone overlays, the diagnostics and the exporters need no special casing:
 *
 *   detectLayout()   -> { zones: LayoutZone[], width, height, provider, model }
 *   recognizeText()  -> { text, provider, model }
 *
 * Keys are never logged. A key supplied with the request wins over the server
 * environment, so the UI can keep it in the browser only. The subscription path
 * carries no key at all.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { agentClient, AgentError, AgentStatus, SignInReport } from './agentClient';

export type AiEngineId = 'gemini' | 'claude' | 'chatgpt' | 'openai-compatible';

export type AiProviderKind =
  | 'anthropic'
  | 'openai'
  | 'openai-compatible'
  | 'claude-agent'
  | 'codex-cli'
  | 'antigravity-cli';

/** Where the page came from, so the agent tools can describe and crop it. */
export interface AiAgentContext {
  documentId?: string;
  documentName?: string;
  pageId?: string;
  pageNumber?: number;
  zones?: Array<Record<string, unknown>>;
  selection?: Record<string, unknown> | null;
  /**
   * Long edge the page image is scaled to before the model sees it. The caller sets
   * it, because a scaled image means the coordinates that come back have to be mapped
   * back to page pixels.
   */
  maxEdge?: number;
}

export interface AiVisionSettings {
  /** Prefer the Claude subscription (Agent SDK) or the `codex` CLI over an API key. */
  useSubscription?: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Path to the `claude` executable, when it is not the one bundled with the SDK. */
  cliPath?: string;
  /** Maximum turns for the subscription backend, matching the app's iteration limit. */
  maxTurns?: number;
  /** The page this call is about, so the agent's tools can fetch and crop it. */
  agentContext?: AiAgentContext;
}

export interface AiVisionImage {
  base64: string;
  mediaType: string;
  width: number;
  height: number;
  filePath?: string;
}

export interface AiZone {
  id: string;
  order: number;
  col: number;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface LayoutDetectionResult {
  zones: AiZone[];
  width: number;
  height: number;
  engine: AiEngineId;
  provider: AiProviderKind;
  model: string;
  warnings: string[];
}

export interface TextRecognitionResult {
  text: string;
  engine: AiEngineId;
  provider: AiProviderKind;
  model: string;
  warnings: string[];
}

export class AiVisionError extends Error {
  constructor(message: string, readonly provider?: string) {
    super(message);
    this.name = 'AiVisionError';
  }
}

export const AI_ENGINES: AiEngineId[] = ['gemini', 'claude', 'chatgpt', 'openai-compatible'];

export function isAiEngine(engine: string | undefined): engine is AiEngineId {
  return !!engine && (AI_ENGINES as string[]).includes(engine);
}

const DEFAULT_TIMEOUT_MS = Number(process.env.PULAN_AI_TIMEOUT_MS) || 180000;
const DEFAULT_MAX_TOKENS = Number(process.env.PULAN_AI_MAX_TOKENS) || 8000;

/**
 * Long edge a page is scaled to before the subscription backend sends it to the model.
 *
 * A page rendered at 200 DPI is several megabytes of PNG, which base64-inflates past
 * the Agent SDK's message limit and is mostly discarded by the model anyway. The
 * caller decides this, because the coordinates that come back are in the scaled space
 * and have to be mapped back to page pixels. Keep in step with
 * `backend/agent/ocr_tools.DEFAULT_MAX_IMAGE_EDGE`.
 */
const MAX_IMAGE_EDGE = Math.max(512, Number(process.env.PULAN_AGENT_MAX_IMAGE_EDGE) || 1600);

const ZONE_TYPES = ['headline', 'column', 'body', 'table', 'caption'];


// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

export interface ResolvedProvider {
  kind: AiProviderKind;
  engine: AiEngineId;
  label: string;
  endpoint: string;
  apiKey: string;
  keySource: 'request' | 'env' | 'none';
  model: string;
  maxTokens: number;
  timeoutMs: number;
  /** Subscription backend only: the `claude` executable, when one is configured. */
  cliPath: string;
  /** Subscription backend only: maximum turns per answer. */
  maxTurns: number;
  /** True when the model was named in the panel, rather than defaulted. */
  explicitModel: boolean;
}

function envFirst(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return '';
}

function defaultModelFor(engine: AiEngineId): string {
  if (engine === 'claude') return envFirst('ANTHROPIC_MODEL', 'PULAN_ANTHROPIC_MODEL') || 'claude-sonnet-4-5';
  if (engine === 'chatgpt') return envFirst('OPENAI_MODEL', 'PULAN_OPENAI_MODEL') || 'gpt-4o';
  // The Google subscription runs on whichever model the Antigravity CLI is set to, so
  // this is the name the panel suggests and the one reported when the panel names
  // nothing. Keep it in step with the `--effort low` the subscription call passes.
  if (engine === 'gemini') return envFirst('GEMINI_MODEL', 'PULAN_GEMINI_MODEL') || 'gemini-3.8-flash-low';
  return envFirst('PULAN_AI_MODEL', 'OPENAI_COMPATIBLE_MODEL') || '';
}

function defaultBaseUrlFor(engine: AiEngineId, kind: AiProviderKind): string {
  if (kind === 'anthropic') return envFirst('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com';
  if (kind === 'openai') return envFirst('OPENAI_BASE_URL') || 'https://api.openai.com/v1';
  return envFirst('PULAN_AI_BASE_URL', 'OPENAI_COMPATIBLE_BASE_URL') || '';
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Turn an engine id plus UI settings into a concrete provider call.
 * Throws AiVisionError with an actionable message when something is missing.
 */
export function resolveProvider(engine: AiEngineId, settings: AiVisionSettings = {}): ResolvedProvider {
  const timeoutMs = Math.max(5000, Number(settings.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const maxTokens = Math.max(256, Number(settings.maxTokens) || DEFAULT_MAX_TOKENS);
  const maxTurns = Math.max(1, Number(settings.maxTurns) || 4);
  const cliPath = (settings.cliPath || '').trim() || envFirst('CLAUDE_CLI_BIN');
  // A model named in the panel wins; otherwise the subscription backend lets Claude
  // Code use the model that account is configured for, rather than forcing one.
  const explicitModel = !!(settings.model || '').trim();
  const keyFromRequest = (settings.apiKey || '').trim();

  // The Gemini engine keeps its API-key path (which runs through @google/genai in
  // server.ts). This branch exists for the subscription, where the page travels through
  // the Antigravity CLI instead of an API key.
  if (engine === 'gemini') {
    if (!settings.useSubscription) {
      throw new AiVisionError(
        'The Gemini engine is set to use its API key, which this path does not serve. Switch on ' +
          '"Use Google subscription" to run through the Antigravity CLI, or leave the API key path alone.',
        'Gemini subscription (Antigravity CLI)'
      );
    }
    return {
      kind: 'antigravity-cli',
      engine,
      label: 'Gemini subscription (Antigravity CLI)',
      endpoint: '',
      apiKey: '',
      keySource: 'none',
      model: (settings.model || '').trim() || defaultModelFor(engine),
      maxTokens,
      timeoutMs,
      cliPath,
      maxTurns,
      explicitModel,
    };
  }

  if (engine === 'claude' || engine === 'chatgpt') {
    const isClaude = engine === 'claude';
    const kind: AiProviderKind = settings.useSubscription
      ? isClaude
        ? 'claude-agent'
        : 'codex-cli'
      : isClaude
      ? 'anthropic'
      : 'openai';
    const keyFromEnv = isClaude ? envFirst('ANTHROPIC_API_KEY') : envFirst('OPENAI_API_KEY');
    const labels: Record<AiProviderKind, string> = {
      anthropic: 'Anthropic Claude',
      openai: 'OpenAI GPT',
      'claude-agent': 'Claude subscription (Claude Code)',
      'codex-cli': 'ChatGPT subscription (codex CLI)',
      'antigravity-cli': 'Gemini subscription (Antigravity CLI)',
      'openai-compatible': 'OpenAI-compatible endpoint',
    };
    return {
      kind,
      engine,
      label: labels[kind],
      // A base URL override is honoured so a proxy/gateway or a local mock can be used
      endpoint: (settings.baseUrl || '').trim() || defaultBaseUrlFor(engine, kind),
      apiKey: keyFromRequest || keyFromEnv,
      keySource: keyFromRequest ? 'request' : keyFromEnv ? 'env' : 'none',
      model: (settings.model || '').trim() || defaultModelFor(engine),
      maxTokens,
      timeoutMs,
      cliPath,
      maxTurns,
      explicitModel,
    };
  }

  // Any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, OpenRouter, ...)
  const keyFromEnv = envFirst('PULAN_AI_API_KEY', 'OPENAI_COMPATIBLE_API_KEY');
  const baseUrl = (settings.baseUrl || '').trim() || defaultBaseUrlFor(engine, 'openai-compatible');
  const model = (settings.model || '').trim() || defaultModelFor(engine);
  if (!baseUrl) {
    throw new AiVisionError(
      'No endpoint configured. Set the base URL (for example http://localhost:11434/v1 for Ollama, ' +
        'http://localhost:1234/v1 for LM Studio, https://openrouter.ai/api/v1) or set PULAN_AI_BASE_URL.',
      'openai-compatible'
    );
  }
  if (!model) {
    throw new AiVisionError(
      'No model configured. Enter the model name served by that endpoint (for example qwen2.5vl:7b or ' +
        'llama3.2-vision) or set PULAN_AI_MODEL.',
      'openai-compatible'
    );
  }
  return {
    kind: 'openai-compatible',
    engine,
    label: 'OpenAI-compatible endpoint',
    endpoint: baseUrl,
    apiKey: keyFromRequest || keyFromEnv,
    keySource: keyFromRequest ? 'request' : keyFromEnv ? 'env' : 'none',
    model,
    maxTokens,
    timeoutMs,
    cliPath: '',
    maxTurns,
    explicitModel,
  };
}

/** Anthropic and OpenAI need a key; compatible endpoints and CLIs may not. */
function requireKey(provider: ResolvedProvider): void {
  if (provider.kind === 'anthropic' && !provider.apiKey) {
    throw new AiVisionError(
      'No Anthropic API key. Paste one in the engine options, set ANTHROPIC_API_KEY, or switch on ' +
        '"Use Claude subscription" to run through Claude Code instead (no key needed).',
      provider.label
    );
  }
  if (provider.kind === 'openai' && !provider.apiKey) {
    throw new AiVisionError(
      'No OpenAI API key. Paste one in the engine options, set OPENAI_API_KEY, or switch on ' +
        '"Use ChatGPT subscription" to run through the local codex CLI.',
      provider.label
    );
  }
}


// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const MODE_HINTS: Record<string, string> = {
  auto: 'Detect the columns yourself from the page content.',
  '2col': 'The page is laid out in two columns per page.',
  '3col': 'The page is laid out in three columns per page.',
  single: 'Treat the page as a single text block.',
};

function layoutPrompt(width: number, height: number, mode: string): string {
  return [
    'You are a document layout analyser for scanned Tamil journal pages (Siddha and Siddhantist literature).',
    'Identify every region that must be read separately, and their reading order.',
    `The image is ${width} x ${height} pixels. ${MODE_HINTS[mode] || MODE_HINTS.auto}`,
    '',
    'Rules:',
    '- One zone per column of text, per headline, per table and per caption. Never merge two columns into one zone.',
    '- Use pixel coordinates of this image: x and y are the top-left corner, width and height the size.',
    '- A zone must not cut through a column: its edges must sit in the blank gutter between columns.',
    '- "order" is the reading position starting at 1: columns left to right, top to bottom inside a column.',
    '- "col" is the column number the zone belongs to, starting at 1.',
    `- "type" is one of: ${ZONE_TYPES.join(', ')}.`,
    '- "confidence" is your own certainty from 0 to 100.',
    '',
    'Answer with JSON only, no prose and no code fences, exactly this shape:',
    '{"zones":[{"type":"column","order":1,"col":1,"x":120,"y":150,"width":420,"height":1400,"confidence":95}]}',
  ].join('\n');
}

function ocrPrompt(
  zone: { x: number; y: number; width: number; height: number } | null,
  language: string
): string {
  const lines = [
    'Transcribe every character of the printed text in this scan exactly as it appears.',
    'The text is mainly Tamil, sometimes mixed with English.',
    '',
    'Rules:',
    '- Output the transcription only: no commentary, no translation, no code fences.',
    '- Keep the original line breaks, one output line per printed line.',
    '- Keep Tamil vowel signs, pulli, ligatures and the original spelling, including historical forms.',
    '- Do not modernise, correct, translate or complete any word. Transcribe your best reading of unclear characters.',
    '- Never merge or reorder text from different columns; keep the reading order top to bottom.',
  ];
  if (language && language !== 'tam+eng') {
    lines.push(`- Expected languages: ${language}.`);
  }
  if (zone) {
    lines.push(
      '',
      `Transcribe only the region x=${zone.x} y=${zone.y} width=${zone.width} height=${zone.height} of this image ` +
        '(the rest of the page is context only).'
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Pull the first JSON object or array out of a model answer (fences included). */
export function extractJson(text: string): unknown {
  if (!text) throw new AiVisionError('The model returned an empty answer.');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // fall through to brace scanning
  }
  const start = candidate.search(/[[{]/);
  if (start === -1) {
    throw new AiVisionError(`No JSON found in the model answer: ${candidate.slice(0, 200)}`);
  }
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch (err: any) {
          throw new AiVisionError(`The model returned malformed JSON: ${err.message}`);
        }
      }
    }
  }
  throw new AiVisionError('The model returned an incomplete JSON object.');
}


function numberFrom(source: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

/**
 * Accept the box shapes models actually return and convert them to pixels:
 * {x,y,width,height} | {x0,y0,x1,y1} | {left,top,right,bottom} | {bbox:[x,y,w,h]}
 */
function readBox(raw: Record<string, unknown>): { x: number; y: number; width: number; height: number } | null {
  const bbox = raw.bbox ?? raw.box ?? raw.rect;
  if (Array.isArray(bbox) && bbox.length >= 4) {
    const [x, y, width, height] = bbox.map((value) => Number(value));
    if ([x, y, width, height].every((value) => Number.isFinite(value))) {
      return { x, y, width, height };
    }
  }
  const x = numberFrom(raw, 'x', 'left', 'x0', 'xmin');
  const y = numberFrom(raw, 'y', 'top', 'y0', 'ymin');
  if (x === undefined || y === undefined) return null;
  const width = numberFrom(raw, 'width', 'w', 'x1', 'xmax', 'right');
  const height = numberFrom(raw, 'height', 'h', 'y1', 'ymax', 'bottom');
  if (width === undefined || height === undefined) return null;
  // x1/right style edges: the second value is the far edge, not the size
  const edgeStyle =
    raw.width === undefined &&
    raw.height === undefined &&
    (raw.x1 !== undefined || raw.right !== undefined || raw.xmax !== undefined);
  return edgeStyle ? { x, y, width: width - x, height: height - y } : { x, y, width, height };
}

interface RawZone {
  x: number;
  y: number;
  width: number;
  height: number;
  type: string;
  confidence: number;
  order?: number;
  col?: number;
}

/**
 * Reading order for a page: columns left to right, lines top to bottom inside a
 * column. When the model numbered the zones itself, those numbers are kept.
 */
export function inferReadingOrder(zones: RawZone[]): AiZone[] {
  let ordered: RawZone[];
  const explicit = zones.filter((zone) => typeof zone.order === 'number');
  if (explicit.length === zones.length) {
    ordered = [...zones].sort((a, b) => (a.order as number) - (b.order as number));
  } else if (zones.every((zone) => typeof zone.col === 'number')) {
    ordered = [...zones].sort((a, b) => (a.col as number) - (b.col as number) || a.y - b.y || a.x - b.x);
  } else {
    // Group overlapping x-ranges into columns, then read columns left to right.
    const sorted = [...zones].sort((a, b) => a.x - b.x || a.y - b.y);
    const columns: Array<{ left: number; right: number; items: RawZone[] }> = [];
    for (const zone of sorted) {
      const column = columns.find(
        (candidate) => zone.x < candidate.right - Math.min(zone.width, candidate.right - candidate.left) * 0.5
      );
      if (column) {
        column.items.push(zone);
        column.left = Math.min(column.left, zone.x);
        column.right = Math.max(column.right, zone.x + zone.width);
      } else {
        columns.push({ left: zone.x, right: zone.x + zone.width, items: [zone] });
      }
    }
    ordered = columns.flatMap((column) => [...column.items].sort((a, b) => a.y - b.y || a.x - b.x));
  }

  return ordered.map((zone, index) => ({
    id: `ai-zone-${index + 1}`,
    order: index + 1,
    col: zone.col && zone.col > 0 ? zone.col : 1,
    type: zone.type,
    x: zone.x,
    y: zone.y,
    width: zone.width,
    height: zone.height,
    confidence: Math.round(Math.max(0, Math.min(100, zone.confidence))),
  }));
}


export function normalizeZones(
  payload: unknown,
  image: { width: number; height: number },
  coordinateScale = 1
): { zones: AiZone[]; warnings: string[] } {
  const warnings: string[] = [];
  const container = payload as Record<string, unknown> | unknown[];
  const nested = (key: string): unknown[] =>
    Array.isArray((container as Record<string, unknown>)?.[key])
      ? ((container as Record<string, unknown>)[key] as unknown[])
      : [];
  const list: unknown[] = Array.isArray(container)
    ? container
    : nested('zones').length
    ? nested('zones')
    : nested('regions');
  if (!list.length) {
    throw new AiVisionError('The model returned no zones. Check the model and try again.');
  }

  const boxes: RawZone[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const box = readBox(raw);
    if (!box) continue;
    const type =
      typeof raw.type === 'string' && ZONE_TYPES.includes(raw.type.toLowerCase())
        ? raw.type.toLowerCase()
        : 'column';
    boxes.push({
      ...box,
      type,
      confidence: numberFrom(raw, 'confidence', 'score', 'certainty') ?? 90,
      order: numberFrom(raw, 'order', 'readingOrder'),
      col: numberFrom(raw, 'col', 'column'),
    });
  }
  if (!boxes.length) {
    throw new AiVisionError('The model returned zones without usable coordinates.');
  }

  // Fractional coordinates are common; detect them once for the whole answer.
  const maxValue = Math.max(...boxes.flatMap((box) => [box.x, box.y, box.x + box.width, box.y + box.height]));
  const fractional = maxValue <= 1.5;
  if (fractional) warnings.push('Zone coordinates were returned as fractions and were scaled to pixels.');

  // The model answers in the pixels of the image it was shown, which may be a scaled
  // copy of the page; coordinateScale maps that back to page pixels.
  const scaled = boxes.map((box) => {
    const x = (fractional ? box.x * image.width : box.x) * coordinateScale;
    const y = (fractional ? box.y * image.height : box.y) * coordinateScale;
    const width = (fractional ? box.width * image.width : box.width) * coordinateScale;
    const height = (fractional ? box.height * image.height : box.height) * coordinateScale;
    return { ...box, x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  });

  const usable = scaled.filter((zone) => zone.width >= 8 && zone.height >= 8);
  if (!usable.length) throw new AiVisionError('Every returned zone was too small to read.');
  if (usable.length < scaled.length) {
    warnings.push(`${scaled.length - usable.length} degenerate zone(s) were discarded.`);
  }

  const clamped = usable.map((zone) => {
    const x = Math.max(0, Math.min(zone.x, Math.max(0, image.width - 1)));
    const y = Math.max(0, Math.min(zone.y, Math.max(0, image.height - 1)));
    return {
      ...zone,
      x,
      y,
      width: Math.max(8, Math.min(zone.width, image.width - x)),
      height: Math.max(8, Math.min(zone.height, image.height - y)),
    };
  });

  return { zones: inferReadingOrder(clamped), warnings };
}


// ---------------------------------------------------------------------------
// Transport: HTTP providers
// ---------------------------------------------------------------------------

function errorSnippet(body: string): string {
  const text = (body || '').replace(/\s+/g, ' ').trim();
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  label: string
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AiVisionError(`${label} request failed (HTTP ${response.status}): ${errorSnippet(text)}`, label);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new AiVisionError(`${label} returned a non-JSON response: ${errorSnippet(text)}`, label);
    }
  } catch (err: any) {
    if (err instanceof AiVisionError) throw err;
    if (err?.name === 'AbortError') {
      throw new AiVisionError(
        `${label} did not answer within ${Math.round(timeoutMs / 1000)}s. Raise the timeout or use a smaller image.`,
        label
      );
    }
    throw new AiVisionError(`${label} could not be reached: ${err.message}`, label);
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(provider: ResolvedProvider, prompt: string, image: AiVisionImage): Promise<string> {
  requireKey(provider);
  const payload = await postJson(
    `${normalizeBaseUrl(provider.endpoint)}/v1/messages`,
    { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' },
    {
      model: provider.model,
      max_tokens: provider.maxTokens,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    },
    provider.timeoutMs,
    provider.label
  );
  const blocks: any[] = Array.isArray(payload?.content) ? payload.content : [];
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (!text) {
    throw new AiVisionError(
      `${provider.label} returned no text: ${errorSnippet(JSON.stringify(payload))}`,
      provider.label
    );
  }
  return text;
}

async function callOpenAiCompatible(
  provider: ResolvedProvider,
  prompt: string,
  image: AiVisionImage
): Promise<string> {
  const headers: Record<string, string> = {};
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  const url = `${normalizeBaseUrl(provider.endpoint)}/chat/completions`;
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } },
      ],
    },
  ];

  let payload: any;
  try {
    payload = await postJson(
      url,
      headers,
      { model: provider.model, max_tokens: provider.maxTokens, messages },
      provider.timeoutMs,
      provider.label
    );
  } catch (err: any) {
    // Newer OpenAI models renamed the output limit; some gateways accept only the new name.
    if (err instanceof AiVisionError && /max_tokens/i.test(err.message)) {
      payload = await postJson(
        url,
        headers,
        { model: provider.model, max_completion_tokens: provider.maxTokens, messages },
        provider.timeoutMs,
        provider.label
      );
    } else {
      throw err;
    }
  }

  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const content = choice?.message?.content;
  const text =
    typeof content === 'string'
      ? content.trim()
      : Array.isArray(content)
      ? content
          .filter((part: any) => typeof part?.text === 'string')
          .map((part: any) => part.text)
          .join('\n')
          .trim()
      : '';
  if (!text) {
    throw new AiVisionError(
      `${provider.label} returned no text: ${errorSnippet(JSON.stringify(payload))}`,
      provider.label
    );
  }
  return text;
}


// ---------------------------------------------------------------------------
// Transport: local subscription CLIs
// ---------------------------------------------------------------------------

/**
 * The subscription CLIs that are driven directly. Claude is not one of them: it goes
 * through the Agent SDK sidecar (`agentClient`), which keeps one persistent,
 * locked-down session instead of a one-shot `claude -p` call.
 */
const CLI_CANDIDATES: Record<'codex-cli' | 'antigravity-cli', { bin: string; install: string }> = {
  'codex-cli': {
    bin: process.env.CODEX_CLI_BIN || 'codex',
    install: 'Install the OpenAI Codex CLI (npm install -g @openai/codex) and sign in with "codex login".',
  },
  'antigravity-cli': {
    bin: process.env.AGY_CLI_BIN || 'agy',
    install:
      'Install the Antigravity CLI (irm https://antigravity.google/cli/install.ps1 | iex) and sign in ' +
      'with your Google account. The Gemini CLI cannot be used for this: Google has retired its ' +
      'individual subscription login.',
  },
};

/**
 * The Antigravity CLI installs itself outside PATH (on Windows,
 * `%LOCALAPPDATA%\agy\bin\agy.exe`), so a PATH lookup alone would report it missing.
 */
function antigravityOnDisk(): string | null {
  const configured = (process.env.AGY_CLI_BIN || '').trim();
  const candidates: string[] = configured ? [configured] : [];
  const local = (process.env.LOCALAPPDATA || '').trim();
  const exe = process.platform === 'win32' ? 'agy.exe' : 'agy';
  if (local) candidates.push(path.join(local, 'agy', 'bin', exe));
  candidates.push(path.join(os.homedir(), '.local', 'bin', 'agy'));
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable path: try the next one */
    }
  }
  return null;
}

/** The executable for a CLI, preferring the file its own installer created. */
function cliBin(kind: 'codex-cli' | 'antigravity-cli'): string {
  if (kind === 'antigravity-cli') return antigravityOnDisk() || CLI_CANDIDATES[kind].bin;
  return CLI_CANDIDATES[kind].bin;
}

const cliCache = new Map<string, { available: boolean; version: string | null; checked: number }>();

/**
 * Quote one argument for the platform shell.
 *
 * Node's shell mode concatenates arguments without escaping, so an argument that
 * contains spaces (every prompt, and any temp path with a space) would be split
 * into several arguments. Quoting each argument keeps the CLI receiving exactly
 * what we intended.
 */
function quoteForShell(value: string): string {
  if (process.platform !== 'win32') {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }
  // cmd.exe: wrap in double quotes, double any embedded quote
  return `"${value.replace(/"/g, '""')}"`;
}

function runCli(
  bin: string,
  args: string[],
  timeoutMs: number,
  cwd?: string
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const commandLine = [bin, ...args].map(quoteForShell).join(' ');
      child = spawn(commandLine, [], { windowsHide: true, shell: true, cwd });
      // Codex reads "additional input from stdin" and waits for EOF before answering, so
      // stdin is closed at once rather than left open.
      child.stdin?.end();
    } catch (err: any) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      reject(new AiVisionError(`${bin} did not answer within ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err: any) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/** Is the CLI installed and reachable? Cached for a minute to keep the UI snappy. */
export async function cliStatus(
  kind: 'codex-cli' | 'antigravity-cli'
): Promise<{ available: boolean; bin: string; version: string | null }> {
  const bin = cliBin(kind);
  const cached = cliCache.get(bin);
  if (cached && Date.now() - cached.checked < 60000) {
    return { available: cached.available, bin, version: cached.version };
  }
  try {
    const result = await runCli(bin, ['--version'], 15000);
    const output = `${result.stdout} ${result.stderr}`.trim();
    const version = output.split('\n')[0] || null;
    // A missing binary makes the shell answer with "not recognized" and exit 1;
    // that must not be reported as an installed CLI.
    const missing = /not recognized|not found|no such file|command not found|is not recognized/i.test(output);
    const available = result.code === 0 && !missing && !!version;
    cliCache.set(bin, { available, version: available ? version : null, checked: Date.now() });
    return { available, bin, version: available ? version : null };
  } catch {
    cliCache.set(bin, { available: false, version: null, checked: Date.now() });
    return { available: false, bin, version: null };
  }
}

function writeTempImage(image: AiVisionImage): string {
  if (image.filePath && fs.existsSync(image.filePath)) return image.filePath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulan_ai_'));
  const file = path.join(dir, image.mediaType === 'image/jpeg' ? 'page.jpg' : 'page.png');
  fs.writeFileSync(file, Buffer.from(image.base64, 'base64'));
  return file;
}

/**
 * CLIs are given a short, single-line instruction that points at two files: the
 * full prompt and the page image. Passing a long multi-line prompt as an argument
 * is unreliable on Windows (arguments are concatenated into the shell command),
 * so the prompt travels as a file the CLI reads with its own tools.
 */
function writeTempInstructions(
  prompt: string,
  image: AiVisionImage
): { dir: string; imagePath: string; promptPath: string; instruction: string } {
  const imagePath = writeTempImage(image);
  const dir = path.dirname(imagePath);
  const promptPath = path.join(dir, 'instructions.txt');
  fs.writeFileSync(promptPath, prompt, 'utf8');
  // Brackets delimit the paths: they survive a shell command line unchanged,
  // unlike quotes or angle brackets.
  const instruction =
    `Read the instruction file [${promptPath}] and follow it exactly. ` +
    `The scanned page image is [${imagePath}]. ` +
    'Answer with the requested output only, no commentary.';
  return { dir, imagePath, promptPath, instruction: instruction.replace(/"/g, '') };
}



/** CLI output may be plain text, a JSON envelope or JSONL events; take the text. */
function unwrapCliOutput(raw: string, provider: ResolvedProvider): string {
  const text = (raw || '').trim();
  if (!text || !/^[[{]/.test(text)) return text;

  const candidates: string[] = [];
  let sawError = false;
  const collect = (value: any, depth = 0): void => {
    if (value === null || value === undefined || depth > 4) return;
    if (typeof value === 'string') {
      candidates.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collect(item, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    if (value.is_error === true || value.error) sawError = true;
    for (const key of ['result', 'text', 'output', 'content', 'message', 'response']) {
      if (value[key] !== undefined) collect(value[key], depth + 1);
    }
  };

  try {
    collect(JSON.parse(text));
  } catch {
    // JSONL: one JSON object per line
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        collect(JSON.parse(trimmed));
      } catch {
        /* not a JSON line */
      }
    }
  }

  const best = candidates.map((value) => value.trim()).filter(Boolean).sort((a, b) => b.length - a.length)[0];
  if (!best) {
    if (sawError) {
      throw new AiVisionError(`The CLI reported an error: ${errorSnippet(text)}`, provider.label);
    }
    return text;
  }
  return best;
}

/**
 * The Claude subscription path: the Agent SDK sidecar runs a locked-down session
 * whose only tools are this app's own OCR tools. The page reaches the model through
 * `get_page_image`, because an Agent SDK prompt carries text only, so the page has
 * to exist as a file on disk.
 */
async function callClaudeAgent(
  provider: ResolvedProvider,
  prompt: string,
  image: AiVisionImage,
  action: 'layout' | 'ocr',
  context?: AiAgentContext,
  onModel?: (model: string) => void
): Promise<string> {
  if (!image.filePath) {
    throw new AiVisionError(
      'The Claude subscription backend reads the page through a tool, so the page image has to be ' +
        'a file on disk. This request carried no file path — save the page, or use the API key.',
      provider.label
    );
  }
  try {
    const answer = await agentClient.vision({
      action,
      prompt,
      imagePath: image.filePath,
      width: image.width,
      height: image.height,
      pageId: context?.pageId,
      pageNumber: context?.pageNumber,
      documentId: context?.documentId,
      documentName: context?.documentName,
      zones: context?.zones,
      selection: context?.selection ?? null,
      // Only force a model when the panel named one; otherwise the subscription's own
      // configured model is used.
      model: provider.explicitModel ? provider.model : undefined,
      maxTurns: provider.maxTurns,
      timeoutMs: provider.timeoutMs,
    });
    // Report the model Claude Code actually used, not the one we would have asked for.
    if (answer.model) onModel?.(answer.model);
    return answer.text;
  } catch (err: any) {
    if (err instanceof AgentError) throw new AiVisionError(err.message, provider.label);
    throw new AiVisionError(`${provider.label} failed: ${err?.message || err}`, provider.label);
  }
}

/** Read a file the CLI wrote, then remove it. Null when there is nothing there. */
function takeAnswerFile(file: string): string | null {
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    text = null;
  }
  try {
    fs.unlinkSync(file);
  } catch {
    /* nothing to remove */
  }
  return text;
}

/** The model Codex says it used, from the banner it prints before the answer. */
function codexModel(stdout: string, stderr = ''): string | null {
  // The banner can land on either stream, so both are searched.
  const match = `${stdout}\n${stderr}`.match(/^model:\s*(\S+)/m);
  return match ? match[1] : null;
}

/**
 * The ChatGPT subscription, through the Codex CLI's non-interactive mode.
 *
 * Three flags are not optional in practice:
 *
 *  - `--skip-git-repo-check`: Codex refuses to run outside a trusted directory, and this
 *    app is not a git repository, so without it the call stops immediately.
 *  - `-s read-only`: an agent that only has to read one image must not be able to change
 *    anything.
 *  - `-C <temp>`: it works in a throwaway folder rather than in the project.
 *
 * `-o` writes the final message to a file, which is far more reliable than picking the
 * answer out of the CLI's progress output.
 */
async function callCodexCli(
  provider: ResolvedProvider,
  prompt: string,
  image: AiVisionImage,
  onModel?: (model: string) => void
): Promise<string> {
  const { bin, install } = CLI_CANDIDATES['codex-cli'];
  const status = await cliStatus('codex-cli');
  if (!status.available) {
    throw new AiVisionError(`The "${bin}" CLI was not found on PATH. ${install}`, provider.label);
  }
  const { instruction, imagePath } = writeTempInstructions(prompt, image);
  const answerPath = path.join(
    os.tmpdir(),
    `pulan_codex_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`
  );
  const base = [
    'exec',
    '--skip-git-repo-check',
    '--color',
    'never',
    '-s',
    'read-only',
    '-C',
    os.tmpdir(),
  ];
  const attempts: string[][] = [
    [...base, '--image', imagePath, '-o', answerPath, instruction],
    [...base, '-i', imagePath, '-o', answerPath, instruction],
    [...base, '-o', answerPath, instruction],
  ];
  let lastError = '';
  for (const args of attempts) {
    const result = await runCli(bin, args, provider.timeoutMs);
    // Report the model Codex says it used, not the one this app would have asked for.
    const reported = codexModel(result.stdout, result.stderr);
    const fromFile = takeAnswerFile(answerPath);
    if (fromFile) {
      if (reported) onModel?.(reported);
      return fromFile;
    }
    const stdout = result.stdout.trim();
    if (result.code === 0 && stdout) {
      const text = unwrapCliOutput(stdout, provider);
      if (text) {
        if (reported) onModel?.(reported);
        return text;
      }
    }
    lastError = result.stderr || stdout || `exit ${result.code}`;
    // Only retry when the flag itself was rejected; a real answer error is final.
    if (!/unknown|unexpected|invalid|unrecognized|not supported/i.test(lastError)) break;
  }
  throw new AiVisionError(`codex CLI failed: ${errorSnippet(lastError)}. ${install}`, provider.label);
}

/** The JSON envelope `agy --output-format json` prints on stdout. */
interface AntigravityEnvelope {
  status?: string;
  response?: string;
  error?: string;
}

/**
 * Read the envelope out of a run's output.
 *
 * The CLI prints the envelope as the last JSON object, and progress or permission
 * notices can share stdout, so lines are scanned from the end rather than trusting the
 * whole stream to be JSON.
 */
function antigravityEnvelope(stdout: string, stderr = ''): AntigravityEnvelope | null {
  const text = (stdout || '').trim();
  if (!text) return null;
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean).reverse();
  for (const candidate of [...lines, text]) {
    const start = candidate.indexOf('{');
    if (start < 0) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start));
      if (parsed && typeof parsed === 'object' && 'status' in parsed) {
        return parsed as AntigravityEnvelope;
      }
    } catch {
      /* not the envelope */
    }
  }
  void stderr;
  return null;
}

/**
 * The model this call used.
 *
 * The CLI's JSON envelope reports tokens, not the model, so the honest answer is what
 * the app asked for: the panel's choice when it named one, and otherwise the default
 * the call runs — Gemini 3.8 Flash at the low reasoning effort it passes.
 */
function antigravityModel(provider: ResolvedProvider): string {
  return provider.explicitModel ? provider.model : defaultModelFor(provider.engine);
}

/**
 * The page and the prompt, together, in a throwaway folder of their own.
 *
 * `writeTempInstructions` puts the instruction file beside the image, which for a page
 * saved inside the project hands the agent the whole project as its workspace: it then
 * spends its time exploring that instead of reading one page, and a run that should
 * take half a minute runs past every timeout. The Antigravity CLI runs with this folder
 * as its workspace, so the page is copied into it and nothing else is there.
 */
function writeAgentWorkspace(
  prompt: string,
  image: AiVisionImage
): { dir: string; instruction: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulan_agy_'));
  const imagePath = path.join(dir, image.mediaType === 'image/jpeg' ? 'page.jpg' : 'page.png');
  if (image.filePath && fs.existsSync(image.filePath)) {
    fs.copyFileSync(image.filePath, imagePath);
  } else {
    fs.writeFileSync(imagePath, Buffer.from(image.base64, 'base64'));
  }
  const promptPath = path.join(dir, 'instructions.txt');
  fs.writeFileSync(promptPath, prompt, 'utf8');
  // Brackets delimit the paths: they survive a shell command line unchanged, unlike
  // quotes or angle brackets.
  //
  // The ban on exploring is not politeness. This is a coding agent, and left to itself
  // it reads the workspace, runs commands and spawns background tasks — one measured
  // run spent 203k tokens and five minutes doing that before it looked at the page.
  // Told to read two files and nothing else, the same page takes seconds.
  const instruction =
    `Read the instruction file [${promptPath}] and follow it exactly. ` +
    `The scanned page image is [${imagePath}]. ` +
    'Read only those two files: do not explore the workspace, do not run any command, ' +
    'and do not use any other tool. ' +
    'Answer with the requested output only, no commentary.';
  return { dir, instruction: instruction.replace(/"/g, '') };
}

/**
 * The Google subscription, through the Antigravity CLI's headless mode.
 *
 * Google retired the Gemini CLI's individual subscription login (it is Enterprise-only
 * now), and the Antigravity CLI is its successor: it signs in with a personal Google
 * account — Free, Pro or Ultra — and shares that sign-in with the Antigravity app.
 *
 * Three flags carry the weight:
 *
 *  - `--mode plan` keeps the agent read-only. It may read the page; it may not change
 *    anything, which matters because the page is handed over as a plain file path.
 *  - `--dangerously-skip-permissions` is what lets it open that file with nobody at the
 *    keyboard to approve the read.
 *  - `--output-format json` makes the answer a single envelope, so the transcription is
 *    read from a field instead of being picked out of progress output.
 */
async function callAntigravityCli(
  provider: ResolvedProvider,
  prompt: string,
  image: AiVisionImage,
  onModel?: (model: string) => void
): Promise<string> {
  const kind = 'antigravity-cli';
  const { install } = CLI_CANDIDATES[kind];
  const status = await cliStatus(kind);
  if (!status.available) {
    throw new AiVisionError(`The "${status.bin}" CLI was not found. ${install}`, provider.label);
  }
  const { dir, instruction } = writeAgentWorkspace(prompt, image);
  const args = [
    '-p',
    instruction,
    '--output-format',
    'json',
    '--mode',
    'plan',
    '--dangerously-skip-permissions',
    '--print-timeout',
    `${Math.max(30, Math.round(provider.timeoutMs / 1000))}s`,
  ];
  // The subscription's own configured model is used unless the panel named one.
  if (provider.explicitModel) {
    args.push('--model', provider.model);
  } else {
    // Reading one page is perception, not problem solving. The CLI's default effort is
    // `high`, which spends minutes thinking about a layout that is plain to see; a
    // named model is left to carry its own effort setting.
    args.push('--effort', 'low');
  }

  const result = await runCli(status.bin, args, provider.timeoutMs + 15000, dir);
  const envelope = antigravityEnvelope(result.stdout, result.stderr);
  if (envelope?.status === 'SUCCESS') {
    const text = (envelope.response || '').trim();
    if (text) {
      const reported = antigravityModel(provider);
      onModel?.(reported);
      return text;
    }
  }
  const detail =
    envelope?.error || result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
  if (/authentication required|not authenticated|please sign in|not logged in/i.test(detail)) {
    throw new AiVisionError(
      'The Antigravity CLI is not signed in. Open the sign-in panel and sign in with the Google ' +
        `account that holds your Gemini plan. The CLI said: ${errorSnippet(detail)}`,
      provider.label
    );
  }
  throw new AiVisionError(`The Antigravity CLI failed: ${errorSnippet(detail)}. ${install}`, provider.label);
}

async function callProvider(
  provider: ResolvedProvider,
  prompt: string,
  image: AiVisionImage,
  action: 'layout' | 'ocr',
  context?: AiAgentContext,
  onModel?: (model: string) => void
): Promise<string> {
  switch (provider.kind) {
    case 'anthropic':
      return callAnthropic(provider, prompt, image);
    case 'openai':
    case 'openai-compatible':
      return callOpenAiCompatible(provider, prompt, image);
    case 'claude-agent':
      return callClaudeAgent(provider, prompt, image, action, context, onModel);
    case 'codex-cli':
      return callCodexCli(provider, prompt, image, onModel);
    case 'antigravity-cli':
      return callAntigravityCli(provider, prompt, image, onModel);
    default:
      throw new AiVisionError(`Unsupported provider kind: ${provider.kind}`);
  }
}


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function detectLayout(
  engine: AiEngineId,
  image: AiVisionImage,
  settings: AiVisionSettings = {},
  mode = 'auto'
): Promise<LayoutDetectionResult> {
  const provider = resolveProvider(engine, settings);
  // Only the subscription backend scales the page (it travels through a tool, and a
  // 200 DPI render is far larger than the Agent SDK's message limit). When it does, the
  // prompt must state the size the model will actually see, and the coordinates it
  // returns have to be mapped back to page pixels.
  const scales = provider.kind === 'claude-agent';
  const scale = scales ? Math.min(1, MAX_IMAGE_EDGE / Math.max(image.width, image.height)) : 1;
  const sentWidth = Math.max(1, Math.round(image.width * scale));
  const sentHeight = Math.max(1, Math.round(image.height * scale));
  // The subscription backend reports the model Claude Code actually used; the others
  // report what was asked for.
  let reportedModel: string | null = null;
  const answer = await callProvider(
    provider,
    layoutPrompt(sentWidth, sentHeight, mode),
    image,
    'layout',
    scales ? { ...settings.agentContext, maxEdge: MAX_IMAGE_EDGE } : settings.agentContext,
    (model) => {
      reportedModel = model;
    }
  );
  const { zones, warnings } = normalizeZones(extractJson(answer), image, 1 / scale);
  return {
    zones,
    width: image.width,
    height: image.height,
    engine,
    provider: provider.kind,
    model: reportedModel || provider.model,
    warnings,
  };
}

export async function recognizeText(
  engine: AiEngineId,
  image: AiVisionImage,
  settings: AiVisionSettings = {},
  options: { zone?: { x: number; y: number; width: number; height: number } | null; language?: string } = {}
): Promise<TextRecognitionResult> {
  const provider = resolveProvider(engine, settings);
  let reportedModel: string | null = null;
  const answer = await callProvider(
    provider,
    ocrPrompt(options.zone ?? null, options.language || 'tam+eng'),
    image,
    'ocr',
    // Text has no coordinates, so capping the image only makes the call smaller.
    provider.kind === 'claude-agent'
      ? { ...settings.agentContext, maxEdge: MAX_IMAGE_EDGE }
      : settings.agentContext,
    (model) => {
      reportedModel = model;
    }
  );
  // A model that wraps the transcription in JSON still yields clean text.
  let text = answer;
  if (/^\s*[[{]/.test(answer)) {
    try {
      const parsed = extractJson(answer) as Record<string, unknown>;
      const candidate = parsed?.text ?? parsed?.transcription ?? parsed?.content;
      if (typeof candidate === 'string') text = candidate;
    } catch {
      /* keep the raw answer */
    }
  }
  return {
    text: text.replace(/^```[a-z]*\s*|\s*```$/gi, '').trim(),
    engine,
    provider: provider.kind,
    model: reportedModel || provider.model,
    warnings: [],
  };
}

/**
 * The panel's wording for a sign-in report, with the instruction for each case, so
 * the "Check sign-in" button and the connection test say the same thing.
 */
export function signInMessage(report: SignInReport): string {
  if (report.status === 'signed_in') {
    const parts = [`Signed in as ${report.account || 'Claude subscription (via Claude Code)'}.`];
    if (report.model) parts.push(`Model reported: ${report.model}.`);
    if (report.cliVersion) parts.push(`Claude Code ${report.cliVersion}.`);
    parts.push(
      'Usage draws on the same subscription limits as the Claude apps and Claude Code; ' +
        'nothing is billed to an API key.'
    );
    return parts.join(' ');
  }
  const parts = [report.message || 'Claude Code could not be checked.'];
  const detail = report.detail || report.answer;
  if (detail) parts.push(`Claude Code said: ${detail}`);
  return parts.join(' ');
}

let agentStatusCache: { at: number; value: AgentStatus | null } | null = null;

/**
 * The sidecar's own report, cached briefly: starting the sidecar costs a Python
 * process, and the answer does not change between two toolbar renders.
 */
async function agentStatusCached(): Promise<AgentStatus | null> {
  if (agentStatusCache && Date.now() - agentStatusCache.at < 60000) return agentStatusCache.value;
  let value: AgentStatus | null = null;
  try {
    value = await agentClient.status();
  } catch {
    // Usually the SDK is not installed; the UI then shows the subscription as
    // unavailable with the reason, instead of failing the whole request.
    value = null;
  }
  agentStatusCache = { at: Date.now(), value };
  return value;
}

/** Cheap credential/permission check used by the "Test connection" button. */
export async function testProvider(
  engine: AiEngineId,
  settings: AiVisionSettings = {}
): Promise<{ ok: boolean; provider: AiProviderKind; model: string; message: string }> {
  try {
    const provider = resolveProvider(engine, settings);
    // The Claude subscription: one minimal query with no tools, which also reports
    // which credential Claude Code is using.
    if (provider.kind === 'claude-agent') {
      const report = await agentClient.signIn({
        cliPath: provider.cliPath,
        timeoutMs: Math.min(provider.timeoutMs, 180000),
      });
      return {
        ok: report.signedIn,
        provider: provider.kind,
        model: report.model || provider.model,
        message: signInMessage(report),
      };
    }

    if (provider.kind === 'codex-cli') {
      const status = await cliStatus('codex-cli');
      if (!status.available) {
        return {
          ok: false,
          provider: provider.kind,
          model: provider.model,
          message: `The "${status.bin}" CLI was not found on PATH. ${CLI_CANDIDATES['codex-cli'].install}`,
        };
      }
      return {
        ok: true,
        provider: provider.kind,
        model: status.version || provider.model,
        message: `Found ${status.bin} ${status.version || ''} — the subscription will be used when this engine runs.`,
      };
    }

    // The Google subscription: the CLI is found outside PATH too, so a "not found"
    // answer has to come from the resolver rather than a bare `which`.
    if (provider.kind === 'antigravity-cli') {
      const status = await cliStatus('antigravity-cli');
      if (!status.available) {
        return {
          ok: false,
          provider: provider.kind,
          model: provider.model,
          message: `The "${status.bin}" CLI was not found. ${CLI_CANDIDATES['antigravity-cli'].install}`,
        };
      }
      return {
        ok: true,
        provider: provider.kind,
        model: provider.model,
        message:
          `Found ${status.bin} ${status.version || ''} — the Google subscription will be used when this ` +
          'engine runs. The sign-in panel says which Google account the CLI is signed in with.',
      };
    }

    requireKey(provider);
    const ping = 'Reply with exactly: ok';
    if (provider.kind === 'anthropic') {
      await postJson(
        `${normalizeBaseUrl(provider.endpoint)}/v1/messages`,
        { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' },
        { model: provider.model, max_tokens: 16, messages: [{ role: 'user', content: ping }] },
        Math.min(provider.timeoutMs, 60000),
        provider.label
      );
    } else {
      const headers: Record<string, string> = {};
      if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
      await postJson(
        `${normalizeBaseUrl(provider.endpoint)}/chat/completions`,
        headers,
        { model: provider.model, max_tokens: 16, messages: [{ role: 'user', content: ping }] },
        Math.min(provider.timeoutMs, 60000),
        provider.label
      );
    }
    return {
      ok: true,
      provider: provider.kind,
      model: provider.model,
      message: `Connected to ${provider.endpoint} with model ${provider.model} (key from ${provider.keySource}).`,
    };
  } catch (err: any) {
    return {
      ok: false,
      provider: 'openai-compatible',
      model: settings.model || '',
      message: err?.message || 'Connection test failed',
    };
  }
}

/** What the UI needs to show: configuration state, never the key itself. */
export async function describeProviders(): Promise<
  Array<{
    engine: AiEngineId;
    label: string;
    defaultModel: string;
    defaultBaseUrl: string;
    envKeyConfigured: boolean;
    envKeyName: string;
    subscription: {
      kind: 'claude-agent' | 'codex-cli' | 'antigravity-cli' | null;
      available: boolean;
      bin: string | null;
      version: string | null;
      /** Claude only: the SDK version, the sign-in state once checked, and the account. */
      sdkVersion?: string | null;
      signedIn?: boolean | null;
      account?: string | null;
    };
  }>
> {
  const codex = await cliStatus('codex-cli');
  const antigravity = await cliStatus('antigravity-cli');
  const status = await agentStatusCached();
  const report = agentClient.lastReport;
  const claudeAgent = {
    available: Boolean(status?.cli?.usable),
    bin: status?.cli?.path ?? null,
    version: status?.bundledCliVersion ?? null,
    sdkVersion: status?.sdkVersion ?? null,
    signedIn: report?.signedIn ?? null,
    account: report?.account ?? status?.account ?? null,
  };
  return [
    {
      engine: 'gemini',
      label: 'Google Gemini',
      defaultModel: defaultModelFor('gemini'),
      // The subscription runs through the Antigravity CLI, which has no endpoint to set.
      defaultBaseUrl: '',
      envKeyConfigured: !!envFirst('GEMINI_API_KEY'),
      envKeyName: 'GEMINI_API_KEY',
      subscription: {
        kind: 'antigravity-cli',
        available: antigravity.available,
        bin: antigravity.bin,
        version: antigravity.version,
      },
    },
    {
      engine: 'claude',
      label: 'Anthropic Claude',
      defaultModel: defaultModelFor('claude'),
      defaultBaseUrl: defaultBaseUrlFor('claude', 'anthropic'),
      envKeyConfigured: !!envFirst('ANTHROPIC_API_KEY'),
      envKeyName: 'ANTHROPIC_API_KEY',
      subscription: {
        kind: 'claude-agent',
        available: claudeAgent.available,
        bin: claudeAgent.bin,
        version: claudeAgent.version,
        sdkVersion: claudeAgent.sdkVersion,
        signedIn: claudeAgent.signedIn,
        account: claudeAgent.account,
      },
    },
    {
      engine: 'chatgpt',
      label: 'OpenAI ChatGPT',
      defaultModel: defaultModelFor('chatgpt'),
      defaultBaseUrl: defaultBaseUrlFor('chatgpt', 'openai'),
      envKeyConfigured: !!envFirst('OPENAI_API_KEY'),
      envKeyName: 'OPENAI_API_KEY',
      subscription: { kind: 'codex-cli', available: codex.available, bin: codex.bin, version: codex.version },
    },
    {
      engine: 'openai-compatible',
      label: 'OpenAI-compatible endpoint',
      defaultModel: defaultModelFor('openai-compatible'),
      defaultBaseUrl: defaultBaseUrlFor('openai-compatible', 'openai-compatible'),
      envKeyConfigured: !!envFirst('PULAN_AI_API_KEY', 'OPENAI_COMPATIBLE_API_KEY'),
      envKeyName: 'PULAN_AI_API_KEY',
      subscription: { kind: null, available: false, bin: null, version: null },
    },
  ];
}








