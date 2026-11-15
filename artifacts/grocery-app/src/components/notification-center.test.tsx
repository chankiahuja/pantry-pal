import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { MockPantryApi } from "../mocks/pantry-api";
import { getGetGrocerySuggestionsQueryKey } from "@workspace/api-client-react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard",
});
for (const key of [
  "window", "document", "navigator", "location", "history", "HTMLElement",
  "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent",
  "KeyboardEvent", "MutationObserver", "getComputedStyle", "localStorage",
] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === "window" ? dom.window : dom.window[key],
  });
}
Object.defineProperty(globalThis, "React", { configurable: true, value: React });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  writable: true,
  value: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Router } = await import("wouter");
const { memoryLocation } = await import("wouter/memory-location");
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { NotificationCenter } = await import("./notification-center");
const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  localStorage.clear();
});
async function renderNotifications(api: MockPantryApi | null, fetchOverride?: typeof fetch) {
  globalThis.fetch = fetchOverride ?? api!.fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const location = memoryLocation({ path: "/dashboard" });
  render(
    <QueryClientProvider client={client}>
      <Router hook={location.hook}>
        <NotificationCenter />
      </Router>
    </QueryClientProvider>,
  );
  return { client };
}

async function openNotifications(api: MockPantryApi) {
  const result = await renderNotifications(api);
  await act(async () => {
    fireEvent.click(screen.getByTestId("notification-bell"));
  });
  return result;
}

describe("NotificationCenter", { concurrency: false }, () => {
  it("shows one total for deduplicated alerts and keeps the email note outside counts", async () => {
    const api = new MockPantryApi();
    const suggestions = await (await api.fetch("/api/suggestions")).json() as unknown[];
    await openNotifications(api);

    await screen.findByText(suggestions.length + " items need attention");
    assert.ok(screen.getByRole("heading", { name: "Email reminders — coming later" }));
    assert.ok(screen.getByText("Expiry reminders by email are planned for a future release. Check your alerts here for now."));
  });

  it("shows a numeric unread badge, then a persistent dot after opening", async () => {
    const api = new MockPantryApi();
    await renderNotifications(api);
    const bell = await screen.findByTestId("notification-bell");
    await waitFor(() => assert.match(bell.getAttribute("aria-label") ?? "", /unread/));
    assert.ok(bell.querySelector("span"));

    fireEvent.click(bell);
    await screen.findByTestId("notification-panel");
    await waitFor(() => assert.match(bell.getAttribute("aria-label") ?? "", /no unread alerts/));
    assert.equal(bell.querySelector("span")?.textContent, "");
  });

  it("retains read state across remounts and makes new identities unread", async () => {
    const api = new MockPantryApi();
    await openNotifications(api);
    const bell = screen.getByTestId("notification-bell");
    await waitFor(() => assert.match(bell.getAttribute("aria-label") ?? "", /no unread alerts/));
    cleanup();

    await renderNotifications(api);
    const remountedBell = await screen.findByTestId("notification-bell");
    await waitFor(() => assert.match(remountedBell.getAttribute("aria-label") ?? "", /no unread alerts/));

    api.state.inventory[0] = { ...api.state.inventory[0], quantity: 1, minThreshold: 2 };
    cleanup();
    await renderNotifications(api);
    const changedBell = await screen.findByTestId("notification-bell");
    await waitFor(() => assert.match(changedBell.getAttribute("aria-label") ?? "", /unread/));
  });

  it("keeps combined-condition items as one rendered row", async () => {
    const api = new MockPantryApi();
    await openNotifications(api);
    await screen.findByText("Spinach");
    assert.equal(screen.getAllByText("Spinach").length, 1);
  });

  it("has distinct healthy, loading, and initial-error states", async () => {
    const healthy = new MockPantryApi();
    healthy.state.inventory = [];
    await openNotifications(healthy);
    assert.ok(await screen.findByText("All caught up!"));
    assert.equal(screen.getByTestId("notification-bell").getAttribute("aria-label"), "Notifications: no items need attention");
    cleanup();

    const pending = new Promise<Response>(() => {});
    await renderNotifications(null, async () => pending);
    fireEvent.click(screen.getByTestId("notification-bell"));
    assert.ok(screen.getByRole("status", { name: "Loading alerts" }));

    cleanup();
    await renderNotifications(null, async () => new Response("failed", { status: 503 }));
    fireEvent.click(screen.getByTestId("notification-bell"));
    assert.ok(await screen.findByRole("alert"));
    assert.equal(screen.queryByText("All caught up!"), null);
  });

  it("retries an initial failure without turning it into a healthy state", async () => {
    const api = new MockPantryApi();
    let failed = true;
    const fetchOverride: typeof fetch = async (input, init) => {
      if (failed) return new Response("failed", { status: 503 });
      return api.fetch(input, init);
    };
    await renderNotifications(null, fetchOverride);
    fireEvent.click(screen.getByTestId("notification-bell"));
    await screen.findByRole("alert");
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/items need attention/);
    assert.equal(screen.queryByText("All caught up!"), null);
  });

  it("keeps rows and counts available for background refresh errors", async () => {
    const api = new MockPantryApi();
    let failed = false;
    const fetchOverride: typeof fetch = async (input, init) => {
      if (failed && String(input).includes("/api/suggestions")) return new Response("failed", { status: 503 });
      return api.fetch(input, init);
    };
    const { client } = await renderNotifications(null, fetchOverride);
    fireEvent.click(screen.getByTestId("notification-bell"));
    await screen.findByText("Olive oil");
    failed = true;
    await act(async () => {
      await client.refetchQueries({ queryKey: getGetGrocerySuggestionsQueryKey() });
    });
    assert.ok(screen.getByText("Olive oil"));
    assert.ok(screen.getByText(/could not be refreshed/));
  });

  it("keeps close, Escape, links, and accessible state labels working", async () => {
    const api = new MockPantryApi();
    await openNotifications(api);
    const close = screen.getByRole("button", { name: "Close notifications" });
    fireEvent.click(close);
    assert.equal(screen.queryByTestId("notification-panel"), null);
    assert.equal(document.activeElement, screen.getByTestId("notification-bell"));

    fireEvent.click(screen.getByTestId("notification-bell"));
    fireEvent.keyDown(document, { key: "Escape" });
    assert.equal(screen.queryByTestId("notification-panel"), null);
    assert.equal(document.activeElement, screen.getByTestId("notification-bell"));
  });
});
