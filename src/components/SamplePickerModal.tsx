import React from 'react';
import { X, Sparkles, FileText, ArrowRight } from 'lucide-react';
import { SampleDoc } from '../types';

interface SamplePickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  samples: SampleDoc[];
  onSelectSample: (sample: SampleDoc) => void;
  loadingSample: boolean;
}

export const SamplePickerModal: React.FC<SamplePickerModalProps> = ({
  isOpen,
  onClose,
  samples,
  onSelectSample,
  loadingSample,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[#ffffff] border border-[#cbd5e1] rounded-lg shadow-2xl max-w-2xl w-full text-slate-800 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="p-4 border-b border-[#e2e8f0] bg-[#f1f5f9] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-600" />
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Load Tamil Sample Documents</h3>
              <p className="text-xs text-slate-600">
                Pre-configured multi-column articles, ancient Thirukkural poetry, and gnana70 dataset images
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#f1f5f9] text-slate-600 hover:text-slate-900"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Samples List */}
        <div className="p-4 space-y-3 max-h-[60vh] overflow-y-auto">
          {samples.map((sample) => (
            <div
              key={sample.id}
              onClick={() => onSelectSample(sample)}
              className="group p-3 bg-[#ffffff] hover:bg-[#f1f5f9] border border-[#cbd5e1] hover:border-blue-500 rounded-md cursor-pointer transition-all flex items-center justify-between"
            >
              <div className="flex items-start gap-3">
                <div className="p-2.5 bg-blue-100 border border-blue-300 text-blue-600 rounded group-hover:bg-blue-600 group-hover:text-white transition-colors shrink-0 mt-0.5">
                  <FileText className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-slate-900 group-hover:text-blue-600 transition-colors flex items-center gap-2">
                    <span>{sample.title}</span>
                    <span className="text-[10px] px-1.5 py-0.5 bg-[#f1f5f9] text-slate-600 rounded border border-[#cbd5e1] font-mono">
                      {sample.pages.length} {sample.pages.length === 1 ? 'Page' : 'Pages'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 mt-1">{sample.description}</p>
                </div>
              </div>

              <div className="p-2 rounded-full text-slate-600 group-hover:text-blue-600 group-hover:translate-x-1 transition-all">
                <ArrowRight className="w-4 h-4" />
              </div>
            </div>
          ))}
        </div>

        {/* Modal Footer */}
        <div className="p-3 border-t border-[#e2e8f0] bg-[#f1f5f9] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#f1f5f9] hover:bg-[#e2e8f0] text-slate-800 rounded text-xs font-medium"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
