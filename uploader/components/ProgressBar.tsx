import React from 'react';
import { SegmentInfo } from '../types';

interface ProgressBarProps {
  segments: SegmentInfo[];
}

export const ProgressBar: React.FC<ProgressBarProps> = ({ segments }) => {
  const total = segments.length;
  if (total === 0) return null;

  const completed = segments.filter(s => s.status === 'completed').length;
  const uploading = segments.filter(s => s.status === 'uploading').length;
  const percent = Math.round((completed / total) * 100);
  // Keep the mini map compact so long timelines fit within ~3 rows.
  const columns = Math.max(1, Math.min(200, Math.ceil(total / 3)));

  return (
    <div className="w-full space-y-2">
      <div className="flex justify-between text-sm text-slate-400">
        <span>Progress</span>
        <span>{percent}% ({completed}/{total})</span>
      </div>
      <div className="h-3 bg-slate-800 rounded-full overflow-hidden relative flex">
        {/* Completed bar */}
        <div 
          className="h-full bg-emerald-500 transition-all duration-500 ease-out"
          style={{ width: `${(completed / total) * 100}%` }}
        />
        {/* Uploading (In-flight) bar */}
        <div 
          className="h-full bg-indigo-500 transition-all duration-300 ease-out animate-pulse"
          style={{ width: `${(uploading / total) * 100}%` }}
        />
      </div>
      <div
        className="grid gap-px pt-2"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(2px, 1fr))` }}
      >
        {segments.map((seg) => {
            let color = 'bg-slate-800';
            if (seg.status === 'completed') color = 'bg-emerald-500';
            if (seg.status === 'uploading') color = 'bg-indigo-500';
            if (seg.status === 'error') color = 'bg-red-500';
            
            return (
                <div 
                    key={seg.index} 
                    className={`h-1 rounded-sm ${color} transition-colors duration-300`}
                    title={`Segment ${seg.index}: ${seg.status}`}
                />
            )
        })}
      </div>
    </div>
  );
};
