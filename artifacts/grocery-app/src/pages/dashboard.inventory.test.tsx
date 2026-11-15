import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import { authFeatures } from "../lib/auth-features";
import React from "react";
import { MockPantryApi } from "../mocks/pantry-api";
import { JSDOM } from "jsdom";
import type { AuthSession, InventoryItem, ShoppingListWithItems } from "@workspace/api-client-react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});

Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  location: { configurable: true, value: dom.window.location },
  history: { configurable: true, value: dom.window.history },
  React: { configurable: true, value: React },
  addEventListener: {
    configurable: true,
    value: dom.window.addEventListener.bind(dom.window),
  },
  removeEventListener: {
    configurable: true,
    value: dom.window.removeEventListener.bind(dom.window),
  },
  dispatchEvent: {
    configurable: true,
    value: dom.window.dispatchEvent.bind(dom.window),
  },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  HTMLInputElement: { configurable: true, value: dom.window.HTMLInputElement },
  HTMLButtonElement: {
    configurable: true,
    value: dom.window.HTMLButtonElement,
  },
  HTMLSelectElement: {
    configurable: true,
    value: dom.window.HTMLSelectElement,
  },
  HTMLTextAreaElement: {
    configurable: true,
    value: dom.window.HTMLTextAreaElement,
  },
  Element: { configurable: true, value: dom.window.Element },
  Node: { configurable: true, value: dom.window.Node },
  Event: { configurable: true, value: dom.window.Event },
  MouseEvent: { configurable: true, value: dom.window.MouseEvent },
  CustomEvent: { configurable: true, value: dom.window.CustomEvent },
  KeyboardEvent: { configurable: true, value: dom.window.KeyboardEvent },
  NodeFilter: { configurable: true, value: dom.window.NodeFilter },
  MutationObserver: { configurable: true, value: dom.window.MutationObserver },
  getComputedStyle: { configurable: true, value: dom.window.getComputedStyle },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true },
});

dom.window.HTMLElement.prototype.scrollIntoView = () => {};

// Initialize browser-sensitive dependencies only after JSDOM is installed.
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Route, Router, Switch } = await import("wouter");
const { memoryLocation } = await import("wouter/memory-location");
const {
  getGetInventoryItemQueryKey,
  getGetGrocerySuggestionsQueryKey,
  getGetInventoryStatsQueryKey,
  getGetShoppingListQueryKey,
  getListInventoryItemsQueryKey,
  getListShoppingListsQueryKey,
} = await import("@workspace/api-client-react");
const { act, cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { useToast } = await import("../hooks/use-toast");
const { LoginGate, useSessionAccess } = await import("../lib/preview-access");
const [
  { default: Dashboard },
  { default: Inventory },
  { default: ShoppingLists },
  { default: ShoppingListDetail },
  { PreviewAuth: Auth },
  { AppRoutes },
] = await Promise.all([
  import("./dashboard"),
  import("./inventory"),
  import("./shopping-lists"),
  import("./shopping-list-detail"),
  import("./auth"),
  import("../App"),
]);
const originalFetch = globalThis.fetch;
const clients = new Set<InstanceType<typeof QueryClient>>();
function createQueryClient(options?: ConstructorParameters<typeof QueryClient>[0]) {
  const client = new QueryClient({
    ...options,
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, ...options?.defaultOptions?.queries },
      mutations: { retry: false, gcTime: Infinity, ...options?.defaultOptions?.mutations },
    },
  });
  clients.add(client);
  return client;
}
const timestamp = "2026-10-26T12:00:00.000Z";

