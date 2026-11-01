import React, { useState, useRef } from 'react';
import {
  FileText,
  FileCode,
  FileCheck,
  Search,
  Replace,
  Sparkles,
  Keyboard,
  Copy,
  Check,
  Download,
  Trash2,
  WrapText,
  AlignLeft,
  ChevronDown,
} from 'lucide-react';
import { DocumentPage } from '../types';

interface TextEditorPanelProps {
  currentPage: DocumentPage | null;
  combinedText: string;
  editorMode: 'page' | 'combined';
  onSetEditorMode: (mode: 'page' | 'combined') => void;
  pageText: string;
  onChangePageText: (newText: string) => void;
  onChangeCombinedText: (newText: string) => void;
  onExport: (format: 'docx' | 'txt' | 'json' | 'html') => void;
  onClearText: () => void;
  selectedEngineName: string;
}

export const TextEditorPanel: React.FC<TextEditorPanelProps> = ({
  currentPage,
  combinedText,
  editorMode,
  onSetEditorMode,
  pageText,
  onChangePageText,
  onChangeCombinedText,
  onExport,
  onClearText,
  selectedEngineName,
}) => {
  const [copied, setCopied] = useState(false);
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [showTamilPalette, setShowTamilPalette] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeText = editorMode === 'page' ? pageText : combinedText;
  const setActiveText = editorMode === 'page' ? onChangePageText : onChangeCombinedText;

  // Export needs something to write out: OCR text, pasted or typed text
  const canExport = activeText.trim().length > 0;
  const exportHint = canExport
    ? ''
    : ' — run "Recognize Page" (or type text) first';

  // Copy to clipboard with iframe-safe fallback
  const handleCopy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(activeText);
      } else {
        throw new Error('Clipboard API unavailable');
      }
    } catch {
      // Fallback for iframe environments without clipboard permission
      const textArea = document.createElement('textarea');
      textArea.value = activeText;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand('copy');
      } catch (err) {
        console.warn('Fallback copy failed:', err);
      }
      document.body.removeChild(textArea);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Find & Replace
  const handleReplaceAll = () => {
    if (!findQuery) return;
    const escaped = findQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'g');
    const replaced = activeText.replace(regex, replaceQuery);
    setActiveText(replaced);
  };

  // Tamil Text Normalizer / Post-processor
  const handleCleanTamilText = () => {
    let cleaned = activeText;
    // Remove zero-width non-joiners
    cleaned = cleaned.replace(/\u200c|\u200d/g, '');
    // Replace multiple spaces with single space
    cleaned = cleaned.replace(/[ \t]+/g, '');
    // Remove trailing spaces per line
    cleaned = cleaned
      .split('\n')
      .map((l) => l.trim())
      .join('\n');
    // Normalize Tamil kombu sequences if inverted
    setActiveText(cleaned);
  };

  // Join lines that break inside sentences
  const handleJoinBrokenLines = () => {
    const lines = activeText.split('\n');
    const joined: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        joined.push('');
        continue;
      }
      if (joined.length > 0 && joined[joined.length - 1] !== '' && !/[.!?।]$/.test(joined[joined.length - 1])) {
        joined[joined.length - 1] += '' + line;
      } else {
        joined.push(line);
      }
    }
    setActiveText(joined.join('\n'));
  };

  // Insert Tamil character at cursor position
  const insertTamilChar = (char: string) => {
    if (!textareaRef.current) return;
    const el = textareaRef.current;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const text = activeText;
    const newText = text.substring(0, start) + char + text.substring(end);
    setActiveText(newText);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + char.length, start + char.length);
    }, 10);
  };

  // Tamil alphabet palette
  const vowels = ['அ', 'ஆ', 'இ', 'ஈ', 'உ', 'ஊ', 'எ', 'ஏ', 'ஐ', 'ஒ', 'ஓ', 'ஔ', 'ஃ'];
  const consonants = [
    'க', 'ங', 'ச', 'ஞ', 'ட', 'ண', 'த', 'ந', 'ப', 'ம',
    'ய', 'ர', 'ல', 'வ', 'ழ', 'ள', 'ற', 'ன', 'ஜ', 'ஷ', 'ஸ', 'ஹ', 'க்ஷ',
  ];
  const diacritics = ['்', 'ா', 'ி', 'ீ', 'ு', 'ூ', 'ெ', 'ே', 'ை', 'ொ', 'ோ', 'ௌ'];
  const symbols = ['௧', '௨', '௩', '௪', '௫', '௬', '௭', '௮', '௯', '௰', '௹', '௺'];

  // Calculate line numbers
  const lines = activeText.split('\n');
  const lineCount = lines.length;
  const wordCount = activeText.trim() ? activeText.trim().split(/\s+/).length : 0;
  const charCount = activeText.length;

  return (
    <div className="w-[420px] bg-[#f8fafc] text-slate-800 border-l border-[#e2e8f0] flex flex-col h-full shrink-0 select-none">
      {/* Editor Header Bar */}
      <div className="p-2 border-b border-[#e2e8f0] bg-[#f1f5f9] flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <FileText className="w-4 h-4 text-emerald-600" />
          <span className="text-xs font-semibold text-slate-900">OCR Editor</span>
          <span className="text-[10px] text-emerald-600 bg-emerald-100 px-1.5 py-0.5 rounded border border-emerald-300 font-mono">
            {selectedEngineName}
          </span>
        </div>

        {/* View mode toggle */}
        <div className="flex items-center bg-[#ffffff] p-0.5 rounded border border-[#cbd5e1] text-[11px]">
          <button
            onClick={() => onSetEditorMode('page')}
            className={`px-2 py-0.5 rounded font-medium transition-colors ${ editorMode === 'page' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900' }`}
          >
            Current Page
          </button>
          <button
            onClick={() => onSetEditorMode('combined')}
            className={`px-2 py-0.5 rounded font-medium transition-colors ${ editorMode === 'combined' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900' }`}
          >
            All Pages
          </button>
        </div>
      </div>

      {/* Editor Secondary Actions Toolbar */}
      <div className="px-2 py-1 border-b border-[#e2e8f0] bg-[#ffffff] flex items-center justify-between text-xs">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowFindReplace(!showFindReplace)}
            title="Find & Replace in Tamil text"
            className={`p-1.5 rounded transition-colors ${ showFindReplace ? 'bg-blue-600 text-white' : 'text-slate-700 hover:bg-[#f1f5f9]' }`}
          >
            <Search className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setShowTamilPalette(!showTamilPalette)}
            title="Tamil Virtual Keyboard / Character Palette"
            className={`p-1.5 rounded transition-colors ${ showTamilPalette ? 'bg-amber-600 text-white' : 'text-slate-700 hover:bg-[#f1f5f9]' }`}
          >
            <Keyboard className="w-3.5 h-3.5 text-amber-600" />
          </button>
          <div className="h-4 w-px bg-[#e2e8f0] mx-0.5"></div>
          <button
            onClick={handleCleanTamilText}
            title="Clean whitespace and fix Tamil Unicode ligatures"
            className="flex items-center gap-1 px-2 py-1 rounded bg-[#ffffff] hover:bg-[#f1f5f9] text-[11px] text-blue-700 border border-[#cbd5e1]"
          >
            <Sparkles className="w-3 h-3 text-blue-600" />
            <span>Normalize</span>
          </button>
          <button
            onClick={handleJoinBrokenLines}
            title="Join broken sentence lines"
            className="p-1.5 rounded hover:bg-[#f1f5f9] text-slate-700"
          >
            <WrapText className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            title="Copy text to clipboard"
            className="flex items-center gap-1 px-2 py-1 rounded bg-[#ffffff] hover:bg-[#f1f5f9] text-[11px] text-slate-800 border border-[#cbd5e1]"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3 text-slate-600" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <button
            onClick={onClearText}
            title="Clear editor"
            className="p-1.5 rounded hover:bg-rose-100 text-rose-600"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Find & Replace Bar (Collapsible) */}
      {showFindReplace && (
        <div className="p-2 bg-[#f1f5f9] border-b border-[#e2e8f0] space-y-1.5 text-xs animate-in slide-in-from-top duration-150">
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Find Tamil or English text..."
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              className="flex-1 bg-[#ffffff] border border-[#cbd5e1] rounded px-2 py-1 text-slate-900 placeholder-slate-500 text-xs focus:ring-1 focus:ring-blue-500 outline-hidden font-sans"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Replace with..."
              value={replaceQuery}
              onChange={(e) => setReplaceQuery(e.target.value)}
              className="flex-1 bg-[#ffffff] border border-[#cbd5e1] rounded px-2 py-1 text-slate-900 placeholder-slate-500 text-xs focus:ring-1 focus:ring-blue-500 outline-hidden font-sans"
            />
            <button
              onClick={handleReplaceAll}
              disabled={!findQuery}
              className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium text-xs disabled:opacity-40"
            >
              Replace All
            </button>
          </div>
        </div>
      )}

      {/* Tamil Virtual Keyboard Palette (Collapsible) */}
      {showTamilPalette && (
        <div className="p-2 bg-[#f1f5f9] border-b border-[#e2e8f0] text-xs max-h-48 overflow-y-auto space-y-2 animate-in slide-in-from-top duration-150">
          <div>
            <div className="text-[10px] text-amber-600 font-semibold mb-1">உயிர் எழுத்துக்கள் (Vowels):</div>
            <div className="flex flex-wrap gap-1">
              {vowels.map((c) => (
                <button
                  key={c}
                  onClick={() => insertTamilChar(c)}
                  className="w-7 h-7 bg-[#ffffff] hover:bg-amber-600 hover:text-white rounded border border-[#cbd5e1] font-medium text-sm flex items-center justify-center transition-colors"
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-blue-600 font-semibold mb-1">மெய் எழுத்துக்கள் (Consonants):</div>
            <div className="flex flex-wrap gap-1">
              {consonants.map((c) => (
                <button
                  key={c}
                  onClick={() => insertTamilChar(c)}
                  className="w-7 h-7 bg-[#ffffff] hover:bg-blue-600 hover:text-white rounded border border-[#cbd5e1] font-medium text-sm flex items-center justify-center transition-colors"
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-emerald-600 font-semibold mb-1">குறியீடுகள் & எண்கள் (Diacritics & Numbers):</div>
            <div className="flex flex-wrap gap-1">
              {diacritics.concat(symbols).map((c) => (
                <button
                  key={c}
                  onClick={() => insertTamilChar(c)}
                  className="w-7 h-7 bg-[#ffffff] hover:bg-emerald-600 hover:text-white rounded border border-[#cbd5e1] font-medium text-sm flex items-center justify-center transition-colors"
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Text Area with Line Numbers */}
      <div className="flex-1 flex overflow-hidden bg-white text-slate-900 relative">
        {/* Line Numbers Column */}
        <div className="w-10 bg-[#f1f5f9] text-[#64748b] font-mono text-xs select-none py-3 px-1 text-right border-r border-[#e2e8f0] overflow-hidden leading-[1.6rem]">
          {Array.from({ length: Math.max(1, lineCount) }).map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>

        {/* Text Input Area */}
        <textarea
          ref={textareaRef}
          value={activeText}
          onChange={(e) => setActiveText(e.target.value)}
          placeholder={
            editorMode === 'page'
              ? 'OCR text for the current page will appear here...\n\nClick "Recognize Page" on the top toolbar or draw a zone to run OCR.'
              : 'Combined OCR text for all document pages will appear here in reading sequence...'
          }
          style={{ fontFamily: "'Lohit Tamil', 'Nirmala UI', 'Latha', 'Mukta Malar', sans-serif" }}
          className="flex-1 p-3 text-sm leading-[1.6rem] outline-hidden resize-none bg-white text-slate-900 overflow-y-auto selection:bg-blue-200"
          spellCheck={false}
        />
      </div>

      {/* Export Bar at Bottom of Editor */}
      <div className="p-2 border-t border-[#e2e8f0] bg-[#f1f5f9] flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[11px] text-slate-600 px-1">
          <span>
            {lineCount} {lineCount === 1 ? 'line' : 'lines'} | {wordCount} words | {charCount} chars
            {!canExport && (
              <span className="text-slate-500"> — nothing to export yet, run OCR or type text</span>
            )}
          </span>
          <span className="text-emerald-600 font-medium">Unicode Tamil Ready</span>
        </div>

        <div className="grid grid-cols-4 gap-1.5">
          <button
            onClick={() => onExport('docx')}
            disabled={!canExport}
            title={`Export to Microsoft Word (.docx)${exportHint}`}
            className="flex items-center justify-center gap-1.5 py-1.5 px-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded text-xs font-semibold shadow-xs transition-colors"
          >
            <FileText className="w-3.5 h-3.5 text-white" />
            <span>DOCX</span>
          </button>
          <button
            onClick={() => onExport('txt')}
            disabled={!canExport}
            title={`Export to plain text (.txt)${exportHint}`}
            className="flex items-center justify-center gap-1.5 py-1.5 px-2 bg-slate-600 hover:bg-slate-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded text-xs font-semibold shadow-xs transition-colors"
          >
            <FileCode className="w-3.5 h-3.5 text-white" />
            <span>TXT</span>
          </button>
          <button
            onClick={() => onExport('json')}
            disabled={!canExport}
            title={`Export to JSON with zones and coordinates (.json)${exportHint}`}
            className="flex items-center justify-center gap-1.5 py-1.5 px-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded text-xs font-semibold shadow-xs transition-colors"
          >
            <FileCheck className="w-3.5 h-3.5 text-white" />
            <span>JSON</span>
          </button>
          <button
            onClick={() => onExport('html')}
            disabled={!canExport}
            title={`Export to HTML (.html)${exportHint}`}
            className="flex items-center justify-center gap-1.5 py-1.5 px-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded text-xs font-semibold shadow-xs transition-colors"
          >
            <Download className="w-3.5 h-3.5 text-white" />
            <span>HTML</span>
          </button>
        </div>
      </div>
    </div>
  );
};
