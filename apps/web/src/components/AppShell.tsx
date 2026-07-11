// Top-bar shell with logo, nav links, and user dropdown menu (logout).

import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";
import { clearCredentials, getCredentials } from "../lib/auth";

interface AppShellProps {
  children: React.ReactNode;
  /** Override current path for active nav-link styling (optional). */
  currentPath?: string;
}

export function AppShell({ children, currentPath }: AppShellProps) {
  const [creds, setCreds] = React.useState(getCredentials());

  function logout() {
    clearCredentials();
    setCreds(null);
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
  }

  function isActive(path: string) {
    return currentPath === path || (path !== "/" && currentPath?.startsWith(path));
  }

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <Link to="/" className="text-base font-semibold tracking-tight">
            Astraea
          </Link>
          <nav className="flex gap-1">
            <NavLink to="/" label="Dashboard" active={isActive("/")} />
            <NavLink to="/traces" label="Traces" active={isActive("/traces")} />
          </nav>
          <div className="flex-1" />
          {creds ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="rounded-md px-3 py-1.5 text-sm hover:bg-muted">
                {creds.username}
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>Signed in</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={logout}>Log out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button asChild={false} onClick={() => (window.location.href = "/login")}>
              Sign in
            </Button>
          )}
        </div>
        <Separator />
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}

function NavLink({ to, label, active }: { to: "/" | "/traces"; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      className={
        "rounded-md px-3 py-1.5 text-sm " +
        (active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")
      }
    >
      {label}
    </Link>
  );
}