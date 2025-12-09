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

  return (
    <div className="w-full space-y-2">
      <div className="flex justify-between text-sm text-slate-400">
        <span>Progress</span>
        <span>{percent}% ({completed}/{total})</span>
      </div>
      <div className="h-4 bg-slate-800 rounded-full overflow-hidden relative flex">
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
      <div className="grid grid-cols-10 gap-0.5 pt-2">
        {segments.map((seg) => {
            let color = 'bg-slate-800';
            if (seg.status === 'completed') color = 'bg-emerald-500';
            if (seg.status === 'uploading') color = 'bg-indigo-500';
            if (seg.status === 'error') color = 'bg-red-500';
            
            return (
                <div 
                    key={seg.index} 
                    className={`h-1.5 rounded-sm ${color} transition-colors duration-300`}
                    title={`Segment ${seg.index}: ${seg.status}`}
                />
            )
        })}
      </div>
    </div>
  );
};