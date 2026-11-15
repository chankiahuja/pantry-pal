import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GrocerySuggestion } from "@workspace/api-client-react";
import {
  deduplicateNotificationAlerts,
  markNotificationAlertsRead,
  notificationIdentity,
  notificationIdentities,
  pruneSeenNotificationIdentities,
  unreadAlertCount,
  unresolvedAlertCount,
} from "./notification-alerts";

function suggestion(
  id: number | null,
  name: string,
  urgency: GrocerySuggestion["urgency"],
  reason = `${name} reason`,
): GrocerySuggestion {
  return {
    inventoryItemId: id,
    name,
    category: "Pantry",
    currentQuantity: urgency === "critical" ? 0 : 1,
    minThreshold: 2,
    unit: "each",
    urgency,
    reason,
  };
}

describe("notification alert helpers", () => {
  it("deduplicates by non-null inventory ID and keeps the highest-priority row", () => {
    const alerts = deduplicateNotificationAlerts([
      suggestion(null, "Ignored", "low"),
      suggestion(2, "Milk", "low"),
      suggestion(2, "Milk", "expiring_soon", "Expires tomorrow; 1 each left"),
      suggestion(1, "Eggs", "critical"),
    ]);
    assert.deepEqual(alerts.map(({ item }) => item.inventoryItemId), [1, 2]);
    assert.equal(alerts[1]?.item.urgency, "expiring_soon");
    assert.equal(unresolvedAlertCount(alerts), 2);
  });

  it("uses priority, name, and numeric ID deterministically", () => {
    const input = [
      suggestion(9, "Same", "low"),
      suggestion(3, "Same", "low"),
      suggestion(8, "Soon", "expiring_soon"),
      suggestion(7, "Soon", "expiring_soon"),
      suggestion(6, "Empty", "critical"),
      suggestion(4, "Expired", "expired"),
    ];
    const order = deduplicateNotificationAlerts(input).map(({ item }) => item.inventoryItemId);
    assert.deepEqual(order, [4, 6, 7, 8, 3, 9]);
    assert.deepEqual(
      deduplicateNotificationAlerts([...input].reverse()).map(({ item }) => item.inventoryItemId),
      order,
    );
  });

  it("tracks identities, read counts, and safe inactive pruning", () => {
    const alerts = deduplicateNotificationAlerts([
      suggestion(1, "Milk", "low"),
      suggestion(1, "Milk", "expiring_soon", "Expires tomorrow"),
      suggestion(2, "Eggs", "critical"),
    ]);
    const lowIdentity = notificationIdentity(suggestion(1, "Milk", "low"));
    assert.ok(lowIdentity);
    const seen = new Set([lowIdentity, "inactive"]);
    assert.equal(unreadAlertCount(alerts, seen), 2);
    assert.equal(notificationIdentities(alerts).size, 3);
    assert.deepEqual([...pruneSeenNotificationIdentities(seen, alerts)], [lowIdentity]);
    assert.equal(unreadAlertCount(alerts, markNotificationAlertsRead(seen, alerts)), 0);
  });
});
