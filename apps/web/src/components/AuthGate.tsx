// AuthGate — wraps protected routes. Checks localStorage on mount, redirects
// to /login if absent. Renders children otherwise.

import * as React from "react";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { getCredentials } from "../lib/auth";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    const creds = getCredentials();
    if (!creds) {
      navigate({ to: "/login" });
    } else {
      setReady(true);
    }
  }, [navigate]);

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground">
        Checking session…
      </div>
    );
  }
  return <>{children}</>;
}