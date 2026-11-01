import React from 'react';
import {
  FileText,
  CheckSquare,
  Square,
  Layers,
  Trash2,
  RotateCw,
  ArrowUp,
  ArrowDown,
  Columns,
  CheckCircle2,
  Clock,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { DocumentPage } from '../types';

interface DocumentTreePanelProps {
  documentName: string;
  pages: DocumentPage[];
  currentPageIndex: number;
  onSelectPage: (index: number) => void;
  selectedPageIds: Set<string>;
  onToggleSelectPage: (pageId: string) => void;
  onSelectAllPages: () => void;
  onDeselectAllPages: () => void;
  onRotatePage: (pageId: string) => void;
  onDeletePage: (pageId: string) => void;
  onMovePage: (fromIndex: number, toIndex: number) => void;
}

export const DocumentTreePanel: React.FC<DocumentTreePanelProps> = ({
  documentName,
  pages,
  currentPageIndex,
  onSelectPage,
  selectedPageIds,
  onToggleSelectPage,
  onSelectAllPages,
  onDeselectAllPages,
  onRotatePage,
  onDeletePage,
  onMovePage,
}) => {
  const allSelected = pages.length > 0 && selectedPageIds.size === pages.length;

  return (
    <div className="w-64 bg-[#ffffff] text-slate-800 border-r border-[#e2e8f0] flex flex-col h-full select-none shrink-0">
      {/* Header */}
      <div className="p-2.5 border-b border-[#e2e8f0] bg-[#f8fafc] flex items-center justify-between">
        <div className="flex items-center gap-2 overflow-hidden">
          <FileText className="w-4 h-4 text-blue-600 shrink-0" />
          <div className="truncate">
            <div className="text-xs font-semibold text-slate-900 truncate" title={documentName}>
              {documentName || 'No Document Open'}
            </div>
            <div className="text-[10px] text-slate-600">
              {pages.length} {pages.length === 1 ? 'Page' : 'Pages'} Loaded
            </div>
          </div>
        </div>

        {/* Batch selection toggles */}
        {pages.length > 0 && (
          <button
            onClick={allSelected ? onDeselectAllPages : onSelectAllPages}
            title={allSelected ? 'Deselect All' : 'Select All for Batch'}
            className="p-1 rounded hover:bg-[#f1f5f9] text-slate-700"
          >
            {allSelected ? (
              <CheckSquare className="w-4 h-4 text-blue-600" />
            ) : (
              <Square className="w-4 h-4 text-slate-600" />
            )}
          </button>
        )}
      </div>

      {/* Pages List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {pages.length === 0 ? (
          <div className="text-center py-10 px-4 text-slate-500 text-xs">
            <Layers className="w-8 h-8 mx-auto mb-2 opacity-40 text-slate-600" />
            <p>No document pages open.</p>
            <p className="mt-1 text-[11px] text-slate-600">
              Click <span className="text-blue-600 font-semibold">Open File</span> to load a PDF or image
              scan.
            </p>
          </div>
        ) : (
          pages.map((page, index) => {
            const isCurrent = index === currentPageIndex;
            const isChecked = selectedPageIds.has(page.id);
            const numColumns = page.detectedZones.filter((z) => z.type === 'column').length;
            const hasHeadline = page.detectedZones.some((z) => z.type === 'headline');

            return (
              <div
                key={page.id}
                onClick={() => onSelectPage(index)}
                className={`relative group rounded border transition-all cursor-pointer p-2 ${ isCurrent ? 'bg-[#dbeafe] border-blue-500 shadow-md ring-1 ring-blue-500/50' : 'bg-[#ffffff] border-[#cbd5e1] hover:border-slate-400' }`}
              >
                {/* Top Row: Checkbox, Page title, Actions */}
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5 overflow-hidden">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={(e) => {
                        e.stopPropagation();
                        onToggleSelectPage(page.id);
                      }}
                      className="rounded border-[#94a3b8] text-blue-600 focus:ring-0 cursor-pointer w-3.5 h-3.5"
                    />
                    <span className="text-xs font-semibold text-slate-800">
                      Page {page.pageNumber}
                    </span>
                  </div>

                  <div className="flex items-center gap-0.5 opacity-70 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onRotatePage(page.id);
                      }}
                      title="Rotate Page"
                      className="p-1 hover:bg-[#e2e8f0] rounded text-slate-700"
                    >
                      <RotateCw className="w-3 h-3" />
                    </button>
                    {index > 0 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onMovePage(index, index - 1);
                        }}
                        title="Move Up"
                        className="p-1 hover:bg-[#e2e8f0] rounded text-slate-700"
                      >
                        <ArrowUp className="w-3 h-3" />
                      </button>
                    )}
                    {index < pages.length - 1 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onMovePage(index, index + 1);
                        }}
                        title="Move Down"
                        className="p-1 hover:bg-[#e2e8f0] rounded text-slate-700"
                      >
                        <ArrowDown className="w-3 h-3" />
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeletePage(page.id);
                      }}
                      title="Delete Page"
                      className="p-1 hover:bg-rose-100 rounded text-rose-600"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {/* Thumbnail Preview container */}
                <div className="w-full h-28 bg-[#f1f5f9] rounded border border-[#e2e8f0] overflow-hidden flex items-center justify-center relative mb-1.5">
                  <img
                    src={page.url}
                    alt={`Page ${page.pageNumber}`}
                    loading="lazy"
                    decoding="async"
                    className="max-h-full max-w-full object-contain pointer-events-none transition-transform"
                    style={{ transform: `rotate(${page.rotation || 0}deg)` }}
                  />

                  {/* Layout bounding boxes mini overlay */}
                  {page.detectedZones.length > 0 && (
                    <div className="absolute inset-0 pointer-events-none p-1">
                      {page.detectedZones.map((z) => (
                        <div
                          key={z.id}
                          className="absolute border border-blue-400/80 bg-blue-500/15"
                          style={{
                            left: `${(z.x / (page.width || 900)) * 100}%`,
                            top: `${(z.y / (page.height || 1200)) * 100}%`,
                            width: `${(z.width / (page.width || 900)) * 100}%`,
                            height: `${(z.height / (page.height || 1200)) * 100}%`,
                          }}
                        />
                      ))}
                    </div>
                  )}

                  {/* OCR Status icon on thumbnail */}
                  <div className="absolute bottom-1 right-1">
                    {page.ocrStatus === 'done' && (
                      <span className="flex items-center gap-0.5 bg-emerald-100 border border-emerald-300 text-emerald-700 text-[9px] font-semibold px-1 py-0.5 rounded shadow-xs">
                        <CheckCircle2 className="w-2.5 h-2.5 text-emerald-600" /> Done
                      </span>
                    )}
                    {page.ocrStatus === 'processing' && (
                      <span className="flex items-center gap-0.5 bg-blue-100 border border-blue-300 text-blue-700 text-[9px] font-semibold px-1 py-0.5 rounded shadow-xs">
                        <Loader2 className="w-2.5 h-2.5 animate-spin text-blue-600" /> OCR...
                      </span>
                    )}
                    {page.ocrStatus === 'detecting' && (
                      <span className="flex items-center gap-0.5 bg-indigo-100 border border-indigo-300 text-indigo-600 text-[9px] font-semibold px-1 py-0.5 rounded shadow-xs">
                        <Loader2 className="w-2.5 h-2.5 animate-spin text-indigo-600" /> Layout...
                      </span>
                    )}
                  </div>
                </div>

                {/* Bottom Badges */}
                <div className="flex items-center justify-between text-[10px] text-slate-600">
                  <div className="flex items-center gap-1">
                    {page.detectedZones.length > 0 ? (
                      <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded border border-blue-300 font-medium flex items-center gap-1">
                        <Columns className="w-2.5 h-2.5" />
                        {numColumns > 0 ? `${numColumns} Col` : '1 Col'}
                        {hasHeadline ? '+ Title' : ''}
                      </span>
                    ) : (
                      <span className="text-slate-500 italic">No layout</span>
                    )}
                  </div>
                  <span className="font-mono text-[9px] text-slate-500">
                    {page.width || 900}×{page.height || 1200}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer Summary */}
      {pages.length > 0 && (
        <div className="p-2 border-t border-[#e2e8f0] bg-[#f8fafc] text-[10px] text-slate-600 flex items-center justify-between">
          <span>
            Selected for batch:{''}
            <strong className="text-slate-800">{selectedPageIds.size}</strong> of {pages.length}
          </span>
          {selectedPageIds.size > 0 && (
            <button
              onClick={onDeselectAllPages}
              className="text-blue-600 hover:underline cursor-pointer"
            >
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  );
};