function dashboardItem(
  id: number,
  name: string,
  category: string,
  quantity: number,
  minThreshold: number,
  expiresInDays: number | null = null,
): InventoryItem {
  const expiresAt =
    expiresInDays === null
      ? null
      : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);

  return {
    id,
    name,
    category,
    quantity,
    unit: "each",
    minThreshold,
    expiresAt,
    notes: null,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

class GroceryApiMock {
  items: InventoryItem[] = [];
  inventoryCreateBodies: Record<string, unknown>[] = [];
  inventoryCreateMode: "normal" | "pending" | "error" = "normal";
  private pendingCreates: Array<{
    resolve: () => void;
    reject: () => void;
  }> = [];
  resolvePendingCreate: (() => void) | null = null;
  rejectPendingCreate: (() => void) | null = null;
  inventoryUpdateBodies: Record<string, unknown>[] = [];
  inventoryPatchMode: "normal" | "pending" | "error" | "missing" = "normal";
  resolveInventoryPatch: (() => void) | null = null;
  inventoryItemGetCount = 0;
  restockInventoryItem(id: number, amount: number) {
    this.items = this.items.map((item) => item.id === id ? { ...item, quantity: item.quantity + amount, revision: item.revision + 1 } : item);
  }
  inventoryGetMode: "normal" | "pending" | "error" = "normal";
  resolvePendingInventory: (() => void) | null = null;
  inventoryItemGetMode: "normal" | "pending" | "error" = "normal";
  resolveInventoryItemGet: (() => void) | null = null;
  shoppingList: ShoppingListWithItems = {
    id: 1,
    name: "Weekly shop",
    items: [
      {
        id: 1,
        shoppingListId: 1,
        inventoryItemId: 1,
        name: "Rice",
        category: "Pantry",
        quantity: 5,
        unit: "bags",
        purchased: true,
        notes: null,
      },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  generatedShoppingList: ShoppingListWithItems | null = null;
  private nextInventoryId = 1;

  private refreshPendingCreateControls() {
    if (this.pendingCreates.length === 0) {
      this.resolvePendingCreate = null;
      this.rejectPendingCreate = null;
      return;
    }

    this.resolvePendingCreate = () => {
      this.pendingCreates.shift()?.resolve();
      this.refreshPendingCreateControls();
    };
    this.rejectPendingCreate = () => {
      this.pendingCreates.shift()?.reject();
      this.refreshPendingCreateControls();
    };
  }

  readonly fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input.toString(),
      "http://localhost",
    );
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.pathname === "/api/inventory" && method === "GET") {
      if (this.inventoryGetMode === "error") {
        return this.json({ error: "Inventory unavailable" }, 500);
      }
      if (this.inventoryGetMode === "pending") {
        return new Promise<Response>((resolve, reject) => {
          this.resolvePendingInventory = () => {
            this.resolvePendingInventory = null;
            resolve(this.json([...this.items]));
          };
          const signal = init?.signal;
          const abort = () =>
            reject(new DOMException("Request aborted", "AbortError"));
          if (signal?.aborted) {
            abort();
          } else {
            signal?.addEventListener("abort", abort, { once: true });
          }
        });
      }

      let items = [...this.items];
      if (url.searchParams.get("lowStock") === "true") {
        items = items.filter(
          (item) => item.quantity > 0 && item.quantity <= item.minThreshold,
        );
      }
      if (url.searchParams.get("outOfStock") === "true") {
        items = items.filter((item) => item.quantity === 0);
      }
      return this.json(items);
    }

    if (url.pathname === "/api/inventory" && method === "POST") {
      const input = this.readBody(init);
      this.inventoryCreateBodies.push(input);
      const createItem = () => {
        if (this.inventoryCreateMode === "error") {
          return this.json({ error: "Inventory unavailable" }, 500);
        }
        const item: InventoryItem = {
          id: this.nextInventoryId++,
          name: String(input.name),
          category: String(input.category),
          quantity: Number(input.quantity),
          unit: String(input.unit),
          minThreshold: Number(input.minThreshold),
          expiresAt: input.expiresAt ? String(input.expiresAt) : null,
          notes: input.notes ? String(input.notes) : null,
          revision: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        this.items.push(item);
        return this.json(item, 201);
      };
      if (this.inventoryCreateMode === "pending") {
        return new Promise<Response>((resolve, reject) => {
          const pending = {
            resolve: () => resolve(createItem()),
            reject: () => reject(new Error("Inventory request rejected")),
          };
          this.pendingCreates.push(pending);
          this.refreshPendingCreateControls();
        });
      }
      return createItem();
    }

    if (url.pathname === "/api/inventory/stats" && method === "GET") {
      const today = new Date().toISOString().slice(0, 10);
      const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      return this.json({
        totalItems: this.items.length,
        lowStockCount: this.items.filter(
          (item) => item.quantity > 0 && item.quantity <= item.minThreshold,
        ).length,
        outOfStockCount: this.items.filter((item) => item.quantity === 0)
          .length,
        expiringCount: this.items.filter(
          (item) =>
            item.expiresAt != null &&
            item.expiresAt >= today &&
            item.expiresAt <= sevenDaysFromNow,
        ).length,
        categoryBreakdown: [],
      });
    }

    const inventoryItemMatch = url.pathname.match(/^\/api\/inventory\/(\d+)$/);
    if (inventoryItemMatch && method === "GET") {
      this.inventoryItemGetCount++;
      const getItem = () => {
        if (this.inventoryItemGetMode === "error") {
          return this.json({ error: "Inventory unavailable" }, 500);
        }
        const item = this.items.find((candidate) => candidate.id === Number(inventoryItemMatch[1]));
        return item ? this.json({ ...item }) : this.json({ error: "Item not found" }, 404);
      };
      if (this.inventoryItemGetMode === "pending") {
        return new Promise<Response>((resolve) => {
          this.resolveInventoryItemGet = () => {
            this.resolveInventoryItemGet = null;
            resolve(getItem());
          };
        });
      }
      return getItem();
    }
    if (inventoryItemMatch && method === "PATCH") {
      const id = Number(inventoryItemMatch[1]);
      const update = this.readBody(init);
      this.inventoryUpdateBodies.push(update);
      if (this.inventoryPatchMode === "pending") await new Promise<void>((resolve) => { this.resolveInventoryPatch = resolve; });
      if (this.inventoryPatchMode === "error") return this.json({ error: "Save unavailable" }, 500);
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item || this.inventoryPatchMode === "missing") return this.json({ error: "Item not found" }, 404);
      if (!Number.isSafeInteger(update.revision) || update.revision !== item.revision) {
        return this.json({ error: "Inventory item was modified; review the latest values before saving" }, 409);
      }
      const { revision: _revision, ...changes } = update;
      Object.assign(item, changes, { revision: item.revision + 1, updatedAt: timestamp });
      return this.json(item);
    }
    if (inventoryItemMatch && method === "DELETE") {
      const id = Number(inventoryItemMatch[1]);
      this.items = this.items.filter((item) => item.id !== id);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/api/suggestions" && method === "GET") {
      return this.json(
        this.items.flatMap((item) => {
          if (item.quantity === 0) {
            return [
              {
                inventoryItemId: item.id,
                name: item.name,
                category: item.category,
                currentQuantity: item.quantity,
                minThreshold: item.minThreshold,
                unit: item.unit,
                reason: "Out of stock",
                urgency: "critical",
              },
            ];
          }
          if (item.quantity <= item.minThreshold) {
            return [
              {
                inventoryItemId: item.id,
                name: item.name,
                category: item.category,
                currentQuantity: item.quantity,
                minThreshold: item.minThreshold,
                unit: item.unit,
                reason: `${item.quantity} ${item.unit} left`,
                urgency: "low",
              },
            ];
          }
          return [];
        }),
      );
    }

    if (
      url.pathname === "/api/suggestions/generate-list" &&
      method === "POST"
    ) {
      const suggestedItems = this.items.filter(
        (item) => item.quantity === 0 || item.quantity <= item.minThreshold,
      );
      if (suggestedItems.length === 0) {
        return this.json(
          { error: "No low-stock suggestions are available." },
          400,
        );
      }
      this.generatedShoppingList = {
        id: 2,
        name: "Low-stock shopping list",
        items: suggestedItems.map((item, index) => ({
          id: index + 2,
          shoppingListId: 2,
          inventoryItemId: item.id,
          name: item.name,
          category: item.category,
          quantity: Math.max(item.minThreshold - item.quantity, 1),
          unit: item.unit,
          purchased: false,
          notes:
            item.quantity === 0
              ? "Out of stock"
              : `${item.quantity} ${item.unit} left`,
        })),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return this.json(this.generatedShoppingList, 201);
    }

    if (url.pathname === "/api/shopping-lists" && method === "GET") {
      const lists = [
        {
          id: this.shoppingList.id,
          name: this.shoppingList.name,
          itemCount: this.shoppingList.items.length,
          purchasedCount: this.shoppingList.items.filter(
            (item) => item.purchased,
          ).length,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ];
      if (this.generatedShoppingList) {
        lists.push({
          id: this.generatedShoppingList.id,
          name: this.generatedShoppingList.name,
          itemCount: this.generatedShoppingList.items.length,
          purchasedCount: this.generatedShoppingList.items.filter(
            (item) => item.purchased,
          ).length,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      return this.json(lists);
    }

    const requestedShoppingListId = Number(
      url.pathname.match(/^\/api\/shopping-lists\/(\d+)$/)?.[1],
    );
    if (method === "GET" && requestedShoppingListId) {
      const list =
        requestedShoppingListId === this.shoppingList.id
          ? this.shoppingList
          : requestedShoppingListId === this.generatedShoppingList?.id
            ? this.generatedShoppingList
            : null;
      if (list) return this.json(list);
    }

    const itemUpdateMatch = url.pathname.match(
      /^\/api\/shopping-lists\/(\d+)\/items\/(\d+)$/,
    );
    if (itemUpdateMatch && method === "PATCH") {
      const list =
        Number(itemUpdateMatch[1]) === this.generatedShoppingList?.id
          ? this.generatedShoppingList
          : null;
      const item = list?.items.find(
        (candidate) => candidate.id === Number(itemUpdateMatch[2]),
      );
      if (!list || !item) return this.json({ error: "Item not found" }, 404);
      Object.assign(item, this.readBody(init));
      return this.json(item);
    }

    const purchaseMatch = url.pathname.match(
      /^\/api\/shopping-lists\/(\d+)\/purchase$/,
    );
    if (purchaseMatch && method === "POST") {
      const list =
        Number(purchaseMatch[1]) === this.shoppingList.id
          ? this.shoppingList
          : Number(purchaseMatch[1]) === this.generatedShoppingList?.id
            ? this.generatedShoppingList
            : null;
      if (!list) return this.json({ error: "List not found" }, 404);
      let updatedInventoryItems = 0;
      const purchasedItems = list.items.filter(
        (item) => item.purchased && item.inventoryItemId !== null,
      );
      for (const shoppingItem of purchasedItems) {
        const inventoryItem = this.items.find(
          (item) => item.id === shoppingItem.inventoryItemId,
        );
        if (!inventoryItem) continue;
        inventoryItem.quantity += shoppingItem.quantity;
        updatedInventoryItems += 1;
      }
      return this.json({
        purchasedCount: purchasedItems.length,
        updatedInventoryItems,
      });
    }

    return this.json(
      { error: `Unhandled mock request: ${method} ${url.pathname}` },
      404,
    );
  };

  private readBody(init?: RequestInit): Record<string, unknown> {
    return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  }

  private json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function renderApp(path = "/dashboard") {
  const location = memoryLocation({ path });
  const queryClient = createQueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });

  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <Router hook={location.hook}>
          <Switch>
            <Route path="/login" component={Auth} />
            <Route path="/signup" component={Auth} />
            <Route path="/dashboard" component={Dashboard} />
            <Route path="/inventory" component={Inventory} />
            <Route path="/shopping-lists" component={ShoppingLists} />
            <Route path="/shopping-lists/:id" component={ShoppingListDetail} />
          </Switch>
        </Router>
      </QueryClientProvider>,
    ),
  };
}

describe("inventory save and continue", () => {
  it("advances both pending create controls through every queued settlement", async () => {
    const api = new GroceryApiMock();
    api.inventoryCreateMode = "pending";
    const requests = [1, 2, 3].map((id) =>
      api.fetch("/api/inventory", {
        method: "POST",
        body: JSON.stringify({
          name: `Item ${id}`,
          category: "Pantry",
          quantity: 1,
          unit: "each",
          minThreshold: 0,
        }),
      }),
    );

    assert.equal(api.inventoryCreateBodies.length, 3);
    api.resolvePendingCreate?.();
    api.rejectPendingCreate?.();
    api.resolvePendingCreate?.();

    const results = await Promise.allSettled(requests);
    assert.equal(results[0]?.status, "fulfilled");
    assert.equal(results[1]?.status, "rejected");
    assert.equal(results[2]?.status, "fulfilled");
    assert.equal(api.items.length, 2);
    assert.equal(api.resolvePendingCreate, null);
    assert.equal(api.rejectPendingCreate, null);
  });

  it("keeps create mode open, preserves category and custom unit, resets the draft, and focuses Name", async () => {
    const api = new GroceryApiMock();
    globalThis.fetch = api.fetch;
    renderApp();

    await screen.findByText("Your pantry is in good shape.");
    await openInventory();
    fireEvent.click(screen.getByTestId("button-add-item"));
    await screen.findByTestId("input-item-name");
    changeInput("input-item-name", "Milk");
    changeInput("input-item-category", "Dairy");
    changeInput("input-item-quantity", "1.5");
    changeInput("input-item-custom-unit", "bottles");
    changeInput("input-item-threshold", "6");
    changeInput("input-item-expires", "2026-12-01");
    changeInput("input-item-notes", "Keep cold");

    fireEvent.click(screen.getByTestId("button-save-and-add-another"));
    await waitFor(() => assert.equal(api.items.length, 1));

    assert.ok(screen.getByTestId("dialog-inventory-item"));
    assert.equal((screen.getByTestId("input-item-name") as HTMLInputElement).value, "");
    assert.equal((screen.getByTestId("input-item-category") as HTMLInputElement).value, "Dairy");
    assert.equal((screen.getByTestId("input-item-custom-unit") as HTMLInputElement).value, "bottles");
    assert.equal((screen.getByTestId("input-item-quantity") as HTMLInputElement).value, "0");
    assert.equal((screen.getByTestId("input-item-threshold") as HTMLInputElement).value, "0");
    assert.equal((screen.getByTestId("input-item-expires") as HTMLInputElement).value, "");
    assert.equal((screen.getByTestId("input-item-notes") as HTMLTextAreaElement).value, "");
    assert.equal(document.activeElement, screen.getByTestId("input-item-name"));

    changeInput("input-item-name", "Yogurt");
    fireEvent.change(screen.getByTestId("input-item-unit"), { target: { value: "pack" } });
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.equal(api.items.length, 2));
    assert.equal(screen.queryByTestId("dialog-inventory-item"), null);
    assert.equal(api.items[1]?.name, "Yogurt");
    assert.equal(api.items[1]?.category, "Dairy");
    assert.equal(api.items[1]?.unit, "pack");

    await openInventory();
    fireEvent.click(screen.getByTestId("button-edit-1"));
    await screen.findByTestId("dialog-inventory-item");
    assert.equal(screen.queryByTestId("button-save-and-add-another"), null);
  });

  it("preserves the draft after a failed save and allows retry", async () => {
    const api = new GroceryApiMock();
    api.inventoryCreateMode = "error";
    globalThis.fetch = api.fetch;
    renderApp();

    await screen.findByText("Your pantry is in good shape.");
    await openInventory();
    fireEvent.click(screen.getByTestId("button-add-item"));
    await screen.findByTestId("input-item-name");
    changeInput("input-item-name", "Rice");
    changeInput("input-item-category", "Pantry");
    changeInput("input-item-custom-unit", "bags");
    changeInput("input-item-quantity", "2");
    changeInput("input-item-threshold", "1");

    fireEvent.click(screen.getByTestId("button-save-and-add-another"));
    await waitFor(() => assert.equal(api.inventoryCreateBodies.length, 1));
    await waitFor(() => assert.equal((screen.getByTestId("button-save-and-add-another") as HTMLButtonElement).disabled, false));
    assert.equal(api.items.length, 0);
    assert.equal((screen.getByTestId("input-item-name") as HTMLInputElement).value, "Rice");
    assert.equal((screen.getByTestId("input-item-category") as HTMLInputElement).value, "Pantry");

    api.inventoryCreateMode = "normal";
    fireEvent.click(screen.getByTestId("button-save-and-add-another"));
    await waitFor(() => assert.equal(api.items.length, 1));
    assert.equal((screen.getByTestId("input-item-name") as HTMLInputElement).value, "");
  });

  it("clears the continue intent when validation fails before switching to Save item", async () => {
    const api = new GroceryApiMock();
    globalThis.fetch = api.fetch;
    renderApp();

    await screen.findByText("Your pantry is in good shape.");
    await openInventory();
    fireEvent.click(screen.getByTestId("button-add-item"));
    await screen.findByTestId("input-item-name");
    changeInput("input-item-category", "Pantry");
    changeInput("input-item-custom-unit", "bags");
    changeInput("input-item-quantity", "2");
    changeInput("input-item-threshold", "1");

    fireEvent.click(screen.getByTestId("button-save-and-add-another"));
    await screen.findByText("Name is required");
    assert.equal(api.items.length, 0);

    changeInput("input-item-name", "Rice");
    screen.getByTestId("dialog-inventory-item").querySelector("form")!.requestSubmit();
    await waitFor(() => assert.equal(api.items.length, 1));
    assert.equal(screen.queryByTestId("dialog-inventory-item"), null);
  });

  it("clears the continue intent when quantity validation reports invalid", async () => {
    const api = new GroceryApiMock();
    globalThis.fetch = api.fetch;
    renderApp();

    await screen.findByText("Your pantry is in good shape.");
    await openInventory();
    fireEvent.click(screen.getByTestId("button-add-item"));
    await screen.findByTestId("input-item-name");
    changeInput("input-item-name", "Rice");
    changeInput("input-item-category", "Pantry");
    changeInput("input-item-custom-unit", "bags");
    changeInput("input-item-quantity", "2.56");
    changeInput("input-item-threshold", "1");

    // JSDOM does not implement number-input stepMismatch validation. Exercise
    // the same invalid event that a browser dispatches for step="0.1".
    const quantityInput = screen.getByTestId("input-item-quantity");
    let invalidEvents = 0;
    quantityInput.addEventListener("invalid", () => {
      invalidEvents += 1;
    }, { once: true });
    fireEvent.invalid(quantityInput);
    assert.equal(invalidEvents, 1);
    assert.equal(api.items.length, 0);
    assert.ok(screen.getByTestId("dialog-inventory-item"));

    changeInput("input-item-quantity", "2.5");
    screen.getByTestId("dialog-inventory-item").querySelector("form")!.requestSubmit();
    await waitFor(() => assert.equal(api.items.length, 1));
    assert.equal(screen.queryByTestId("dialog-inventory-item"), null);
  });

  it("preserves the next draft when a dismissed continue save refreshes in the background", async () => {
    const api = new GroceryApiMock();
    api.inventoryCreateMode = "pending";
    globalThis.fetch = api.fetch;
    renderApp();

    await screen.findByText("Your pantry is in good shape.");
    await openInventory();
    fireEvent.click(screen.getByTestId("button-add-item"));
    await screen.findByTestId("input-item-name");
    changeInput("input-item-name", "Old draft");
    changeInput("input-item-category", "Pantry");
    changeInput("input-item-custom-unit", "bags");
    changeInput("input-item-quantity", "2");
    changeInput("input-item-threshold", "1");
    fireEvent.click(screen.getByTestId("button-save-and-add-another"));
    await waitFor(() => assert.equal(api.inventoryCreateBodies.length, 1));

    fireEvent.click(screen.getByTestId("button-cancel"));
    await waitFor(() => assert.equal(screen.queryByTestId("dialog-inventory-item"), null));
    fireEvent.click(screen.getByTestId("button-add-item"));
    await screen.findByTestId("input-item-name");
    changeInput("input-item-name", "New draft");
    changeInput("input-item-category", "Dairy");
    changeInput("input-item-custom-unit", "bottles");
    changeInput("input-item-quantity", "3");
    changeInput("input-item-threshold", "1");
    const focusedInput = screen.getByTestId("input-item-category");
    focusedInput.focus();

    act(() => {
      api.resolvePendingCreate?.();
    });
    await waitFor(() => assert.equal(api.items.length, 1));
    assert.ok(screen.getByTestId("dialog-inventory-item"));
    assert.equal((screen.getByTestId("input-item-name") as HTMLInputElement).value, "New draft");
    assert.equal((screen.getByTestId("input-item-category") as HTMLInputElement).value, "Dairy");
    assert.equal((screen.getByTestId("input-item-custom-unit") as HTMLInputElement).value, "bottles");
    assert.equal(document.activeElement, focusedInput);
  });

  it("ignores a dismissed save error while a reopened draft is submitting", async () => {
    const api = new GroceryApiMock();
    api.inventoryCreateMode = "pending";
    globalThis.fetch = api.fetch;
    renderApp();

    await screen.findByText("Your pantry is in good shape.");
    await openInventory();
    fireEvent.click(screen.getByTestId("button-add-item"));
    await screen.findByTestId("input-item-name");
    changeInput("input-item-name", "Old draft");
    changeInput("input-item-category", "Pantry");
    changeInput("input-item-custom-unit", "bags");
    changeInput("input-item-quantity", "2");
    changeInput("input-item-threshold", "1");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.equal(api.inventoryCreateBodies.length, 1));

    fireEvent.click(screen.getByTestId("button-cancel"));
    await waitFor(() => assert.equal(screen.queryByTestId("dialog-inventory-item"), null));
    fireEvent.click(screen.getByTestId("button-add-item"));
    await screen.findByTestId("input-item-name");
    changeInput("input-item-name", "New draft");
    changeInput("input-item-category", "Dairy");
    changeInput("input-item-custom-unit", "bottles");
    changeInput("input-item-quantity", "3");
    changeInput("input-item-threshold", "1");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.equal(api.inventoryCreateBodies.length, 2));
    const cancelButton = screen.getByTestId("button-cancel");
    cancelButton.focus();
    assert.equal(document.activeElement, cancelButton);

    act(() => {
      api.rejectPendingCreate?.();
    });
    await waitFor(() => assert.ok(screen.getByTestId("dialog-inventory-item")));
    assert.equal((screen.getByTestId("input-item-name") as HTMLInputElement).value, "New draft");
    assert.equal((screen.getByTestId("input-item-category") as HTMLInputElement).value, "Dairy");
    assert.equal((screen.getByTestId("input-item-custom-unit") as HTMLInputElement).value, "bottles");
    assert.equal((screen.getByTestId("button-save-item") as HTMLButtonElement).disabled, true);
    assert.equal(api.resolvePendingCreate !== null, true);
    assert.equal(document.activeElement, cancelButton);

    act(() => {
      api.resolvePendingCreate?.();
    });
    await waitFor(() => assert.equal(api.items.length, 1));
    assert.equal(screen.queryByTestId("dialog-inventory-item"), null);
  });

  it("prevents overlapping create submissions while pending", async () => {
    const api = new GroceryApiMock();
    api.inventoryCreateMode = "pending";
    globalThis.fetch = api.fetch;
    renderApp();

    await screen.findByText("Your pantry is in good shape.");
    await openInventory();
    fireEvent.click(screen.getByTestId("button-add-item"));
    await screen.findByTestId("input-item-name");
    changeInput("input-item-name", "Beans");
    changeInput("input-item-category", "Pantry");
    changeInput("input-item-custom-unit", "cans");
    changeInput("input-item-quantity", "3");
    changeInput("input-item-threshold", "1");

    fireEvent.click(screen.getByTestId("button-save-and-add-another"));
    await waitFor(() => assert.equal(api.inventoryCreateBodies.length, 1));
    assert.equal((screen.getByTestId("button-save-and-add-another") as HTMLButtonElement).disabled, true);
    for (const testId of [
      "input-item-name",
      "input-item-category",
      "input-item-custom-unit",
      "input-item-quantity",
      "input-item-threshold",
    ]) {
      assert.equal((screen.getByTestId(testId) as HTMLInputElement).disabled, true);
    }
    fireEvent.submit(screen.getByTestId("dialog-inventory-item").querySelector("form")!);
    assert.equal(api.inventoryCreateBodies.length, 1);

    api.resolvePendingCreate?.();
    await waitFor(() => assert.equal(api.items.length, 1));
    assert.ok(screen.getByTestId("dialog-inventory-item"));
  });
});

