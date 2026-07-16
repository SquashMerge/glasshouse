import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const selection = vi.hoisted(() => ({ selectProject: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("../../src/components/ProjectProvider", () => ({
  useProjectSelection: () => ({
    projects: [{ id: "11111111-1111-4111-8111-111111111111", name: "Project One", slug: "project-one", created_at: "2026-07-15T10:00:00.000Z" }],
    selectedProjectId: "11111111-1111-4111-8111-111111111111",
    isLoading: false,
    error: null,
    selectProject: selection.selectProject,
    retry: vi.fn(),
  }),
}));

import { AppShell } from "../../src/components/AppShell";
import { setCredentials } from "../../src/lib/auth";

describe("AppShell project selector", () => {
  beforeEach(() => {
    window.localStorage.clear();
    selection.selectProject.mockReset();
  });

  afterEach(cleanup);

  it("exposes the selected authenticated project and Prompts navigation", () => {
    render(<AppShell currentPath="/prompts"><div>Page</div></AppShell>);

    const selector = screen.getByLabelText("Selected project");
    expect(selector).toHaveValue("11111111-1111-4111-8111-111111111111");
    expect(screen.getByRole("link", { name: "Prompts" })).toHaveAttribute("href", "/prompts");
    fireEvent.change(selector, { target: { value: "11111111-1111-4111-8111-111111111111" } });
    expect(selection.selectProject).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("links Settings from the signed-in user menu", () => {
    setCredentials("admin", "secret");
    render(<AppShell currentPath="/prompts"><div>Page</div></AppShell>);

    fireEvent.click(screen.getByRole("button", { name: /admin/i }));
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });
});
