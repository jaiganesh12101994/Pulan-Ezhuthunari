import React from 'react';
import { Layers, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

interface BatchModalProps {
  isOpen: boolean;
  title: string;
  total: number;
  current: number;
  currentMessage: string;
  isComplete: boolean;
  /** A cancel is in flight: the run stops at the next page or zone boundary. */
  isCancelling?: boolean;
  /** The run stopped early because the user cancelled it. */
  wasCancelled?: boolean;
  /** The run stopped because something failed; the message is the reason. */
  hasError?: boolean;
  onClose: () => void;
  onCancel?: () => void;
}

export const BatchModal: React.FC<BatchModalProps> = ({
  isOpen,
  title,
  total,
  current,
  currentMessage,
  isComplete,
  isCancelling = false,
  wasCancelled = false,
  hasError = false,
  onClose,
  onCancel,
}) => {
  if (!isOpen) return null;

  const percent = total > 0 ? Math.round((current / total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[#ffffff] border border-[#cbd5e1] rounded-lg shadow-2xl max-w-md w-full text-slate-800 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="p-4 border-b border-[#e2e8f0] bg-[#f1f5f9] flex items-center gap-2">
          {hasError ? (
            <AlertCircle className="w-5 h-5 text-rose-600" />
          ) : wasCancelled ? (
            <AlertCircle className="w-5 h-5 text-amber-500" />
          ) : isComplete ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
          ) : (
            <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />
          )}
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        </div>

        <div className="p-5 space-y-4 text-xs">
          <div className="flex justify-between font-medium text-slate-700">
            <span>Progress: Page {current} of {total}</span>
            <span className="font-mono text-blue-600 font-bold">{percent}%</span>
          </div>

          {/* Progress bar */}
          <div className="w-full bg-[#f1f5f9] h-2.5 rounded-full overflow-hidden border border-[#e2e8f0]">
            <div
              className={`h-full transition-all duration-300 ${ hasError ? 'bg-rose-600' : wasCancelled ? 'bg-amber-500' : isComplete ? 'bg-emerald-500' : 'bg-gradient-to-r from-blue-600 to-indigo-500' }`}
              style={{ width: `${percent}%` }}
            />
          </div>

          <div className="bg-[#f1f5f9] p-3 rounded border border-[#e2e8f0] text-slate-700 text-xs font-mono">
            {currentMessage || 'Processing pages...'}
          </div>
        </div>

        <div className="p-3 border-t border-[#e2e8f0] bg-[#f1f5f9] flex justify-end gap-2">
          {!isComplete && onCancel && (
            <button
              onClick={onCancel}
              disabled={isCancelling}
              title="Stop after the page already in flight"
              className={`px-3 py-1.5 rounded text-xs font-semibold border ${
                isCancelling
                  ? 'bg-[#f1f5f9] border-[#e2e8f0] text-slate-500 cursor-not-allowed'
                  : 'bg-[#fef2f2] border-[#fecaca] text-red-700 hover:bg-[#fee2e2]'
              }`}
            >
              {isCancelling ? 'Cancelling…' : 'Cancel OCR'}
            </button>
          )}
          <button
            onClick={onClose}
            disabled={!isComplete}
            className={`px-4 py-1.5 rounded text-xs font-semibold ${ isComplete ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-xs' : 'bg-[#f1f5f9] text-slate-500 cursor-not-allowed' }`}
          >
            {isComplete ? 'Done' : 'Processing...'}
          </button>
        </div>
      </div>
    </div>
  );
};
