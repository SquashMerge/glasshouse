import "@testing-library/jest-dom/vitest";
import { JSDOM } from "jsdom";

if (typeof window === "undefined" || typeof document === "undefined") {
	const dom = new JSDOM("<!doctype html><html><body></body></html>", {
		url: "http://localhost/",
	});
	const { window } = dom;

	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Node: window.Node,
		Storage: window.Storage,
		localStorage: window.localStorage,
		sessionStorage: window.sessionStorage,
		getComputedStyle: window.getComputedStyle.bind(window),
		DOMParser: window.DOMParser,
		MutationObserver: window.MutationObserver,
		CustomEvent: window.CustomEvent,
		Event: window.Event,
		KeyboardEvent: window.KeyboardEvent,
		InputEvent: window.InputEvent,
		requestAnimationFrame: (callback: FrameRequestCallback) =>
			setTimeout(() => callback(Date.now()), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
	});
}