describe("expired inventory attention", () => {
  it("refreshes dashboard attention at UTC midnight without editing inventory", async (context) => {
    context.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-11-08T23:59:50Z") });
    const api = new MockPantryApi();
    api.state.inventory = [dashboardItem(101, "Midnight milk", "Dairy", 5, 2, 0)];
    globalThis.fetch = api.fetch;
    renderApp();
    await waitFor(() => assert.equal(screen.getByTestId("stat-expiring").textContent, "1"));
    assert.equal(screen.getByTestId("stat-expired").textContent, "0");
    await act(async () => { context.mock.timers.tick(30_000); });
    await waitFor(() => assert.equal(screen.getByTestId("stat-expired").textContent, "1"));
    assert.equal(screen.getByTestId("stat-expiring").textContent, "0");
    assert.equal(screen.getByTestId("attention-item-101").textContent?.includes("Expired"), true);
  });

  it("shows expired and low alerts, links to the exact item, and clears after correcting its date", async () => {
    const api = new MockPantryApi();
    api.state.inventory = [
      dashboardItem(101, "Expired milk", "Dairy", 1, 2, -1),
      dashboardItem(102, "Future milk", "Dairy", 5, 2, 3),
    ];
    globalThis.fetch = api.fetch;
    renderApp();
    await waitFor(() => assert.equal(screen.getByTestId("stat-expired").textContent, "1"));
    assert.equal(screen.getAllByTestId(/^attention-item-/).length, 2);
    assert.equal(screen.getByTestId("attention-item-101").textContent?.includes("Expired"), true);
    assert.equal(screen.queryByText("No grocery suggestions right now."), null);
    fireEvent.click(screen.getByTestId("notification-bell"));
    const panel = screen.getByRole("button", { name: "Close notifications" }).parentElement!.parentElement!;
    assert.equal(within(panel).queryByText("All caught up!"), null);
    const alerts = await within(panel).findAllByRole("link", { name: "Expired milk" });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].getAttribute("href"), "/inventory?item=101");
    fireEvent.click(alerts[0]);
    await screen.findByRole("heading", { name: "Inventory" });
    await screen.findByTestId("inventory-item-101");
    assert.equal(screen.queryByTestId("inventory-item-102"), null);
    const card = screen.getByTestId("inventory-item-101");
    assert.ok(within(card).getByText("Expired"));
    assert.ok(within(card).getByText("Low Stock"));
    assert.ok(card.textContent?.includes("Expired on:"));
    fireEvent.click(screen.getByTestId("button-edit-101"));
    await screen.findByTestId("dialog-inventory-item");
    changeInput("input-item-expires", "");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.equal(api.state.inventory[0].expiresAt, null));
    await waitFor(() => assert.equal(within(card).queryByText("Expired"), null));
    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    await waitFor(() => assert.equal(screen.getByTestId("stat-expired").textContent, "0"));
    // Replenishment remains available after freshness attention clears.
    assert.equal((screen.getByTestId("button-generate-shopping-list") as HTMLButtonElement).disabled, false);
  });

  it("shows expiring as primary while retaining low stock on the inventory card", async () => {
    const api = new MockPantryApi();
    api.state.inventory = [dashboardItem(101, "Expiring milk", "Dairy", 1, 2, 3)];
    globalThis.fetch = api.fetch;
    renderApp();
    await waitFor(() => assert.ok(screen.getByText("Expiring milk")));
    fireEvent.click(screen.getByRole("link", { name: "Inventory" }));
    await screen.findByTestId("inventory-item-101");
    const card = screen.getByTestId("inventory-item-101");
    assert.ok(card.className.includes("inventory-item-expiring"));
    assert.ok(within(card).getByText("Expiring Soon"));
    assert.ok(within(card).getByText("Low Stock"));
  });

  it("handles the combined Milk alert across dashboard, notifications, review, and read state", async (context) => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-12T12:00:00Z") });
    const api = new MockPantryApi();
    api.state.inventory = [
      dashboardItem(101, "Milk", "Dairy", 1.5, 1.5, 2),
    ];
    api.state.inventory[0].unit = "litres";
    globalThis.fetch = api.fetch;
    const { queryClient } = renderApp();

    await waitFor(() => assert.equal(screen.getByTestId("stat-low-stock").textContent?.trim(), "1"));
    assert.equal(screen.getByTestId("stat-expiring").textContent?.trim(), "1");
    assert.equal(screen.getByRole("link", { name: "View Total Items in inventory" }).getAttribute("href"), "/inventory");
    assert.equal(screen.getByRole("link", { name: "View Low Stock in inventory" }).getAttribute("href"), "/inventory?stock=low");
    assert.equal(screen.getByRole("link", { name: "View Out of Stock in inventory" }).getAttribute("href"), "/inventory?stock=out");
    assert.equal(screen.getByRole("link", { name: "View Expiring Soon in inventory" }).getAttribute("href"), "/inventory?stock=expiring");
    assert.equal(screen.getByRole("link", { name: "View Expired in inventory" }).getAttribute("href"), "/inventory?stock=expired");
    assert.equal(screen.getByTestId("attention-item-101").textContent?.includes("Expiring Soon"), true);
    assert.equal(screen.getByTestId("attention-item-101").textContent?.includes("Low Stock"), true);

    const bell = screen.getByTestId("notification-bell");
    fireEvent.click(bell);
    const panel = screen.getByTestId("notification-panel");
    assert.equal(within(panel).getAllByRole("link", { name: "Milk" }).length, 1);
    assert.ok(panel.textContent?.includes("Expires on 2026-11-14"));
    assert.ok(panel.textContent?.includes("minimum is 1.5 litres"));
    await waitFor(() => assert.equal(bell.textContent?.includes("1"), false));
    fireEvent.click(within(panel).getByRole("button", { name: "Close notifications" }));

    await queryClient.refetchQueries({ queryKey: getGetGrocerySuggestionsQueryKey() });
    assert.equal(bell.textContent?.includes("1"), false);
    fireEvent.click(screen.getByTestId("button-generate-shopping-list"));
    await screen.findByRole("heading", { name: "Review shopping list" });
    assert.equal(screen.getAllByTestId("preview-item-101").length, 1);
    assert.ok(screen.getByTestId("preview-item-101").textContent?.includes("Expires on 2026-11-14"));
    const quantity = screen.getByLabelText("Milk quantity") as HTMLInputElement;
    fireEvent.change(quantity, { target: { value: "2" } });
    assert.equal(quantity.value, "2");
    fireEvent.click(screen.getByRole("button", { name: "Remove Milk from shopping list review" }));
    assert.equal(screen.queryByTestId("preview-item-101"), null);

    api.state.inventory[0].expiresAt = "2026-11-15";
    await queryClient.refetchQueries({ queryKey: getGetGrocerySuggestionsQueryKey() });
    await waitFor(() => assert.ok(bell.textContent?.includes("1")));
  });

  it("keeps zero-stock upcoming items out of expiry counts and filters", async (context) => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-12T12:00:00Z") });
    const api = new MockPantryApi();
    api.state.inventory = [
      dashboardItem(101, "Empty milk", "Dairy", 0, 2, 2),
      dashboardItem(102, "Fresh milk", "Dairy", 5, 2, 2),
    ];
    globalThis.fetch = api.fetch;
    renderApp();
    await waitFor(() => assert.equal(screen.getByTestId("stat-expiring").textContent?.trim(), "1"));
    fireEvent.click(screen.getByRole("link", { name: "View Expiring Soon in inventory" }));
    await screen.findByTestId("inventory-item-102");
    assert.equal(screen.queryByTestId("inventory-item-101"), null);
    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    await screen.findByTestId("stat-out-of-stock");
    fireEvent.click(screen.getByRole("link", { name: "View Out of Stock in inventory" }));
    await screen.findByTestId("inventory-item-101");
    const card = screen.getByTestId("inventory-item-101");
    assert.ok(within(card).getByText("Out of Stock"));
    assert.equal(within(card).queryByText("Expiring Soon"), null);
  });

  it("filters expired inventory while leaving empty past-dated items as out of stock", async () => {
    const api = new MockPantryApi();
    api.state.inventory = [
      dashboardItem(101, "Expired milk", "Dairy", 5, 2, -1),
      dashboardItem(102, "Empty milk", "Dairy", 0, 2, -1),
      dashboardItem(103, "Today milk", "Dairy", 5, 2, 0),
    ];
    globalThis.fetch = api.fetch;
    renderApp();
    await waitFor(() => assert.equal(screen.getByTestId("stat-expired").textContent, "1"));
    fireEvent.click(screen.getByRole("link", { name: "View Expired in inventory" }));
    await screen.findByTestId("inventory-item-101");
    assert.equal(screen.queryByTestId("inventory-item-102"), null);
    assert.equal(screen.queryByTestId("inventory-item-103"), null);
    assert.equal(screen.getByTestId("filter-expired").getAttribute("aria-pressed"), "true");
    fireEvent.click(screen.getByTestId("button-delete-101"));
    await screen.findByTestId("dialog-delete-confirm");
    fireEvent.click(screen.getByTestId("button-confirm-delete"));
    await screen.findByText("No items match these filters.");
    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    await waitFor(() => assert.equal(screen.getByTestId("stat-expired").textContent, "0"));
  });
});

after(() => dom.window.close());

async function acknowledgeConflict() {
  await waitFor(() => assert.equal((screen.getByTestId("button-review-latest") as HTMLButtonElement).disabled, false));
  fireEvent.click(screen.getByTestId("button-review-latest"));
}

