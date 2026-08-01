import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  LabelHTMLAttributes,
} from "react";

function classes(base: string, className?: string): string {
  return className ? `${base} ${className}` : base;
}

export function Panel({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={classes(
        "rounded-2xl border border-slate-800/90 bg-slate-900/80 shadow-xl shadow-slate-950/20",
        className,
      )}
      {...props}
    />
  );
}

type StatusBadgeProps = HTMLAttributes<HTMLSpanElement> & {
  appearance?: "live" | "warning" | "neutral";
};

const badgeClasses: Record<NonNullable<StatusBadgeProps["appearance"]>, string> = {
  live: "border-teal-400/25 bg-teal-400/10 text-teal-200",
  warning: "border-amber-400/25 bg-amber-400/10 text-amber-200",
  neutral: "border-slate-700 bg-slate-800/80 text-slate-300",
};

export function StatusBadge({ appearance = "neutral", className, ...props }: StatusBadgeProps) {
  return (
    <span
      className={classes(
        `inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold tracking-wide ${badgeClasses[appearance]}`,
        className,
      )}
      {...props}
    />
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  appearance?: "primary" | "secondary" | "danger";
};

const buttonClasses: Record<NonNullable<ButtonProps["appearance"]>, string> = {
  primary: "border-cyan-300/20 bg-cyan-400 text-slate-950 hover:bg-cyan-300",
  secondary: "border-slate-700 bg-slate-800 text-slate-100 hover:border-slate-600 hover:bg-slate-700",
  danger: "border-red-400/30 bg-red-500/10 text-red-200 hover:bg-red-500/20",
};

export function Button({ appearance = "primary", className, type = "button", ...props }: ButtonProps) {
  return (
    <button
      className={classes(
        `inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-lg border px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${buttonClasses[appearance]}`,
        className,
      )}
      type={type}
      {...props}
    />
  );
}

export function Field({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={classes("grid gap-2 text-sm font-medium text-slate-200", className)}
      {...props}
    />
  );
}
