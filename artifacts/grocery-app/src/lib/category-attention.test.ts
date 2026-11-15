import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InventoryItem } from "@workspace/api-client-react";
import { getAttentionItems, isExpired, isExpiringSoon, isShoppingEligible } from "./category-attention";

const now = new Date("2026-01-01T23:30:00Z");
function item(id: number, name: string, quantity: number, minThreshold: number, expiresAt: string | null = null, category = "Pantry"): InventoryItem {
  return { id, name, category, quantity, unit: "piece", minThreshold, expiresAt, notes: null, revision: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
}

describe("attention state", () => {
  it("uses UTC boundaries and suppresses expiry for zero stock", () => {
    assert.equal(isExpired("2025-12-31", now), true);
    assert.equal(isExpiringSoon("2026-01-01", now), true);
    assert.equal(isExpiringSoon("2026-01-08", now), true);
    assert.equal(isExpiringSoon("2026-01-09", now), false);
    const rows = getAttentionItems([
      item(1, "Expired low", 1, 2, "2025-12-31"),
      item(2, "Past empty", 0, 2, "2025-12-31"),
      item(3, "Today empty", 0, 2, "2026-01-01"),
      item(4, "Day eight", 4, 1, "2026-01-09"),
    ], now);
    assert.deepEqual(rows.map((row) => row.id), [1, 2, 3]);
    assert.equal(rows[0]?.primaryStatus, "expired");
    assert.equal(rows[0]?.conditions.lowStock, true);
    assert.equal(rows[1]?.conditions.expired, false);
  });

  it("deduplicates by ID, applies priority, expiry, name, and ID tie-breakers", () => {
    const rows = getAttentionItems([
      item(9, "Same", 1, 2),
      item(3, "Same", 1, 2),
      item(8, "Soon late", 4, 1, "2026-01-08"),
      item(7, "Soon early", 4, 1, "2026-01-01"),
      item(6, "Empty", 0, 1, "2025-12-01"),
      item(4, "Expired", 4, 1, "2025-12-20"),
      item(4, "Duplicate should be ignored", 0, 1),
    ], now);
    assert.deepEqual(rows.map((row) => row.id), [4, 6, 7, 8, 3, 9]);
    assert.deepEqual(getAttentionItems([...rows].reverse(), now).map((row) => row.id), [4, 6, 7, 8, 3, 9]);
  });

  it("keeps stock eligibility independent of primary urgency", () => {
    assert.equal(isShoppingEligible(item(1, "Expired low", 1, 2, "2025-12-31")), true);
    assert.equal(isShoppingEligible(item(2, "Expired only", 4, 1, "2025-12-31")), false);
    assert.equal(isShoppingEligible(item(3, "Empty", 0, 0, "2026-01-01")), true);
    assert.equal(isShoppingEligible(item(4, "Threshold zero", 1, 0)), false);
  });
});