function changeInput(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

describe("dashboard attention editing", () => {
  it("avoids PATCH for untouched and reverted drafts", async () => {
    const { patches } = setup();
    await edit();
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
    await edit();
    changeInput("input-item-quantity", "7");
    changeInput("input-item-quantity", "1.5");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
    assert.equal(patches.length, 0);
  });

  it("disables only the loading row, ignores its late GET, and permits authoritative retry", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(101, "Milk", "Dairy", 1, 2), dashboardItem(102, "Rice", "Pantry", 0, 1)];
    api.inventoryItemGetMode = "pending";
    globalThis.fetch = api.fetch;
    renderApp();
    const trigger = await screen.findByRole("button", { name: "Edit Milk" });
    fireEvent.click(trigger);
    await screen.findByText("Loading current item...");
    assert.equal((trigger as HTMLButtonElement).disabled, true);
    const other = document.querySelector<HTMLButtonElement>('button[aria-label="Edit Rice"]');
    assert.equal(other?.disabled, false);
    const lateResponse = api.resolveInventoryItemGet;
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    api.inventoryItemGetMode = "error";
    fireEvent.click(trigger);
    await screen.findByText("Unable to load this item. Try again or close this dialog.");
    await act(async () => lateResponse?.());
    assert.ok(screen.queryByTestId("input-item-name") === null);
    api.inventoryItemGetMode = "normal";
    fireEvent.click(screen.getByRole("button", { name: "Refresh item" }));
    await waitFor(() => assert.equal((screen.getByTestId("input-item-name") as HTMLInputElement).value, "Milk"));
    assert.equal(api.inventoryItemGetCount, 3);
  });

  it("uses controllable PATCH failure/pending recovery without overlapping requests", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(101, "Milk", "Dairy", 1, 2)];
    globalThis.fetch = api.fetch;
    renderApp();
    await edit();
    changeInput("input-item-notes", "Keep for retry");
    api.inventoryPatchMode = "error";
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.equal(api.inventoryUpdateBodies.length, 1));
    await waitFor(() => assert.equal((screen.getByTestId("button-save-item") as HTMLButtonElement).disabled, false));
    api.inventoryPatchMode = "pending";
    fireEvent.click(screen.getByTestId("button-save-item"));
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.equal(api.inventoryUpdateBodies.length, 2));
    await act(async () => api.resolveInventoryPatch?.());
    await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
    assert.deepEqual(api.inventoryUpdateBodies, [{ notes: "Keep for retry", revision: 0 }, { notes: "Keep for retry", revision: 0 }]);
  });

  it("clears an account's draft on account switch/logout and never resurrects it", async () => {
    const api = new MockPantryApi({ inventory: [dashboardItem(101, "Milk", "Dairy", 1, 2)], lists: [], applied: [], nextId: 200 });
    const session: AuthSession = { authenticated: true, account: { id: 1, email: "first@example.test", name: "First" }, csrfToken: "test-token" };
    let signIn!: (session: AuthSession) => void;
    let patches = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/api/auth/session")) return new Response(JSON.stringify(session), { headers: { "Content-Type": "application/json" } });
      if (init?.method === "PATCH") patches++;
      return api.fetch(input, init);
    };
    function AccountHarness() {
      signIn = useSessionAccess().signedIn;
      return <Dashboard />;
    }
    const client = createQueryClient();
    const location = memoryLocation({ path: "/dashboard" });
    render(<QueryClientProvider client={client}><Router hook={location.hook}><LoginGate preview={false}><AccountHarness /></LoginGate></Router></QueryClientProvider>);
    await edit();
    changeInput("input-item-notes", "Account one's draft");
    await act(async () => signIn({ ...session, account: { ...session.account!, id: 2 } }));
    await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
    await act(async () => signIn(session));
    assert.ok(screen.queryByRole("dialog") === null);
    await edit();
    assert.equal((screen.getByTestId("input-item-notes") as HTMLInputElement).value, "");
    await act(async () => signIn({ ...session, authenticated: false, account: null }));
    await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
    assert.equal(patches, 0);
  });

  function setup(items = [dashboardItem(101, "Milk", "Dairy", 1.5, 2, -1)]) {
    const api = new MockPantryApi({ inventory: items, lists: [], applied: [], nextId: 200 });
    const patches: { id: number; body: Record<string, unknown> }[] = [];
    const requests: string[] = [];
    const controls = { fail: false, hold: false, release: () => {} };
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (init?.method === "PATCH") {
        patches.push({ id: Number(url.pathname.split("/").at(-1)), body: JSON.parse(String(init.body)) });
        if (controls.hold) await new Promise<void>((resolve) => { controls.release = resolve; });
        if (controls.fail) return new Response(JSON.stringify({ error: "Unavailable" }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
      return api.fetch(input, init);
    };
    return { api, patches, requests, controls, ...renderApp() };
  }
  async function edit(name = "Milk") {
    const button = await screen.findByRole("button", { name: `Edit ${name}` });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => assert.equal((screen.getByTestId("input-item-name") as HTMLInputElement).value, name));
    return button;
  }

  it("opens every visible ID, including the expanded rows, without following its sibling link", async () => {
    const { patches } = setup(Array.from({ length: 8 }, (_, i) => dashboardItem(101 + i, `Milk ${i}`, "Dairy", 1, 2)));
    await screen.findByRole("button", { name: "Edit Milk 0" });
    assert.equal(screen.getAllByRole("button", { name: /^Edit Milk/ }).length, 6);
    fireEvent.click(screen.getByRole("button", { name: "View all 8 items" }));
    for (let i = 0; i < 8; i++) {
      await edit(`Milk ${i}`);
      assert.equal((screen.getByTestId("input-item-name") as HTMLInputElement).value, `Milk ${i}`);
      assert.ok(screen.queryByRole("heading", { name: "Inventory" }) === null);
      assert.ok(screen.queryByTestId("button-save-and-add-another") === null);
      fireEvent.click(screen.getByTestId("button-cancel"));
      await waitFor(() => assert.ok(screen.queryByTestId("dialog-inventory-item") === null));
    }
    assert.ok(screen.getByRole("button", { name: "Show fewer" }));
    assert.equal(patches.length, 0);
  });

  for (const unit of ["kg", "family-sized cartons"]) {
    it(`loads authoritative ${unit} values rather than the row snapshot`, async () => {
      const { api } = setup();
      await screen.findByRole("button", { name: "Edit Milk" });
      api.state.inventory[0] = { ...api.state.inventory[0]!, quantity: 3.5, minThreshold: 4.5, unit, notes: "Fresh notes", revision: 1 };
      await edit();
      assert.equal((screen.getByTestId("input-item-quantity") as HTMLInputElement).value, "3.5");
      assert.equal((screen.getByTestId("input-item-threshold") as HTMLInputElement).value, "4.5");
      assert.equal((screen.getByTestId("input-item-notes") as HTMLInputElement).value, "Fresh notes");
      assert.equal((screen.getByTestId("input-item-unit") as HTMLSelectElement).value, unit === "kg" ? "kg" : "Custom");
      if (unit !== "kg") assert.equal((screen.getByTestId("input-item-custom-unit") as HTMLInputElement).value, unit);
    });
  }

  for (const close of ["Cancel", "Close", "Escape"]) {
    it(`${close} makes no mutation and returns focus without changing filter or expansion`, async () => {
      const { patches } = setup(Array.from({ length: 8 }, (_, i) => dashboardItem(101 + i, `Milk ${i}`, "Dairy", 1, 2)));
      await screen.findByRole("button", { name: "Edit Milk 0" });
      fireEvent.change(screen.getByLabelText("Filter attention by category"), { target: { value: "Dairy" } });
      fireEvent.click(screen.getByRole("button", { name: "View all 8 items" }));
      const trigger = await edit("Milk 7");
      changeInput("input-item-notes", "Unsaved");
      if (close === "Escape") fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      else fireEvent.click(screen.getByRole("button", { name: close }));
      await waitFor(() => assert.ok(document.activeElement === trigger));
      assert.equal(patches.length, 0);
      assert.equal((screen.getByLabelText("Filter attention by category") as HTMLSelectElement).value, "Dairy");
      assert.ok(screen.getByRole("button", { name: "Show fewer" }));
    });
  }

  it("preserves the bound ID and dirty draft across background reordering and disappearing alerts", async () => {
    const { api, queryClient, patches } = setup([dashboardItem(101, "Milk", "Dairy", 1.5, 2, -1), dashboardItem(102, "Rice", "Pantry", 0, 1)]);
    await edit();
    changeInput("input-item-notes", "Keep this draft");
    api.state.inventory[0] = { ...api.state.inventory[0]!, quantity: 9, expiresAt: null, revision: 1 };
    await act(async () => { await queryClient.refetchQueries({ queryKey: getListInventoryItemsQueryKey() }); });
    await waitFor(() => assert.ok(screen.queryByTestId("attention-item-101") === null));
    assert.equal((screen.getByTestId("input-item-name") as HTMLInputElement).value, "Milk");
    assert.equal((screen.getByTestId("input-item-notes") as HTMLInputElement).value, "Keep this draft");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await screen.findByTestId("inventory-conflict");
    assert.deepEqual(patches[0], { id: 101, body: { notes: "Keep this draft", revision: 0 } });
  });

  it("keeps concurrent Restock quantity during an expiry-only edit, reviews safely, and refreshes all pantry views", async () => {
    const { api, queryClient, patches, requests } = setup();
    await edit();
    changeInput("input-item-expires", "2099-01-01");
    const restock = await api.fetch("/api/inventory/101/adjust", { method: "POST", headers: { "Idempotency-Key": "dashboard-concurrent-restock" }, body: JSON.stringify({ operation: "restock", amount: 7 }) });
    assert.equal(restock.status, 200);
    await act(async () => { await queryClient.refetchQueries({ queryKey: getListInventoryItemsQueryKey() }); });
    fireEvent.click(screen.getByTestId("button-save-item"));
    await screen.findByTestId("inventory-conflict");
    assert.deepEqual(patches[0]?.body, { expiresAt: "2099-01-01", revision: 0 });
    assert.equal((screen.getByTestId("input-item-expires") as HTMLInputElement).value, "2099-01-01");
    await acknowledgeConflict();
    await waitFor(() => assert.equal((screen.getByTestId("input-item-quantity") as HTMLInputElement).value, "8.5"));
    assert.equal((screen.getByTestId("input-item-expires") as HTMLInputElement).value, "2099-01-01");
    const before = requests.length;
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.ok(screen.queryByTestId("dialog-inventory-item") === null));
    assert.deepEqual(patches[1]?.body, { expiresAt: "2099-01-01", revision: 1 });
    assert.equal(api.state.inventory[0]?.quantity, 8.5);
    assert.equal(api.state.lists.length, 0);
    await waitFor(() => assert.ok(screen.queryByTestId("attention-item-101") === null));
    await waitFor(() => assert.ok(document.activeElement === screen.getByLabelText("Filter attention by category")));
    for (const path of ["/api/inventory", "/api/inventory/stats", "/api/suggestions"]) assert.ok(requests.slice(before).includes(`GET ${path}`), path);
    assert.deepEqual(queryClient.getQueryData(getGetInventoryItemQueryKey(101)), api.state.inventory[0]);
    assert.equal(screen.getByTestId("stat-expired").textContent, "0");
    assert.equal(screen.getByTestId("stat-low-stock").textContent, "0");
    fireEvent.click(screen.getByTestId("notification-bell"));
    await within(screen.getByTestId("notification-panel")).findByText("All caught up!");
  });

  it("resolves expiry while retaining low stock, counts, notifications and focus on the remaining row", async () => {
    const { api, patches } = setup();
    const trigger = await edit();
    changeInput("input-item-expires", "");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.ok(screen.queryByTestId("dialog-inventory-item") === null));
    await waitFor(() => assert.equal(screen.getByTestId("stat-expired").textContent, "0"));
    const row = screen.getByTestId("attention-item-101");
    assert.ok(within(row).getByText("Low Stock"));
    assert.equal(within(row).queryByText("Expired"), null);
    assert.equal(screen.getByTestId("stat-low-stock").textContent, "1");
    await waitFor(() => assert.ok(document.activeElement === trigger));
    assert.deepEqual(patches[0]?.body, { expiresAt: null, revision: 0 });
    assert.equal(api.state.lists.length, 0);
    fireEvent.click(screen.getByTestId("notification-bell"));
    const panel = screen.getByTestId("notification-panel");
    assert.equal(within(panel).queryByText("Expired"), null);
    assert.ok(within(panel).getByRole("link", { name: "Milk" }));
  });

  it("saves a decimal threshold, preserves category/expanded state, and safely focuses after moving outside the filter", async () => {
    const { patches } = setup(Array.from({ length: 8 }, (_, i) => dashboardItem(101 + i, `Milk ${i}`, "Dairy", 1, 2)));
    await screen.findByRole("button", { name: "Edit Milk 0" });
    fireEvent.change(screen.getByLabelText("Filter attention by category"), { target: { value: "Dairy" } });
    fireEvent.click(screen.getByRole("button", { name: "View all 8 items" }));
    await edit("Milk 7");
    changeInput("input-item-category", "Pantry");
    changeInput("input-item-threshold", "3.5");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.ok(screen.queryByTestId("dialog-inventory-item") === null));
    await waitFor(() => assert.ok(screen.queryByTestId("attention-item-108") === null));
    assert.deepEqual(patches[0]?.body, { category: "Pantry", minThreshold: 3.5, revision: 0 });
    assert.equal((screen.getByLabelText("Filter attention by category") as HTMLSelectElement).value, "Dairy");
    assert.ok(screen.getByRole("button", { name: "Show fewer" }));
    await waitFor(() => assert.ok(document.activeElement === screen.getByLabelText("Filter attention by category")));
  });

  it("requires explicit same-field conflict resolution and never silently overwrites the newer value", async () => {
    const { api, patches } = setup();
    await edit();
    changeInput("input-item-expires", "2099-01-01");
    await api.fetch("/api/inventory/101", { method: "PATCH", body: JSON.stringify({ expiresAt: "2098-01-01", revision: 0 }) });
    fireEvent.click(screen.getByTestId("button-save-item"));
    await screen.findByTestId("inventory-conflict");
    await acknowledgeConflict();
    await screen.findByText("Conflicting change: expiry date");
    assert.equal((screen.getByTestId("input-item-expires") as HTMLInputElement).value, "2099-01-01");
    assert.equal((screen.getByTestId("button-save-item") as HTMLButtonElement).disabled, true);
    assert.equal(api.state.inventory[0]?.expiresAt, "2098-01-01");
    fireEvent.click(screen.getByRole("button", { name: "Keep my expiry date" }));
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.ok(screen.queryByTestId("dialog-inventory-item") === null));
    assert.deepEqual(patches[1]?.body, { expiresAt: "2099-01-01", revision: 1 });
  });

  it("preserves a complete draft after server failure and prevents repeated pending PATCH requests", async () => {
    const { controls, patches } = setup();
    await edit();
    changeInput("input-item-notes", "Retry this draft");
    controls.fail = true;
    controls.hold = true;
    const save = screen.getByTestId("button-save-item");
    fireEvent.click(save); fireEvent.click(save); fireEvent.click(save);
    await waitFor(() => assert.equal(patches.length, 1));
    assert.equal((save as HTMLButtonElement).disabled, true);
    await act(async () => controls.release());
    await waitFor(() => assert.equal((save as HTMLButtonElement).disabled, false));
    assert.equal((screen.getByTestId("input-item-notes") as HTMLInputElement).value, "Retry this draft");
    controls.fail = false; controls.hold = false;
    fireEvent.click(save);
    await waitFor(() => assert.ok(screen.queryByTestId("dialog-inventory-item") === null));
    assert.equal(patches.length, 2);
  });

  for (const when of ["open", "save"]) {
    it(`handles deletion before ${when} with a safe close and refreshed dashboard`, async () => {
      const { api } = setup();
      await screen.findByRole("button", { name: "Edit Milk" });
      if (when === "save") { await edit(); changeInput("input-item-notes", "Draft"); }
      api.state.inventory = [];
      if (when === "open") fireEvent.click(screen.getByRole("button", { name: "Edit Milk" }));
      else fireEvent.click(screen.getByTestId("button-save-item"));
      await screen.findByText(/no longer available/i);
      await waitFor(() => assert.ok(screen.queryByTestId("attention-item-101") === null));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
    });
  }

  it("reuses inline validation and makes no request for an invalid draft", async () => {
    const { patches } = setup();
    await edit();
    changeInput("input-item-name", ""); changeInput("input-item-quantity", ""); changeInput("input-item-threshold", "-1");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await screen.findByText("Name is required");
    assert.ok(screen.getByText("Quantity is required"));
    assert.ok(screen.getByText("Threshold must be 0 or greater"));
    assert.equal(patches.length, 0);
  });

  it("keeps loading cancellable, ignores a late response, and starts fresh on reopening", async () => {
    const { api, patches } = setup();
    const fetcher = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let hold = true;
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/inventory/101") && (init?.method ?? "GET").toUpperCase() === "GET" && hold) await gate;
      return fetcher(input, init);
    };
    fireEvent.click(await screen.findByRole("button", { name: "Edit Milk" }));
    await screen.findByText("Loading current item...");
    assert.ok(screen.queryByTestId("input-item-name") === null);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    hold = false;
    await act(async () => release());
    assert.ok(screen.queryByRole("dialog") === null);
    await edit();
    changeInput("input-item-notes", "Discard");
    fireEvent.click(screen.getByTestId("button-cancel"));
    api.state.inventory[0]!.notes = "Authoritative on reopen";
    await edit();
    assert.equal((screen.getByTestId("input-item-notes") as HTMLInputElement).value, "Authoritative on reopen");
    assert.equal(patches.length, 0);
  });

  it("creates low-stock attention by increasing threshold while correcting the final expiry condition", async () => {
    const { patches } = setup([dashboardItem(101, "Milk", "Dairy", 5, 1, -1)]);
    await edit();
    changeInput("input-item-expires", "");
    changeInput("input-item-threshold", "5.5");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
    await waitFor(() => assert.equal(screen.getByTestId("stat-low-stock").textContent, "1"));
    assert.equal(screen.getByTestId("stat-expired").textContent, "0");
    assert.ok(within(screen.getByTestId("attention-item-101")).getByText("Low Stock"));
    assert.deepEqual(patches[0]?.body, { minThreshold: 5.5, expiresAt: null, revision: 0 });
  });
});

async function openInventory() {
  fireEvent.click(screen.getByRole("link", { name: "Inventory" }));
  await screen.findByRole("heading", { name: "Inventory" });
}

async function openDashboard() {
  fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
  await screen.findByRole("heading", { name: "Dashboard" });
}

afterEach(() => {
  cleanup();
  // Clear caches after unmounting: clearing active queries can trigger refetches.
  for (const client of clients) client.clear();
  clients.clear();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
    mock.restoreAll();
});

describe("public and protected routes", () => {
  for (const [path, heading] of [
    ["/", /Your home\.\s*A little more in order\./],
    ["/login", "Welcome home."],
    ["/signup", "A little more together."],
    ["/dashboard", "Welcome home."],
    ["/inventory", "Welcome home."],
    ["/shopping-lists/12", "Welcome home."],
    ["/unknown/deep/page?from=bookmark", "Welcome home."],
  ] satisfies [string, string | RegExp][]) {
    it(`shows the expected public page for ${path}`, async () => {
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        throw new Error("Landing must not request pantry data");
      };
      const location = memoryLocation({ path });
      const queryClient = createQueryClient();
      render(
        <QueryClientProvider client={queryClient}>
          <Router hook={location.hook}>
            <AppRoutes preview />
          </Router>
        </QueryClientProvider>,
      );
      await screen.findByRole("heading", { name: heading });
      assert.equal(screen.queryByRole("heading", { name: "Dashboard" }), null);
      assert.equal(screen.queryByRole("link", { name: "Inventory" }), null);
      assert.equal(requests, 0);
    });
  }

  it("opens the dashboard after the preview and returns to login on a fresh load", async () => {
    mock.method(authFeatures, "mobilePreviewEnabled", () => true);
    const api = new MockPantryApi();
    globalThis.fetch = api.fetch;
    const location = memoryLocation({ path: "/inventory" });
    const queryClient = createQueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const mount = () =>
      render(
        <QueryClientProvider client={queryClient}>
          <Router hook={location.hook}>
            <AppRoutes preview />
          </Router>
        </QueryClientProvider>,
      );
    const view = mount();

    await screen.findByRole("heading", { name: "Welcome home." });
    fireEvent.change(screen.getByLabelText("Mobile number"), {
      target: { value: "9876543210" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Get verification code" }),
    );
    fireEvent.change(await screen.findByLabelText("Verification code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify & continue" }));

    await screen.findByRole("heading", { name: "Dashboard" });

    assert.equal(screen.getByRole("link", { name: "Step into your home" }).getAttribute("href"), "/inventory");
    await openInventory();

    await openDashboard();

    view.unmount();
    mount();
    await screen.findByRole("heading", { name: "Welcome home." });
  });
});

