import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/shopping-lists/20",
});
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
});

const { copyMessageToClipboard, formatStoreGreeting } = await import("./whatsapp-store-handoff");

afterEach(() => {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});
after(() => dom.window.close());

test("clipboard rejection leaves the preview available for manual copying", async () => {
  const message = "Hello Sharma Kirana,\n\n- Rice: 2 kg";
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => { throw new Error("denied"); } },
  });

  assert.equal(await copyMessageToClipboard(message), false);
  assert.equal(message, "Hello Sharma Kirana,\n\n- Rice: 2 kg");
});

test("missing clipboard support is reported as unavailable", async () => {
  assert.equal(await copyMessageToClipboard("preview"), false);
});

test("preview greeting uses the typed store name and stays blank-safe", () => {
  assert.equal(formatStoreGreeting("Sharma Kirana"), "Hello Sharma Kirana,");
  assert.equal(formatStoreGreeting(""), "Hello,");
});
