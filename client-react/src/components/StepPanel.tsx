import type { ReactNode } from "react";

interface StepPanelProps {
  title: string; children: ReactNode; response?: unknown; responseMeta?: string | null;
  open: boolean; done: boolean; loading: boolean; active: boolean; disabled: boolean;
  num: number; manual?: boolean; keepMounted?: boolean; onHeaderClick: () => void;
}

export function StepPanel({ title, children, response, responseMeta, open, done, loading, active, disabled,
  num, manual = false, keepMounted = false, onHeaderClick }: StepPanelProps) {
  const numClasses = [
    "w-7 h-7 rounded-full flex items-center justify-center text-sm shrink-0",
    done ? "bg-green-500 text-white" :
    loading ? "border-3 border-gray-200 border-t-blue-500 animate-spin text-transparent" :
    active ? "bg-blue-500 text-white" :
    "bg-gray-200 text-gray-700",
  ].join(" ");

  return (
    <div className={[
      "bg-white border rounded-lg mb-3 overflow-visible",
      disabled ? "opacity-60" : "",
      done ? "border-green-500" : "border-gray-300",
    ].join(" ")}>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-4 py-3.5 cursor-pointer select-none text-left font-semibold"
        onClick={onHeaderClick}
      >
        <span className={numClasses}>{loading ? "" : manual ? (open ? "−" : "+") : num}</span>
        {title}
      </button>
      {(open || keepMounted) && (
        <div className="px-4 pb-4 space-y-2" hidden={keepMounted && !open ? true : undefined}>
          {children}
          {response != null && (
            <div className="mt-3 overflow-hidden rounded border border-gray-800 bg-[#1e1e1e]">
              {responseMeta && (
                <div className="border-b border-gray-700 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-300">
                  {responseMeta}
                </div>
              )}
              <pre className="text-[#d4d4d4] p-3 text-xs max-h-72 overflow-auto whitespace-pre-wrap break-all m-0">
                {typeof response === "string" ? response : JSON.stringify(response, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