describe("logout", () => {
  it("clears preview access and blocks navigation back to app screens", async () => {
    globalThis.fetch = new MockPantryApi().fetch;
    const location = memoryLocation({ path: "/login" });
    const queryClient = createQueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <Router hook={location.hook}>
          <AppRoutes preview />
        </Router>
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: "Welcome home." });
    assert.equal(screen.queryByRole("button", { name: /Account menu for/ }), null);
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "demo@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Get verification code" }),
    );
    fireEvent.change(await screen.findByLabelText("Verification code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify & continue" }));
    await screen.findByRole("heading", { name: "Dashboard" });
    assert.equal(screen.queryByRole("link", { name: "Sign in" }), null);
    const accountTrigger = screen.getByRole("button", { name: "Account menu for Demo account" });
    fireEvent.keyDown(accountTrigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Account details" }));
    const accountDialog = await screen.findByRole("dialog", { name: "Account details" });
    assert.ok(within(accountDialog).getByText("Demo account"));
    assert.ok(within(accountDialog).getByText("This is a demo preview, not a signed-in account."));
    fireEvent.keyDown(accountDialog, { key: "Escape" });
    await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
    await openInventory();
    fireEvent.keyDown(screen.getByRole("button", { name: /Account menu for/ }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Log out" }));
    await screen.findByRole("heading", { name: "Welcome home." });
    assert.equal(queryClient.getQueryCache().getAll().length, 0);
    for (const path of ["/dashboard", "/inventory", "/shopping-lists"]) {
      await act(async () => {
        location.navigate(path);
      });
      await screen.findByRole("heading", { name: "Welcome home." });
      assert.equal(screen.queryByRole("button", { name: /Account menu for/ }), null);
    }
  });
});

