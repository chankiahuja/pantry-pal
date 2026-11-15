import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { MockPantryApi } from "../mocks/pantry-api";
import { getGetGrocerySuggestionsQueryKey } from "@workspace/api-client-react";
import { notificationIdentity } from "@/lib/notification-alerts";

const storageKey = (demo: boolean, accountId?: number | string | null) =>
  `pantrypal-seen-notifications:${demo ? "demo" : accountId ?? "anonymous"}`;

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
    assert.ok(screen.getByText("Olive oil"));
    assert.ok(screen.getByText(/items need attention/));
    await waitFor(() => assert.match(bell.getAttribute("aria-label") ?? "", /no unread alerts/));
    assert.equal(bell.querySelector("span")?.textContent, "");
  });

  it("uses singular and plural unresolved-count copy", async () => {
    const api = new MockPantryApi();
    api.state.inventory = [api.state.inventory.find((item) => item.name === "Milk")!];
    await renderNotifications(api);
    const singularBell = await screen.findByTestId("notification-bell");
    await waitFor(() => assert.equal(
      singularBell.getAttribute("aria-label"),
      "Notifications: 1 unread; 1 item needs attention",
    ));
    fireEvent.click(singularBell);
    assert.ok(await screen.findByText("1 item needs attention"));
    await waitFor(() => assert.equal(
      singularBell.getAttribute("aria-label"),
      "Notifications: no unread alerts; 1 item needs attention",
    ));

    cleanup();
    api.state.inventory = [
      api.state.inventory[0],
      { ...api.state.inventory[0], id: 101, name: "Second milk" },
    ];
    await renderNotifications(api);
    const pluralBell = await screen.findByTestId("notification-bell");
    await waitFor(() => assert.equal(
      pluralBell.getAttribute("aria-label"),
      "Notifications: 1 unread; 2 items need attention",
    ));
    fireEvent.click(pluralBell);
    assert.ok(await screen.findByText("2 items need attention"));
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

  it("does not make an unchanged refetch unread again and makes a recurrence unread", async () => {
    const api = new MockPantryApi();
    api.state.inventory = [api.state.inventory.find((item) => item.name === "Milk")!];
    const { client } = await openNotifications(api);
    const bell = screen.getByTestId("notification-bell");
    await waitFor(() => assert.match(bell.getAttribute("aria-label") ?? "", /no unread alerts/));

    await client.refetchQueries({ queryKey: getGetGrocerySuggestionsQueryKey() });
    await waitFor(() => assert.match(bell.getAttribute("aria-label") ?? "", /no unread alerts/));

    api.state.inventory = [];
    await client.refetchQueries({ queryKey: getGetGrocerySuggestionsQueryKey() });
    await screen.findByText("All caught up!");
    api.state.inventory = [api.state.inventory.find(() => false) ?? { ...new MockPantryApi().state.inventory[0] }];
    await client.refetchQueries({ queryKey: getGetGrocerySuggestionsQueryKey() });
    await waitFor(() => assert.match(bell.getAttribute("aria-label") ?? "", /unread/));
  });

  it("updates unresolved totals as conditions resolve, retaining then removing the dot", async () => {
    const api = new MockPantryApi();
    api.state.inventory = [
      api.state.inventory.find((item) => item.name === "Milk")!,
      { ...api.state.inventory.find((item) => item.name === "Milk")!, id: 102, name: "Second milk" },
    ];
    const { client } = await openNotifications(api);
    const bell = screen.getByTestId("notification-bell");
    await screen.findByText("2 items need attention");
    api.state.inventory = [api.state.inventory[0]];
    await client.refetchQueries({ queryKey: getGetGrocerySuggestionsQueryKey() });
    await waitFor(() => assert.ok(screen.getByText("1 item needs attention")));
    assert.match(bell.getAttribute("aria-label") ?? "", /no unread alerts/);
    assert.ok(bell.querySelector("span"));
    api.state.inventory = [];
    await client.refetchQueries({ queryKey: getGetGrocerySuggestionsQueryKey() });
    await screen.findByText("All caught up!");
    assert.equal(bell.getAttribute("aria-label"), "Notifications: no items need attention");
    assert.equal(bell.querySelector("span"), null);
  });

  it("keeps account, demo, and anonymous read markers isolated", () => {
    const anonymous = storageKey(false);
    const accountA = storageKey(false, "a");
    const accountB = storageKey(false, "b");
    const demo = storageKey(true);
    assert.equal(new Set([anonymous, accountA, accountB, demo]).size, 4);
    const marker = notificationIdentity({
      inventoryItemId: 1,
      name: "Milk",
      category: "Dairy",
      currentQuantity: 0,
      minThreshold: 2,
      unit: "litres",
      urgency: "critical",
      reason: "Out of stock",
    });
    localStorage.setItem(accountA, JSON.stringify([marker]));
    assert.equal(localStorage.getItem(accountB), null);
    assert.equal(localStorage.getItem(demo), null);
    assert.equal(localStorage.getItem(anonymous), null);
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

  it("does not prune read markers during an initial failure", async () => {
    const api = new MockPantryApi();
    const suggestions = await (await api.fetch("/api/suggestions")).json() as Array<{ inventoryItemId: number; urgency: string; reason: string }>;
    const marker = `${suggestions[0].inventoryItemId}::${suggestions[0].urgency}::${suggestions[0].reason}`;
    localStorage.setItem(storageKey(false), JSON.stringify([marker]));
    let failed = true;
    const fetchOverride: typeof fetch = async (input, init) => {
      if (failed) return new Response("failed", { status: 503 });
      return api.fetch(input, init);
    };
    await renderNotifications(null, fetchOverride);
    fireEvent.click(screen.getByTestId("notification-bell"));
    await screen.findByRole("alert");
    assert.deepEqual(JSON.parse(localStorage.getItem(storageKey(false))!), [marker]);
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => assert.match(screen.getByTestId("notification-bell").getAttribute("aria-label") ?? "", /no unread alerts/));
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
    await waitFor(() => assert.match(screen.getByTestId("notification-bell").getAttribute("aria-label") ?? "", /no unread alerts/));
    assert.ok(screen.getByRole("link", { name: "Olive oil" }).getAttribute("href")?.includes("item=9"));
    fireEvent.keyDown(document, { key: "Escape" });
    assert.equal(screen.queryByTestId("notification-panel"), null);
    assert.equal(document.activeElement, screen.getByTestId("notification-bell"));
  });

  it("keeps current-session behaviour when localStorage is corrupt or write-blocked", async () => {
    localStorage.setItem(storageKey(false), "not-json");
    const api = new MockPantryApi();
    await renderNotifications(api);
    const bell = await screen.findByTestId("notification-bell");
    await waitFor(() => assert.match(bell.getAttribute("aria-label") ?? "", /unread/));

    const originalSetItem = localStorage.setItem.bind(localStorage);
    Object.defineProperty(localStorage, "setItem", { configurable: true, value: () => { throw new Error("blocked"); } });
    fireEvent.click(bell);
    await screen.findByText("Olive oil");
    await waitFor(() => assert.match(bell.getAttribute("aria-label") ?? "", /no unread alerts/));
    Object.defineProperty(localStorage, "setItem", { configurable: true, value: originalSetItem });
  });

  it("shows an exact accessible unread count when the visual badge is 9+", async () => {
    const api = new MockPantryApi();
    api.state.inventory = Array.from({ length: 10 }, (_, index) => ({
      ...api.state.inventory[0],
      id: 200 + index,
      name: "Alert " + index,
      quantity: 0,
    }));
    await renderNotifications(api);
    const bell = await screen.findByTestId("notification-bell");
    await waitFor(() => assert.equal(bell.getAttribute("aria-label"), "Notifications: 10 unread; 10 items need attention"));
    assert.equal(bell.textContent?.includes("9+"), true);
  });
});
