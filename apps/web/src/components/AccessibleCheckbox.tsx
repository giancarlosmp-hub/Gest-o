import { ReactNode, useId } from "react";

type AccessibleCheckboxProps = {
  checked: boolean;
  children: ReactNode;
  disabled?: boolean;
  id?: string;
  onChange: (checked: boolean) => void;
  className?: string;
};

export default function AccessibleCheckbox({
  checked,
  children,
  disabled = false,
  id,
  onChange,
  className = "",
}: AccessibleCheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <label
      htmlFor={inputId}
      className={`group flex min-h-11 items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-2 py-2 text-left leading-relaxed text-amber-950 transition hover:border-amber-500 hover:bg-amber-100 has-[:disabled]:cursor-not-allowed has-[:disabled]:border-slate-300 has-[:disabled]:bg-slate-100 has-[:disabled]:text-slate-500 sm:px-3 ${
        disabled ? "cursor-not-allowed" : "cursor-pointer"
      } ${className}`}
    >
      <span className="relative flex h-11 w-11 shrink-0 items-start justify-center pt-2.5">
        <input
          id={inputId}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="peer absolute inset-0 h-11 w-11 cursor-pointer appearance-none rounded-lg outline-none disabled:cursor-not-allowed"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none flex h-6 w-6 items-center justify-center rounded border-2 border-amber-700 bg-white text-white shadow-sm transition group-hover:border-amber-900 peer-checked:border-brand-700 peer-checked:bg-brand-700 peer-checked:[&>svg]:opacity-100 peer-focus-visible:ring-4 peer-focus-visible:ring-brand-200 peer-disabled:border-slate-400 peer-disabled:bg-slate-200 peer-disabled:text-slate-400"
        >
          <svg
            viewBox="0 0 20 20"
            className="h-5 w-5 opacity-0 transition"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m4 10 4 4 8-9" />
          </svg>
        </span>
      </span>
      <span className="min-w-0 flex-1 py-2.5">{children}</span>
    </label>
  );
}