describe("mobile sign-in and sign-up preview", () => {
  beforeEach(() => { mock.method(authFeatures, "mobilePreviewEnabled", () => true); });
  it("validates mobile and OTP, allows changing the number, and opens the dashboard directly", async () => {
    globalThis.fetch = async () => {
      throw new Error("Auth preview must not make network requests");
    };
    const { queryClient } = renderApp("/login");
    await screen.findByRole("heading", { name: "Welcome home." });
    fireEvent.click(
      screen.getByRole("button", { name: "Get verification code" }),
    );
    await screen.findByText("Enter your mobile number.");
    fireEvent.change(screen.getByLabelText("Mobile number"), {
      target: { value: "123" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Get verification code" }),
    );
    await screen.findByText("Enter a 10-digit Indian mobile number.");
    fireEvent.change(screen.getByLabelText("Mobile number"), {
      target: { value: "9876543210" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Get verification code" }),
    );
    await screen.findByLabelText("Verification code");
    assert.equal(
      screen
        .getByRole("button", { name: /Resend in/ })
        .hasAttribute("disabled"),
      true,
    );
    fireEvent.change(screen.getByLabelText("Verification code"), {
      target: { value: "654321" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify & continue" }));
    await screen.findByText(
      "That code does not match. For this preview, use 123456.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Change number" }));
    assert.equal(
      (screen.getByLabelText("Mobile number") as HTMLInputElement).value,
      "9876543210",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Get verification code" }),
    );
    assert.equal(
      ((await screen.findByLabelText("Verification code")) as HTMLInputElement)
        .value,
      "",
    );
    fireEvent.change(screen.getByLabelText("Verification code"), {
      target: { value: "123456" },
    });
    globalThis.fetch = new MockPantryApi().fetch;
    fireEvent.click(screen.getByRole("button", { name: "Verify & continue" }));
    await screen.findByRole("heading", { name: "Dashboard" });
    assert.equal(screen.getByRole("link", { name: "Step into your home" }).getAttribute("href"), "/inventory");
    assert.equal(screen.queryByLabelText("Verification code"), null);
    fireEvent.keyDown(screen.getByRole("button", { name: /Account menu for/ }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Log out" }));
    assert.equal(
      ((await screen.findByLabelText("Mobile number")) as HTMLInputElement).value,
      "",
    );
  });

  it("switches to signup and enables resend after the cooldown", async () => {
    const { queryClient } = renderApp("/login");
    fireEvent.click(screen.getByRole("link", { name: "Create account" }));
    await screen.findByRole("heading", { name: "A little more together." });
    fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
      target: { value: "Riya Preview" },
    });
    fireEvent.change(screen.getByLabelText("Mobile number"), {
      target: { value: "9876543210" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Get verification code" }),
    );
    await screen.findByLabelText("Verification code");
    const realNow = Date.now;
    const later = realNow() + 31000;
    try {
      Date.now = () => later;
      const resend = await screen.findByRole(
        "button",
        { name: "Resend code" },
        { timeout: 3000 },
      );
      fireEvent.click(resend);
      await screen.findByText(
        "A fresh demo code is ready: 123456. No SMS was sent.",
      );
      assert.ok(
        screen
          .getByRole("button", { name: /Resend in/ })
          .hasAttribute("disabled"),
      );
    } finally {
      Date.now = realNow;
    }
  });
});

describe("create account name", () => {
  it("requires a nonblank name only for signup and clears it when switching pages", async () => {
    globalThis.fetch = async () => {
      throw new Error("Account preview must not transmit names");
    };
    const { queryClient } = renderApp("/signup");
    await screen.findByRole("textbox", { name: "Your name" });
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "demo@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Get verification code" }),
    );
    await screen.findByText("Enter your name.");
    assert.equal(document.activeElement, screen.getByRole("textbox", { name: "Your name" }));
    assert.equal(screen.queryByLabelText("Verification code"), null);
    fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
      target: { value: "   " },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Get verification code" }),
    );
    await screen.findByText("Enter your name.");
    fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
      target: { value: "Riya Preview" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Get verification code" }),
    );
    await screen.findByLabelText("Verification code");
    assert.equal(screen.queryByText("Riya Preview"), null);
    fireEvent.click(screen.getByRole("button", { name: "Change email" }));
    assert.equal(
      (screen.getByRole("textbox", { name: "Your name" }) as HTMLInputElement).value,
      "Riya Preview",
    );
    fireEvent.click(screen.getByRole("link", { name: "Sign in" }));
    assert.equal(screen.queryByRole("textbox", { name: "Your name" }), null);
    fireEvent.click(screen.getByRole("link", { name: "Create account" }));
    assert.equal(
      (screen.getByRole("textbox", { name: "Your name" }) as HTMLInputElement).value,
      "",
    );
  });
});

describe("email OTP preview", () => {
  // This suite also checks switching away from email in the preserved preview.
  beforeEach(() => { mock.method(authFeatures, "mobilePreviewEnabled", () => true); });
  for (const signup of [false, true]) {
    it(`validates email, preserves it on change, expires/resends OTP, and opens dashboard for ${signup ? "signup" : "login"}`, async () => {
      const api = new MockPantryApi();
      let allowDashboard = false;
      globalThis.fetch = async (input, init) => {
        assert.ok(allowDashboard, "OTP preview must not send network requests");
        return api.fetch(input, init);
      };
      const location = memoryLocation({ path: "/login" });
      const queryClient = createQueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <Router hook={location.hook}>
            <AppRoutes preview />
          </Router>
        </QueryClientProvider>,
      );
      await screen.findByRole("heading", { name: "Welcome home." });
      if (signup) {
        fireEvent.click(screen.getByRole("link", { name: "Create account" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
          target: { value: "Riya Preview" },
        });
      }
      fireEvent.click(screen.getByRole("button", { name: "Email address" }));
      const emailInput = screen.getByLabelText(
        "Email address",
      ) as HTMLInputElement;
      assert.equal(emailInput.type, "email");
      assert.equal(screen.queryByText("+91"), null);
      fireEvent.click(
        screen.getByRole("button", { name: "Get verification code" }),
      );
      await screen.findByText("Enter your email address.");
      fireEvent.change(emailInput, { target: { value: "invalid" } });
      fireEvent.click(
        screen.getByRole("button", { name: "Get verification code" }),
      );
      await screen.findByText(
        "Enter a valid email address, such as you@example.com.",
      );
      fireEvent.change(emailInput, { target: { value: "you@example.com" } });
      fireEvent.click(
        screen.getByRole("button", { name: "Get verification code" }),
      );
      await screen.findByText("Confirm your email address to continue.");
      fireEvent.click(screen.getByRole("button", { name: "Change email" }));
      assert.equal(
        (screen.getByLabelText("Email address") as HTMLInputElement).value,
        "you@example.com",
      );
      fireEvent.click(screen.getByRole("button", { name: "Mobile number" }));
      assert.equal(
        (screen.getByLabelText("Mobile number") as HTMLInputElement).value,
        "",
      );
      fireEvent.click(screen.getByRole("button", { name: "Email address" }));
      fireEvent.change(screen.getByLabelText("Email address"), {
        target: { value: "you@example.com" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Get verification code" }),
      );
      const realNow = Date.now;
      const later = realNow() + 301000;
      try {
        Date.now = () => later;
        fireEvent.change(screen.getByLabelText("Verification code"), {
          target: { value: "123456" },
        });
        fireEvent.click(
          screen.getByRole("button", { name: "Verify & continue" }),
        );
        await screen.findByText(
          "This demo code has expired. Request another code.",
        );
        fireEvent.click(
          await screen.findByRole(
            "button",
            { name: "Resend code" },
            { timeout: 3000 },
          ),
        );
        await screen.findByText(
          "A fresh demo code is ready: 123456. No email was sent.",
        );
        assert.equal(
          (screen.getByLabelText("Verification code") as HTMLInputElement)
            .value,
          "",
        );
        fireEvent.change(screen.getByLabelText("Verification code"), {
          target: { value: "654321" },
        });
        fireEvent.click(
          screen.getByRole("button", { name: "Verify & continue" }),
        );
        await screen.findByText(
          "That code does not match. For this preview, use 123456.",
        );
        fireEvent.change(screen.getByLabelText("Verification code"), {
          target: { value: "123456" },
        });
        allowDashboard = true;
        fireEvent.click(
          screen.getByRole("button", { name: "Verify & continue" }),
        );
        await screen.findByRole("heading", { name: "Dashboard" });
        assert.equal(screen.getByRole("link", { name: "Step into your home" }).getAttribute("href"), "/inventory");
        assert.equal(screen.queryByText("you@example.com"), null);
        assert.equal(screen.queryByText("Riya Preview"), null);
        assert.equal(screen.queryByRole("textbox", { name: "Your name" }), null);
        if (signup) {
          await openInventory();
          assert.equal(screen.queryByText("Riya Preview"), null);
          fireEvent.keyDown(screen.getByRole("button", { name: /Account menu for/ }), { key: "ArrowDown" });
          fireEvent.click(await screen.findByRole("menuitem", { name: "Log out" }));
          await screen.findByRole("heading", { name: "Welcome home." });
          fireEvent.click(screen.getByRole("link", { name: "Create account" }));
          assert.equal(
            (screen.getByRole("textbox", { name: "Your name" }) as HTMLInputElement).value,
            "",
          );
        }
      } finally {
        Date.now = realNow;
      }
    });
  }
});

describe("shopping list selection and deletion", () => {
  async function setup() {
    const api = new MockPantryApi();
    api.state.lists.push({
      ...api.state.lists[0],
      id: 30,
      name: "Party supplies",
      items: [],
    });
    globalThis.fetch = api.fetch;
    const app = renderApp();
    fireEvent.click(screen.getByRole("link", { name: "Shopping Lists" }));
    await screen.findByRole("checkbox", { name: "Select Weekend groceries" });
    return { api, ...app };
  }

  it("marks the active navigation and returns from list details through breadcrumbs", async () => {
    const { queryClient } = await setup();
    const mainNav = screen.getByRole("navigation", { name: "Main navigation" });
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    assert.equal(
      within(mainNav).getByRole("link", { name: "Shopping Lists" }).getAttribute("aria-current"),
      "page",
    );
    assert.equal(
      within(breadcrumb).getByRole("link", { name: "Shopping Lists" }).getAttribute("aria-current"),
      "page",
    );

    fireEvent.click(screen.getByRole("link", { name: "Weekend groceries" }));
    await screen.findByRole("checkbox", { name: "Purchased Milk" });
    const detailBreadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    assert.equal(
      within(detailBreadcrumb).getByText("List details").getAttribute("aria-current"),
      "page",
    );
    fireEvent.click(within(detailBreadcrumb).getByRole("link", { name: "Shopping Lists" }));
    await screen.findByRole("checkbox", { name: "Select Weekend groceries" });
  });

  it("shows progress and clearly labels the sample comparison while preserving detail links", async () => {
    const { queryClient } = await setup();
    assert.ok(
      screen
        .getByRole("link", { name: "Weekend groceries" })
        .getAttribute("href")
        ?.endsWith("/shopping-lists/20"),
    );
    assert.match(
      screen.getByTestId("shopping-list-20").textContent ?? "",
      /items purchased/,
    );
    assert.match(
      screen.getByRole("button", { name: "Compare prices (sample)" }).textContent ?? "",
      /sample/,
    );
    assert.ok(screen.getByTestId("shopping-list-20"));
    fireEvent.click(screen.getByRole("link", { name: "Weekend groceries" }));
    assert.ok(await screen.findByRole("checkbox", { name: "Purchased Milk" }));
    assert.ok(screen.getByRole("button", { name: "Remove Milk from Weekend groceries" }));
    assert.ok(screen.getByRole("progressbar", { name: "Weekend groceries: 0% complete" }));
  });

  it("preserves newer item state while a rename is pending", async () => {
    const { api, queryClient } = await setup();
    const itemCount = api.state.lists[0].items.length;
    fireEvent.click(screen.getByRole("link", { name: "Weekend groceries" }));
    await screen.findByRole("checkbox", { name: "Purchased Milk" });
    fireEvent.click(screen.getByRole("button", { name: "Edit name for Weekend groceries" }));
    const input = await screen.findByRole("textbox", { name: "List name" });
    assert.equal((input as HTMLInputElement).value, "Weekend groceries");
    fireEvent.change(input, { target: { value: String.fromCodePoint(0x1f600).repeat(101) } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    assert.ok(await screen.findByRole("alert"));
    assert.equal(api.state.lists[0].name, "Weekend groceries");
    fireEvent.change(input, { target: { value: "\ufeffRenamed\u00a0 list\u3000" } });

    const detailQueryKey = getGetShoppingListQueryKey(api.state.lists[0].id);
    const originalFetch = api.fetch;
    let releaseRename!: () => void;
    const renameReleased = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    let renameStarted = false;
    globalThis.fetch = async (request, init) => {
      if (String(request) === `/api/shopping-lists/${api.state.lists[0].id}` && init?.method === "PATCH") {
        renameStarted = true;
        const response = await originalFetch(request, init);
        const staleResponseBody = await response.text();
        await renameReleased;
        return new Response(staleResponseBody, {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(request, init);
    };

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => assert.equal(renameStarted, true));

    api.state.lists[0].items[0].quantity = 9;
    api.state.lists[0].items[0].purchased = true;
    await act(async () => {
      queryClient.setQueryData<ShoppingListWithItems>(detailQueryKey, {
        ...queryClient.getQueryData<ShoppingListWithItems>(detailQueryKey)!,
        items: api.state.lists[0].items.map((item) => ({ ...item })),
      });
    });
    releaseRename();

    await screen.findByRole("heading", { name: "Renamed list" });
    assert.equal(
      (screen.getByRole("spinbutton", { name: "Milk quantity" }) as HTMLInputElement).value,
      "9",
    );
    assert.equal(
      screen.getByRole("checkbox", { name: "Purchased Milk" }).getAttribute("data-state"),
      "checked",
    );
    assert.equal(api.state.lists[0].name, "Renamed\u00a0 list");
    assert.equal(api.state.lists[0].items.length, itemCount);
  });

  it("does not let a unit-and-notes edit overwrite a newer inline quantity save", async () => {
    const { api } = await setup();
    fireEvent.click(screen.getByRole("link", { name: "Weekend groceries" }));
    await screen.findByRole("checkbox", { name: "Purchased Milk" });

    const originalFetch = api.fetch;
    let releaseQuantity!: () => void;
    const quantityReleased = new Promise<void>((resolve) => { releaseQuantity = resolve; });
    let quantityStarted = false;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (input, init) => {
      if (String(input) === "/api/shopping-lists/20/items/21" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        if (body.quantity === 9) {
          quantityStarted = true;
          await quantityReleased;
        }
      }
      return originalFetch(input, init);
    };

    const quantity = screen.getByRole("spinbutton", { name: "Milk quantity" });
    fireEvent.change(quantity, { target: { value: "9" } });
    fireEvent.blur(quantity);
    await waitFor(() => assert.equal(quantityStarted, true));

    fireEvent.click(screen.getByRole("button", { name: "Edit Milk" }));
    await screen.findByTestId("dialog-edit-shopping-item");
    fireEvent.change(screen.getByTestId("input-shopping-item-notes"), { target: { value: "Updated note" } });
    releaseQuantity();
    fireEvent.click(screen.getByTestId("button-add-shopping-item"));

    await waitFor(() => assert.equal(api.state.lists[0].items[0].quantity, 9));
    await waitFor(() => assert.equal(api.state.lists[0].items[0].notes, "Updated note"));
    assert.equal(bodies[1]?.quantity, undefined);
    assert.equal((screen.getByRole("spinbutton", { name: "Milk quantity" }) as HTMLInputElement).value, "9");
  });

  it("prefills linked units, switches preset/custom modes, and validates custom units", async () => {
    const { api } = await setup();
    fireEvent.click(screen.getByRole("link", { name: "Weekend groceries" }));
    await screen.findByRole("checkbox", { name: "Purchased Milk" });

    fireEvent.click(screen.getByRole("button", { name: "Edit Milk" }));
    await screen.findByTestId("dialog-edit-shopping-item");
    assert.equal((screen.getByTestId("input-shopping-item-unit") as HTMLSelectElement).value, "Custom");
    assert.equal((screen.getByTestId("input-shopping-item-custom-unit") as HTMLInputElement).value, "litres");
    assert.equal((screen.getByTestId("input-shopping-item-unit") as HTMLSelectElement).disabled, true);
    fireEvent.click(screen.getByTestId("button-cancel"));

    fireEvent.click(screen.getByTestId("button-add-item"));
    await screen.findByTestId("dialog-add-shopping-item");
    fireEvent.change(screen.getByTestId("input-shopping-item-name"), { target: { value: "Custom item" } });
    fireEvent.change(screen.getByTestId("input-shopping-item-category"), { target: { value: "Pantry" } });
    fireEvent.change(screen.getByTestId("input-shopping-item-unit"), { target: { value: "kg" } });
    assert.equal((screen.getByTestId("input-shopping-item-unit") as HTMLSelectElement).value, "kg");
    fireEvent.change(screen.getByTestId("input-shopping-item-unit"), { target: { value: "Custom" } });
    fireEvent.change(screen.getByTestId("input-shopping-item-custom-unit"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByTestId("button-add-shopping-item"));
    await screen.findByText("Choose a unit or enter a custom text unit");
    assert.equal(api.state.lists[0].items.length, 2);

    fireEvent.change(screen.getByTestId("input-shopping-item-custom-unit"), { target: { value: "grams" } });
    fireEvent.click(screen.getByTestId("button-add-shopping-item"));
    await waitFor(() => assert.equal(api.state.lists[0].items.length, 3));
    assert.equal(api.state.lists[0].items[2].unit, "grams");
  });

  it("keeps an individually failed deletion selected for bulk retry", async () => {
    const { api, queryClient } = await setup();
    globalThis.fetch = async (input, init) => {
      if (
        String(input) === "/api/shopping-lists/30" &&
        init?.method === "DELETE"
      ) {
        return new Response('{"error":"Try again"}', {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return api.fetch(input, init);
    };
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Party supplies" }),
    );
    fireEvent.click(await screen.findByTestId("button-confirm-delete"));
    await screen.findByRole("button", { name: "Delete selected (1)" });
    assert.equal(
      screen
        .getByRole("checkbox", { name: "Select Party supplies" })
        .getAttribute("aria-checked"),
      "true",
    );
  });

  it("does not restore deleted IDs when the later list refresh fails", async () => {
    const { api, queryClient } = await setup();
    const replacement = { ...api.state.lists[0], name: "Replacement list" };
    let failRefresh = true;
    globalThis.fetch = (input, init) => {
      if (
        String(input) === "/api/shopping-lists" &&
        (init?.method ?? "GET") === "GET" &&
        failRefresh
      ) {
        return Promise.resolve(
          new Response('{"error":"Refresh unavailable"}', {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return api.fetch(input, init);
    };
    function ToastTitles() {
      const { toasts } = useToast();
      return <div>{toasts.map((toast) => <span key={toast.id}>{toast.title}</span>)}</div>;
    }
    render(<ToastTitles />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all shopping lists" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete selected (2)" }));
    fireEvent.click(await screen.findByTestId("button-confirm-delete"));
    await screen.findByText("Could not refresh shopping lists");
    assert.equal(api.state.lists.length, 0);
    failRefresh = false;
    api.state.lists.push(replacement);
    await queryClient.invalidateQueries({ queryKey: getListShoppingListsQueryKey() });
    await screen.findByRole("checkbox", { name: "Select Replacement list" });
    assert.equal(
      screen.getByRole("checkbox", { name: "Select Replacement list" }).getAttribute("aria-checked"),
      "false",
    );
  });

  it("offers a retry when shopping lists fail to load", async () => {
    const api = new MockPantryApi();
    let fail = true;
    globalThis.fetch = (input, init) => {
      if (
        String(input) === "/api/shopping-lists" &&
        (init?.method ?? "GET") === "GET" &&
        fail
      ) {
        return Promise.resolve(
          new Response('{"error":"Unavailable"}', {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return api.fetch(input, init);
    };
    const { queryClient } = renderApp("/shopping-lists");
    await screen.findByText("Could not load your lists");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("checkbox", { name: "Select Weekend groceries" });
  });

  it("selects lists without navigating, cancels, then deletes all while preserving inventory", async () => {
    const { api, queryClient } = await setup();
    const inventory = structuredClone(api.state.inventory);
    assert.equal(
      screen.queryByRole("button", { name: /Delete selected/ }),
      null,
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Weekend groceries" }),
    );
    assert.ok(screen.getByRole("heading", { name: "Shopping Lists" }));
    assert.equal(
      screen
        .getByRole("checkbox", { name: "Select all shopping lists" })
        .getAttribute("aria-checked"),
      "mixed",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete selected (1)" }),
    );
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByTestId("button-cancel-delete"));
    assert.equal(api.state.lists.length, 2);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all shopping lists" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete selected (2)" }),
    );
    await screen.findByRole("heading", { name: "Delete 2 Shopping Lists?" });
    fireEvent.click(screen.getByTestId("button-confirm-delete"));
    await screen.findByText("No shopping lists yet.");
    assert.equal(api.state.lists.length, 0);
    assert.deepEqual(api.state.inventory, inventory);
    assert.equal(
      screen.queryByRole("button", { name: /Delete selected/ }),
      null,
    );
  });

  it("keeps failed lists selected and allows retry; individual deletion still works", async () => {
    const { api, queryClient } = await setup();
    globalThis.fetch = async (input, init) => {
      if (
        String(input) === "/api/shopping-lists/30" &&
        init?.method === "DELETE"
      ) {
        return new Response('{"error":"Try again"}', {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return api.fetch(input, init);
    };
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all shopping lists" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete selected (2)" }),
    );
    fireEvent.click(await screen.findByTestId("button-confirm-delete"));
    await waitFor(() =>
      assert.ok(!screen.queryByTestId("dialog-delete-list-confirm")),
    );
    await screen.findByRole("button", { name: "Delete selected (1)" });
    assert.deepEqual(
      api.state.lists.map((list) => list.id),
      [30],
    );
    assert.equal(
      screen
        .getByRole("checkbox", { name: "Select Party supplies" })
        .getAttribute("aria-checked"),
      "true",
    );
    globalThis.fetch = api.fetch;
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Party supplies" }),
    );
    fireEvent.click(await screen.findByTestId("button-confirm-delete"));
    await screen.findByText("No shopping lists yet.");
  });
});

describe("dashboard inventory attention refresh", () => {
  it("shows every dashboard pantry count from the inventory stats response", async () => {
    const api = new GroceryApiMock();
    const expiringDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    api.items = [
      {
        id: 1,
        name: "Out of stock item",
        category: "Pantry",
        quantity: 0,
        unit: "bags",
        minThreshold: 1,
        expiresAt: null,
        notes: null,
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: 2,
        name: "Low stock item",
        category: "Produce",
        quantity: 1,
        unit: "units",
        minThreshold: 2,
        expiresAt: null,
        notes: null,
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: 3,
        name: "Expiring item",
        category: "Dairy",
        quantity: 8,
        unit: "cartons",
        minThreshold: 2,
        expiresAt: expiringDate,
        notes: null,
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: 4,
        name: "Healthy item",
        category: "Bakery",
        quantity: 5,
        unit: "loaves",
        minThreshold: 2,
        expiresAt: null,
        notes: null,
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];
    globalThis.fetch = api.fetch;
    renderApp();

    assert.equal(
      (await screen.findByTestId("stat-total-items")).textContent?.trim(),
      "4",
    );
    assert.equal(screen.getByTestId("stat-low-stock").textContent?.trim(), "1");
    assert.equal(
      screen.getByTestId("stat-out-of-stock").textContent?.trim(),
      "1",
    );
    assert.equal(screen.getByTestId("stat-expiring").textContent?.trim(), "1");

    assert.ok((await screen.findByTestId("attention-item-1")).textContent?.includes("Out of Stock"));
    assert.ok(screen.getByTestId("attention-item-2").textContent?.includes("Low Stock"));
    assert.ok(screen.getByTestId("attention-item-3").textContent?.includes("Expiring Soon"));
  });

  it("shows initial attention loading without presenting a healthy pantry", async () => {
    const api = new GroceryApiMock();
    api.inventoryGetMode = "pending";
    globalThis.fetch = api.fetch;
    renderApp();

    await screen.findByTestId("pantry-attention-loading");
    assert.equal(screen.queryByTestId("attention-healthy"), null);
    api.resolvePendingInventory?.();
    await screen.findByText("Your pantry is in good shape.");
  });

  it("removes the obsolete attention headings and duplicate suggestion list", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(1, "Shortage", "Pantry", 0, 1)];
    globalThis.fetch = api.fetch;
    renderApp();

    await screen.findByTestId("attention-item-1");
    assert.equal(screen.queryByText("Pantry Attention by Category"), null);
    assert.equal(screen.queryByText("Grocery Suggestions & Alerts"), null);
    assert.equal(screen.getAllByTestId(/^attention-item-/).length, 1);
    assert.equal(screen.queryByTestId("grocery-suggestions-alerts"), null);
  });

  it("renders exact attention totals and Out, Low, and Expiring counts per category", async () => {
    const api = new GroceryApiMock();
    api.items = [
      dashboardItem(1, "Carrots", "Produce", 0, 2, 1),
      dashboardItem(2, "Onions", "Produce", 1, 2, 2),
      dashboardItem(3, "Pears", "Produce", 5, 2, 3),
      dashboardItem(4, "Milk", "Dairy", 1, 2, 2),
      dashboardItem(5, "Yogurt", "Dairy", 4, 1),
      dashboardItem(6, "Bread", "Bakery", 5, 1, 5),
      dashboardItem(7, "Beans", "Canned Goods", 8, 2),
    ];
    globalThis.fetch = api.fetch;
    const { queryClient } = renderApp();

    for (const id of [1, 2, 3, 4, 6]) await screen.findByTestId(`attention-item-${id}`);
    assert.equal(screen.queryByTestId("attention-item-5"), null);
    assert.equal(screen.queryByTestId("attention-item-7"), null);
    assert.equal(screen.queryByText("Your pantry is in good shape."), null);
  });

  it("shows the good-shape message and no cards for healthy-only categories", async () => {
    const api = new GroceryApiMock();
    api.items = [
      dashboardItem(1, "Rice", "Pantry", 5, 1),
      dashboardItem(2, "Cereal", "Breakfast", 4, 1, 10),
    ];
    globalThis.fetch = api.fetch;
    const { queryClient } = renderApp();

    await screen.findByText("Your pantry is in good shape.");
    assert.ok(screen.getByTestId("attention-healthy"));
    assert.equal(screen.queryByTestId("attention-list"), null);
  });

  it("shows an inventory retry error instead of a healthy state", async () => {
    const api = new GroceryApiMock();
    api.inventoryGetMode = "error";
    globalThis.fetch = api.fetch;
    renderApp();
    await screen.findByText("Needs attention could not be loaded.");
    assert.equal(screen.queryByTestId("attention-healthy"), null);
    assert.ok(screen.getByRole("button", { name: /Retry/ }));
  });

  it("keeps inventory attention rows when suggestions fail", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(1, "Shortage", "Pantry", 0, 1)];
    const originalFetch = api.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname === "/api/suggestions") return new Response("{}", { status: 503 });
      return originalFetch(input, init);
    };
    renderApp();
    await screen.findByTestId("attention-item-1");
    await screen.findByText("Shopping suggestions could not be loaded.");
    assert.equal(screen.queryByText("No grocery suggestions right now."), null);
  });

  it("keeps attention rows usable while suggestions are loading", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(1, "Shortage", "Pantry", 0, 1)];
    const originalFetch = api.fetch;
    let resolveSuggestions = () => {};
    globalThis.fetch = (async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname === "/api/suggestions") {
        return new Promise<Response>((resolve) => {
          resolveSuggestions = () => resolve(originalFetch(input, init));
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    renderApp();

    await screen.findByTestId("attention-item-1");
    const reviewButton = screen.getByTestId("button-generate-shopping-list") as HTMLButtonElement;
    assert.equal(reviewButton.disabled, true);
    assert.ok(screen.getByTestId("attention-item-1"));
    resolveSuggestions();
    await waitFor(() => assert.equal(reviewButton.disabled, false));
  });

  it("returns from a filtered-empty category to all categories", async () => {
    const api = new GroceryApiMock();
    api.items = [
      dashboardItem(1, "Shortage", "Pantry", 0, 1),
      dashboardItem(2, "Healthy", "Bakery", 5, 1),
    ];
    globalThis.fetch = api.fetch;
    renderApp();

    await screen.findByTestId("attention-item-1");
    fireEvent.change(screen.getByRole("combobox", { name: "Filter attention by category" }), { target: { value: "Bakery" } });
    await screen.findByText("No items in Bakery need attention");
    fireEvent.click(screen.getByRole("button", { name: "Show all categories" }));
    await screen.findByTestId("attention-item-1");
    assert.equal(screen.queryByTestId("attention-filtered-empty"), null);
  });

  it("filters before truncation, expands the complete result, and collapses on category change", async () => {
    const api = new GroceryApiMock();
    api.items = [
      ...Array.from({ length: 7 }, (_, index) => dashboardItem(index + 1, `Produce ${index + 1}`, "Produce", 0, 1)),
      dashboardItem(8, "Pantry shortage", "Pantry", 1, 2),
      dashboardItem(9, "Healthy staple", "Healthy", 5, 1),
    ];
    globalThis.fetch = api.fetch;
    renderApp();

    await screen.findByTestId("attention-list");
    assert.equal(screen.getAllByTestId(/^attention-item-/).length, 6);
    fireEvent.click(screen.getByRole("button", { name: "View all 8 items" }));
    assert.equal(screen.getAllByTestId(/^attention-item-/).length, 8);

    const category = screen.getByRole("combobox", { name: "Filter attention by category" });
    fireEvent.change(category, { target: { value: "Produce" } });
    await waitFor(() => assert.equal(screen.getAllByTestId(/^attention-item-/).length, 6));
    assert.ok(screen.getByRole("button", { name: "View all 7 items" }));
    fireEvent.click(screen.getByRole("button", { name: "View all 7 items" }));
    assert.equal(screen.getAllByTestId(/^attention-item-/).length, 7);
    fireEvent.change(category, { target: { value: "Pantry" } });
    await waitFor(() => assert.equal(screen.getAllByTestId(/^attention-item-/).length, 1));
    assert.equal(screen.queryByRole("button", { name: "Show fewer" }), null);
  });

  it("renders one non-interactive row with a sibling item link and Edit action", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(1, "Long custom-unit item", "A very long category", 0, 2)];
    globalThis.fetch = api.fetch;
    renderApp();

    const row = await screen.findByTestId("attention-item-1");
    assert.equal(row.querySelectorAll("a,button,input,select").length, 2);
    assert.equal(row.querySelector("a")?.getAttribute("href"), "/inventory?item=1");
    assert.ok(within(row).getByRole("button", { name: "Edit Long custom-unit item" }));
    assert.equal(row.querySelector("a button, button a"), null);
  });

  it("generates a linked shopping list from low-stock suggestions and restocks it", async () => {
    const api = new GroceryApiMock();
    api.items = [
      dashboardItem(1, "Rice", "Pantry", 0, 2),
      dashboardItem(2, "Apples", "Produce", 1, 3),
      dashboardItem(3, "Milk", "Dairy", 5, 2, 2),
    ];
    globalThis.fetch = api.fetch;
    const { queryClient } = renderApp();

    const generateButton = await screen.findByTestId(
      "button-generate-shopping-list",
    );
    await waitFor(() =>
      assert.equal((generateButton as HTMLButtonElement).disabled, false),
    );
    fireEvent.click(generateButton);

    await screen.findByRole("heading", { name: "Review shopping list" });
    fireEvent.click(
      screen.getByRole("button", { name: "Create shopping list" }),
    );
    await screen.findByRole("heading", { name: "Low-stock shopping list" });
    assert.ok(
      screen.getByTestId("shopping-item-2").textContent?.includes("Rice"),
    );
    assert.ok(
      screen.getByTestId("shopping-item-3").textContent?.includes("Apples"),
    );
    assert.equal(screen.queryByText("Milk"), null);

    fireEvent.click(screen.getByTestId("checkbox-purchased-2"));
    fireEvent.click(screen.getByTestId("button-complete-purchase"));
    await waitFor(() => assert.equal(api.items[0]?.quantity, 2));
    assert.equal(api.items[1]?.quantity, 1);
  });

  it("deduplicates the legacy expired-and-low response before shopping review and submission", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(1, "Milk", "Dairy", 1, 2, -1)];
    let generatedBody: { items: { inventoryItemId: number; quantity: number }[] } | undefined;
    const legacySuggestions = [
      {
        inventoryItemId: 1,
        name: "Milk",
        category: "Dairy",
        currentQuantity: 1,
        minThreshold: 2,
        unit: "each",
        reason: "Expired on 2026-11-11",
        urgency: "expired",
      },
      {
        inventoryItemId: 1,
        name: "Milk",
        category: "Dairy",
        currentQuantity: 1,
        minThreshold: 2,
        unit: "each",
        reason: "1 each left (minimum is 2 each)",
        urgency: "low",
      },
    ];
    const originalFetch = api.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname === "/api/suggestions" && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify(legacySuggestions), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/api/suggestions/generate-list") {
        generatedBody = JSON.parse(String(init?.body));
      }
      return originalFetch(input, init);
    };
    renderApp();
    const generateButton = await screen.findByTestId(
      "button-generate-shopping-list",
    );
    await waitFor(() =>
      assert.equal((generateButton as HTMLButtonElement).disabled, false),
    );
    fireEvent.click(generateButton);
    await screen.findByRole("heading", { name: "Review shopping list" });
    assert.equal(screen.getAllByTestId("preview-item-1").length, 1);
    fireEvent.click(screen.getByRole("button", { name: "Create shopping list" }));
    await screen.findByRole("heading", { name: "Low-stock shopping list" });
    assert.equal(generatedBody?.items.length, 1);
    assert.equal(generatedBody?.items[0]?.inventoryItemId, 1);
  });

  it("retains cached attention rows while inventory is being refreshed", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(1, "Apples", "Produce", 0, 2)];
    globalThis.fetch = api.fetch;
    const { queryClient } = renderApp();

    await screen.findByTestId("attention-item-1");

    api.inventoryGetMode = "pending";
    const refresh = queryClient.refetchQueries({
      queryKey: getListInventoryItemsQueryKey(),
      type: "active",
    });
    assert.ok(screen.getByTestId("attention-item-1"));

    await queryClient.cancelQueries({
      queryKey: getListInventoryItemsQueryKey(),
    });
    await refresh;
  });

  it("retains cached attention rows when inventory refresh fails", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(1, "Apples", "Produce", 0, 2)];
    globalThis.fetch = api.fetch;
    const { queryClient } = renderApp();

    await screen.findByTestId("attention-item-1");
    api.inventoryGetMode = "error";

    await queryClient.refetchQueries({
      queryKey: getListInventoryItemsQueryKey(),
      type: "active",
    });

    assert.ok(queryClient.getQueryData(getListInventoryItemsQueryKey()));
    await screen.findByRole("status");
    assert.ok(screen.getByTestId("attention-item-1"));
    assert.ok(screen.getByText("Refresh failed; showing the latest attention items.", { exact: false }).textContent?.includes("Refresh failed; showing the latest attention items."));
  });

  it("refreshes attention rows after create, edit, shopping-list restock, and delete flows", async () => {
    const api = new GroceryApiMock();
    globalThis.fetch = api.fetch;
    const { queryClient } = renderApp();

    await screen.findByText("Your pantry is in good shape.");

    await openInventory();
    fireEvent.click(screen.getByTestId("button-add-item"));
    await screen.findByTestId("input-item-name");
    changeInput("input-item-name", "Rice");
    changeInput("input-item-category", "Grains");
    changeInput("input-item-quantity", "1");
    changeInput("input-item-unit", "Custom");
    changeInput("input-item-custom-unit", "bags");
    changeInput("input-item-threshold", "2");
    fireEvent.click(screen.getByTestId("button-save-item"));

    await waitFor(() => assert.equal(api.items.length, 1));
    await openDashboard();
    const grainsAttention = await screen.findByTestId("attention-item-1");
    assert.ok(grainsAttention.textContent?.includes("Low Stock"));
    assert.equal(
      screen.getByTestId("stat-total-items").textContent?.includes("1"),
      true,
    );

    await openInventory();
    fireEvent.click(screen.getByTestId("button-edit-1"));
    await screen.findByTestId("dialog-inventory-item");
    assert.equal(
      (screen.getByTestId("input-item-name") as HTMLInputElement).value,
      "Rice",
    );
    changeInput("input-item-category", "Pantry");
    changeInput("input-item-quantity", "0");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => {
      assert.equal(api.items[0]?.category, "Pantry");
      assert.equal(api.items[0]?.quantity, 0);
    });

    await openDashboard();
    const pantryOut = await screen.findByTestId("attention-item-1");
    assert.ok(pantryOut.textContent?.includes("Out of Stock"));
    assert.equal(
      screen.getByTestId("stat-out-of-stock").textContent?.includes("1"),
      true,
    );

    await openInventory();
    fireEvent.click(screen.getByTestId("button-edit-1"));
    await screen.findByTestId("dialog-inventory-item");
    changeInput("input-item-quantity", "4");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.equal(api.items[0]?.quantity, 4));
    await openDashboard();
    await screen.findByText("Your pantry is in good shape.");
    assert.equal(screen.queryByTestId("attention-item-1"), null);

    await openInventory();
    fireEvent.click(screen.getByTestId("button-edit-1"));
    await screen.findByTestId("dialog-inventory-item");
    changeInput("input-item-quantity", "0");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.equal(api.items[0]?.quantity, 0));

    fireEvent.click(screen.getByRole("link", { name: "Shopping Lists" }));
    await screen.findByRole("heading", { name: "Shopping Lists" });
    fireEvent.click(await screen.findByRole("link", { name: /Weekly shop/ }));
    await screen.findByRole("heading", { name: "Weekly shop" });
    fireEvent.click(screen.getByTestId("button-complete-purchase"));
    await waitFor(() => assert.equal(api.items[0]?.quantity, 5));

    await openDashboard();
    await screen.findByText("Your pantry is in good shape.");
    assert.equal(screen.queryByTestId("attention-item-1"), null);

    await openInventory();
    fireEvent.click(screen.getByTestId("button-delete-1"));
    fireEvent.click(await screen.findByTestId("button-confirm-delete"));
    await waitFor(() => assert.equal(api.items.length, 0));
    await openDashboard();
    await screen.findByText("Your pantry is in good shape.");
    assert.equal(
      screen.getByTestId("stat-total-items").textContent?.includes("0"),
      true,
    );
  });
});

