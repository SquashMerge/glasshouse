// Simple dropdown menu built on Radix UI primitives.
// Install with: bunx shadcn@latest add dropdown-menu (this hand-rolled
// minimal version exists for builds without Radix deps installed yet).

import * as React from "react";
import { cn } from "../../lib/utils";

interface DropdownMenuContextValue {
  open: boolean;
  setOpen: (v: boolean) => void;
}
const DropdownMenuContext = React.createContext<DropdownMenuContextValue>({ open: false, setOpen: () => {} });

function DropdownMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return <DropdownMenuContext.Provider value={{ open, setOpen }}>{children}</DropdownMenuContext.Provider>;
}

function DropdownMenuTrigger({ children, asChild: _asChild, ...props }: React.HTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) {
  const ctx = React.useContext(DropdownMenuContext);
  return (
    <button
      type="button"
      onClick={() => ctx.setOpen(!ctx.open)}
      onBlur={() => ctx.setOpen(false)}
      {...props}
    >
      {children}
    </button>
  );
}

function DropdownMenuContent({ children, align = "end", className }: { children: React.ReactNode; align?: "start" | "end"; className?: string }) {
  const ctx = React.useContext(DropdownMenuContext);
  if (!ctx.open) return null;
  return (
    <div
      className={cn(
        "absolute z-50 mt-1 min-w-[8rem] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md",
        align === "end" ? "right-0" : "left-0",
        className,
      )}
      role="menu"
    >
      {children}
    </div>
  );
}

function DropdownMenuItem({ children, className, onSelect, ...props }: React.HTMLAttributes<HTMLDivElement> & { onSelect?: () => void }) {
  const ctx = React.useContext(DropdownMenuContext);
  return (
    <div
      role="menuitem"
      tabIndex={0}
      onClick={() => {
        onSelect?.();
        ctx.setOpen(false);
      }}
      className={cn("relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground", className)}
      {...props}
    >
      {children}
    </div>
  );
}

function DropdownMenuSeparator({ className }: { className?: string }) {
  return <div role="separator" className={cn("-mx-1 my-1 h-px bg-border", className)} />;
}

function DropdownMenuLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("px-2 py-1.5 text-sm font-semibold", className)}>{children}</div>;
}

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel };