import { afterEach, describe, expect, it, vi } from "vitest";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../../src/components/ui/dropdown-menu";

const rect = {
	x: 0,
	y: 700,
	width: 36,
	height: 36,
	top: 700,
	bottom: 736,
	left: 0,
	right: 36,
	toJSON: () => ({}),
} as DOMRect;

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("DropdownMenu positioning", () => {
	it("repositions an open menu when asynchronous content grows", () => {
		const callbacks: ResizeObserverCallback[] = [];
		class MockResizeObserver {
			constructor(callback: ResizeObserverCallback) {
				callbacks.push(callback);
			}
			observe() {}
			disconnect() {}
			unobserve() {}
		}
		vi.stubGlobal("ResizeObserver", MockResizeObserver);
		vi.stubGlobal("innerHeight", 800);
		vi.stubGlobal("innerWidth", 375);

		render(
			<DropdownMenu>
				<DropdownMenuTrigger>Current project</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					<DropdownMenuItem>Loading projects...</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		);

		const trigger = screen.getByRole("button", { name: "Current project" });
		vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect);
		fireEvent.click(trigger);

		const menu = screen.getByRole("menu");
		let menuHeight = 80;
		Object.defineProperty(menu, "offsetHeight", {
			configurable: true,
			get: () => menuHeight,
		});
		act(() => {
			callbacks[0]?.([], {} as ResizeObserver);
		});
		expect(menu).toHaveStyle({ top: "614px" });

		menuHeight = 300;
		act(() => {
			callbacks[0]?.([], {} as ResizeObserver);
		});
		expect(menu).toHaveStyle({ top: "394px" });
	});
});