describe("stock count navigation", () => {
  it("opens matching inventory filters from dashboard counts", async () => {
    const api = new MockPantryApi();
    globalThis.fetch = api.fetch;
    const { queryClient } = renderApp();
    await screen.findByTestId("stat-low-stock");
    assert.equal(screen.getByRole("link", { name: "View Total Items in inventory" }).getAttribute("href"), "/inventory");
    assert.equal(screen.getByRole("link", { name: "View Expiring Soon in inventory" }).getAttribute("href"), "/inventory?stock=expiring");

    fireEvent.click(screen.getByRole("link", { name: "View Low Stock in inventory" }));
    await waitFor(() => assert.equal(screen.getByRole("button", { name: "Low Stock" }).getAttribute("aria-pressed"), "true"));
    await screen.findByText("4 Items");
    assert.equal(screen.queryByTestId("inventory-item-1"), null);

    await openDashboard();
    fireEvent.click(screen.getByRole("link", { name: "View Out of Stock in inventory" }));
    await waitFor(() => assert.equal(screen.getByRole("button", { name: "Out of Stock" }).getAttribute("aria-pressed"), "true"));
    await screen.findByText("2 Items");
    assert.ok(screen.getByTestId("inventory-item-1"));
    assert.ok(screen.getByTestId("inventory-item-9"));
  });
  it("restores stock and category from a direct URL and preserves category when switching stock", async () => {
    const api = new MockPantryApi();
    globalThis.fetch = api.fetch;
    const { queryClient } = renderApp("/inventory?stock=out&category=Dairy");
    await screen.findByText("1 Items");
    assert.equal(screen.getByRole("button", { name: "Out of Stock" }).getAttribute("aria-pressed"), "true");
    assert.ok(screen.getByTestId("inventory-item-1"));
    fireEvent.click(screen.getByRole("button", { name: "Low Stock" }));
    await waitFor(() => assert.equal(screen.getByRole("button", { name: "Low Stock" }).getAttribute("aria-pressed"), "true"));
    await screen.findByText("1 Items");
    assert.ok(screen.getByTestId("inventory-item-2"));
    assert.equal(screen.queryByTestId("inventory-item-1"), null);
    fireEvent.click(screen.getByRole("button", { name: "Produce" }));
    await waitFor(() => assert.ok(screen.getByTestId("inventory-item-5")));
    fireEvent.click(screen.getByRole("button", { name: "Out of Stock" }));
    await screen.findByText("0 Items");
    fireEvent.click(screen.getByRole("button", { name: "Produce" }));
    await screen.findByText("2 Items");
  });
});

describe("inventory quantity validation", () => {
  it("rejects blank quantity while accepting explicit zero and decimals", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(1, "Rice", "Pantry", 4, 1)];
    globalThis.fetch = api.fetch;
    const { queryClient } = renderApp();

    await screen.findByText("Your pantry is in good shape.");
    const statsBefore = queryClient.getQueryData(
      getGetInventoryStatsQueryKey(),
    );
    const suggestionsBefore = queryClient.getQueryData(
      getGetGrocerySuggestionsQueryKey(),
    );

    await openInventory();
    fireEvent.click(screen.getByTestId("button-edit-1"));
    await screen.findByTestId("dialog-inventory-item");

    changeInput("input-item-quantity", "");
    fireEvent.click(screen.getByTestId("button-save-item"));

    await screen.findByText("Quantity is required");
    assert.equal(api.items[0]?.quantity, 4);
    assert.deepEqual(
      queryClient.getQueryData(getGetInventoryStatsQueryKey()),
      statsBefore,
    );
    assert.deepEqual(
      queryClient.getQueryData(getGetGrocerySuggestionsQueryKey()),
      suggestionsBefore,
    );
    assert.ok(screen.getByTestId("dialog-inventory-item"));

    changeInput("input-item-quantity", "0");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.equal(api.items[0]?.quantity, 0));

    fireEvent.click(screen.getByTestId("button-edit-1"));
    await screen.findByTestId("dialog-inventory-item");
    changeInput("input-item-quantity", "2.5");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.equal(api.items[0]?.quantity, 2.5));
  });
});

describe("inventory edit conflicts", () => {
  it("preserves the draft, reviews latest values, and saves after review", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(1, "Rice", "Pantry", 4, 1)];
    globalThis.fetch = api.fetch;
    const { queryClient } = renderApp();
    queryClient.setQueryData(getGetInventoryItemQueryKey(1), { ...api.items[0] });

    await openInventory();
    fireEvent.click(await screen.findByTestId("button-edit-1"));
    await screen.findByTestId("dialog-inventory-item");
    changeInput("input-item-notes", "Keep my draft");
    api.items[0] = { ...api.items[0]!, quantity: 7, unit: "grams", revision: 1 };

    fireEvent.click(screen.getByTestId("button-save-item"));
    await screen.findByTestId("inventory-conflict");
    assert.equal(
      (screen.getByTestId("input-item-notes") as HTMLTextAreaElement).value,
      "Keep my draft",
    );

    await acknowledgeConflict();
    await waitFor(() => {
      assert.equal(
        (screen.getByTestId("input-item-quantity") as HTMLInputElement).value,
        "7",
      );
      assert.equal(screen.queryByTestId("inventory-conflict"), null);
    });
    assert.equal((screen.getByTestId("input-item-unit") as HTMLSelectElement).value, "Custom");
    assert.equal((screen.getByTestId("input-item-custom-unit") as HTMLInputElement).value, "grams");
    changeInput("input-item-notes", "Reviewed latest");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => {
      assert.equal(api.items[0]?.notes, "Reviewed latest");
      assert.equal(api.items[0]?.revision, 2);
    });
    assert.deepEqual(
      queryClient.getQueryData(getGetInventoryItemQueryKey(1)),
      api.items[0],
    );
    assert.equal(screen.queryByTestId("dialog-inventory-item"), null);
  });

  it("disables editing while delayed latest values refresh untouched fields", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(1, "Rice", "Pantry", 4, 1)];
    globalThis.fetch = api.fetch;
    renderApp();

    await openInventory();
    fireEvent.click(await screen.findByTestId("button-edit-1"));
    changeInput("input-item-notes", "Draft that will be replaced");
    api.items[0] = { ...api.items[0]!, quantity: 7, notes: "Saved elsewhere", revision: 1 };
    api.inventoryItemGetMode = "pending";
    fireEvent.click(screen.getByTestId("button-save-item"));
    await screen.findByTestId("inventory-conflict");

    await screen.findByText("Loading latest...");
    assert.equal((screen.getByTestId("input-item-notes") as HTMLTextAreaElement).disabled, true);
    assert.equal((screen.getByTestId("button-save-item") as HTMLButtonElement).disabled, true);
    assert.equal(
      screen.getByText(/Review latest refreshes untouched fields/).textContent?.includes("draft is preserved"),
      true,
    );

    await act(async () => {
      api.resolveInventoryItemGet?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      assert.equal((screen.getByTestId("input-item-quantity") as HTMLInputElement).value, "7");

    });
    await acknowledgeConflict();
    assert.equal((screen.getByTestId("input-item-notes") as HTMLTextAreaElement).value, "Draft that will be replaced");
    assert.ok(screen.getByText("Conflicting change: notes"));
    assert.equal((screen.getByTestId("button-save-item") as HTMLButtonElement).disabled, true);
    fireEvent.click(screen.getByRole("button", { name: "Use saved notes" }));
    assert.equal((screen.getByTestId("input-item-notes") as HTMLTextAreaElement).value, "Saved elsewhere");
    assert.equal((screen.getByTestId("input-item-notes") as HTMLTextAreaElement).disabled, false);
  });

  it("ignores delayed recovery after dismiss and reopen", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(1, "Rice", "Pantry", 4, 1)];
    globalThis.fetch = api.fetch;
    renderApp();

    await openInventory();
    fireEvent.click(await screen.findByTestId("button-edit-1"));
    changeInput("input-item-notes", "Original draft");
    api.items[0] = { ...api.items[0]!, quantity: 7, revision: 1 };
    api.inventoryItemGetMode = "pending";
    fireEvent.click(screen.getByTestId("button-save-item"));
    await screen.findByTestId("inventory-conflict");
    await screen.findByText("Loading latest...");

    fireEvent.click(screen.getByTestId("button-cancel"));
    await waitFor(() => assert.equal(screen.queryByTestId("dialog-inventory-item"), null));
    fireEvent.click(screen.getByTestId("button-edit-1"));
    await screen.findByTestId("dialog-inventory-item");
    changeInput("input-item-notes", "Reopened draft");

    await act(async () => {
      api.resolveInventoryItemGet?.();
      await Promise.resolve();
    });
    assert.equal((screen.getByTestId("input-item-notes") as HTMLTextAreaElement).value, "Reopened draft");
    assert.equal(screen.queryByText("Latest item loaded"), null);
    assert.equal((screen.getByTestId("input-item-notes") as HTMLTextAreaElement).disabled, false);
  });

  it("preserves the draft and conflict when the item was deleted during recovery", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(1, "Rice", "Pantry", 4, 1)];
    globalThis.fetch = api.fetch;
    renderApp();

    await openInventory();
    fireEvent.click(await screen.findByTestId("button-edit-1"));
    changeInput("input-item-notes", "Keep after deletion");
    api.items[0] = { ...api.items[0]!, revision: 1 };
    api.inventoryItemGetMode = "pending";
    fireEvent.click(screen.getByTestId("button-save-item"));
    await screen.findByTestId("inventory-conflict");
    api.items = [];
    await act(async () => { api.resolveInventoryItemGet?.(); });

    await waitFor(() => {
      assert.equal((screen.getByTestId("input-item-notes") as HTMLTextAreaElement).value, "Keep after deletion");
      assert.ok(screen.getByTestId("inventory-conflict"));
      assert.equal((screen.getByTestId("input-item-notes") as HTMLTextAreaElement).disabled, true);
      assert.equal(screen.queryByText("Loading latest..."), null);
    });
  });

  it("requires another review when a write intervenes after recovery", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(1, "Rice", "Pantry", 4, 1)];
    globalThis.fetch = api.fetch;
    renderApp();

    await openInventory();
    fireEvent.click(await screen.findByTestId("button-edit-1"));
    await screen.findByTestId("dialog-inventory-item");
    changeInput("input-item-notes", "Keep draft through review");
    api.items[0] = { ...api.items[0]!, revision: 1, quantity: 6 };
    fireEvent.click(screen.getByTestId("button-save-item"));
    await screen.findByTestId("inventory-conflict");
    await acknowledgeConflict();
    await waitFor(() => {
      assert.equal((screen.getByTestId("input-item-quantity") as HTMLInputElement).value, "6");
      assert.equal(screen.queryByTestId("inventory-conflict"), null);
    });

    api.items[0] = { ...api.items[0]!, revision: 2, quantity: 8 };
    changeInput("input-item-notes", "Must review again");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await screen.findByTestId("inventory-conflict");
    assert.equal(api.items[0]?.notes, null);
    assert.ok(screen.getByTestId("dialog-inventory-item"));
  });
});

describe("inventory native validation", () => {
  it("keeps the edit dialog open when native invalid is raised", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(1, "Rice", "Pantry", 4, 1)];
    globalThis.fetch = api.fetch;
    renderApp("/inventory");
    await screen.findByTestId("inventory-item-1");
    fireEvent.click(screen.getByTestId("button-edit-1"));

    await screen.findByTestId("dialog-inventory-item");
    const quantity = screen.getByTestId("input-item-quantity");
    let invalidEvents = 0;
    quantity.addEventListener("invalid", () => invalidEvents += 1, { once: true });

    // JSDOM does not implement native number step validation; dispatch the event
    // explicitly here while the real-browser check verifies validity.stepMismatch.
    quantity.dispatchEvent(new Event("invalid", { bubbles: true, cancelable: true }));

    assert.equal(invalidEvents, 1);
    assert.ok(screen.getByTestId("dialog-inventory-item"));
    assert.equal(api.inventoryUpdateBodies.length, 0);
  });
});

describe("inventory optional field clearing", () => {
  it("persists expiry-only, notes-only, and combined clearing", async () => {
    const api = new GroceryApiMock();
    api.items = [dashboardItem(1, "Rice", "Pantry", 4, 1)];
    api.items[0]!.expiresAt = "2026-12-01";
    api.items[0]!.notes = "Keep dry";
    globalThis.fetch = api.fetch;
    const { queryClient } = renderApp();

    await openInventory();
    fireEvent.click(await screen.findByTestId("button-edit-1"));
    await screen.findByTestId("dialog-inventory-item");
    changeInput("input-item-expires", "");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.equal(api.items[0]?.expiresAt, null));
    assert.equal(api.items[0]?.notes, "Keep dry");
    assert.deepEqual(api.inventoryUpdateBodies.at(-1), {
      expiresAt: null,
      revision: 0,
    });

    fireEvent.click(screen.getByTestId("button-edit-1"));
    await screen.findByTestId("dialog-inventory-item");
    changeInput("input-item-expires", "2027-01-15");
    changeInput("input-item-notes", "");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => assert.equal(api.items[0]?.expiresAt, "2027-01-15"));
    assert.equal(api.items[0]?.notes, null);
    assert.deepEqual(api.inventoryUpdateBodies.at(-1), {
      expiresAt: "2027-01-15",
      notes: null,
      revision: 1,
    });

    fireEvent.click(screen.getByTestId("button-edit-1"));
    await screen.findByTestId("dialog-inventory-item");
    changeInput("input-item-expires", "");
    changeInput("input-item-notes", "");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await waitFor(() => {
      assert.equal(api.items[0]?.expiresAt, null);
      assert.equal(api.items[0]?.notes, null);
    });
    assert.deepEqual(api.inventoryUpdateBodies.at(-1), {
      expiresAt: null,
      revision: 2,
    });

    fireEvent.click(screen.getByTestId("button-edit-1"));
    await screen.findByTestId("dialog-inventory-item");
    assert.equal(
      (screen.getByTestId("input-item-expires") as HTMLInputElement).value,
      "",
    );
    assert.equal(
      (screen.getByTestId("input-item-notes") as HTMLTextAreaElement).value,
      "",
    );
  });
});

describe("inventory units and card labels", () => {
  it("offers preset guidance, rejects numeric units, and labels notes", async () => {
    const api = new GroceryApiMock();
    api.items = [
      { ...dashboardItem(1, "Biscuits", "Pantry", 2, 1), unit: "piece", notes: "Keep dry" },
    ];
    globalThis.fetch = api.fetch;
    const { queryClient } = renderApp();

    await openInventory();
    await screen.findByTestId("inventory-item-1");
    assert.ok(screen.getByTestId("input-search"));
    assert.ok(screen.getByText("2 pieces"));
    assert.ok(screen.getByText("Minimum: 1 piece"));
    assert.ok(screen.getByText("Notes:"));
    assert.ok(screen.getByText("Keep dry"));

    fireEvent.click(screen.getByTestId("button-edit-1"));
    await screen.findByTestId("dialog-inventory-item");
    const unitSelect = screen.getByTestId("input-item-unit") as HTMLSelectElement;
    const unitLabel = screen.getByText("Unit", { selector: "label" }) as HTMLLabelElement;
    assert.equal(unitLabel.htmlFor, unitSelect.id);
    assert.ok(unitSelect.getAttribute("aria-describedby")?.includes("form-item-description"));
    changeInput("input-item-unit", "Custom");
    changeInput("input-item-custom-unit", "grams");
    assert.equal((screen.getByTestId("input-item-custom-unit") as HTMLInputElement).value, "grams");
    changeInput("input-item-custom-unit", "2");
    fireEvent.click(screen.getByTestId("button-save-item"));
    await screen.findByText("Choose a unit or enter a custom text unit");
    assert.equal(api.items[0]?.unit, "piece");
    assert.ok(screen.getByTestId("input-item-unit").querySelector('option[value="Custom"]'));
    const customUnitInput = screen.getByTestId("input-item-custom-unit");
    assert.ok(customUnitInput);
    assert.equal(customUnitInput.getAttribute("aria-label"), "Custom unit");
    assert.equal(customUnitInput.getAttribute("aria-invalid"), "true");
    assert.ok(customUnitInput.getAttribute("aria-describedby")?.includes("form-item-message"));
    queryClient.clear();
  });
});
