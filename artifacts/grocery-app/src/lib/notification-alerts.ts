import type { GrocerySuggestion } from "@workspace/api-client-react";

export type NotificationUrgency = GrocerySuggestion["urgency"];

export type NotificationAlert = {
  item: GrocerySuggestion;
  identities: string[];
};

const PRIORITY: NotificationUrgency[] = ["expired", "critical", "expiring_soon", "low"];

export function notificationIdentity(suggestion: GrocerySuggestion): string | null {
  if (suggestion.inventoryItemId == null) return null;
  return `${suggestion.inventoryItemId}::${suggestion.urgency}::${suggestion.reason}`;
}

function compareSuggestions(a: GrocerySuggestion, b: GrocerySuggestion): number {
  const urgency = PRIORITY.indexOf(a.urgency) - PRIORITY.indexOf(b.urgency);
  if (urgency !== 0) return urgency;
  return a.reason.localeCompare(b.reason, "en", { sensitivity: "base" })
    || a.reason.localeCompare(b.reason)
    || a.name.localeCompare(b.name, "en", { sensitivity: "base" })
    || a.name.localeCompare(b.name);
}

/** Collapse the successfully loaded suggestion snapshot to one row per inventory item. */
export function deduplicateNotificationAlerts(suggestions: GrocerySuggestion[]): NotificationAlert[] {
  const grouped = new Map<number, GrocerySuggestion[]>();
  for (const suggestion of suggestions) {
    if (suggestion.inventoryItemId == null) continue;
    const current = grouped.get(suggestion.inventoryItemId) ?? [];
    current.push(suggestion);
    grouped.set(suggestion.inventoryItemId, current);
  }

  return [...grouped.values()]
    .map((items) => {
      const ordered = [...items].sort(compareSuggestions);
      return {
        item: ordered[0],
        identities: ordered
          .map(notificationIdentity)
          .filter((identity): identity is string => identity !== null),
      };
    })
    .sort((a, b) => {
      const urgency = PRIORITY.indexOf(a.item.urgency) - PRIORITY.indexOf(b.item.urgency);
      if (urgency !== 0) return urgency;
      return a.item.name.localeCompare(b.item.name, "en", { sensitivity: "base" })
        || a.item.name.localeCompare(b.item.name)
        || (a.item.inventoryItemId ?? 0) - (b.item.inventoryItemId ?? 0);
    });
}

export function unresolvedAlertCount(alerts: NotificationAlert[]): number {
  return alerts.length;
}

export function unreadAlertCount(alerts: NotificationAlert[], seen: Set<string>): number {
  return alerts.filter((alert) => alert.identities.some((identity) => !seen.has(identity))).length;
}

export function notificationIdentities(alerts: NotificationAlert[]): Set<string> {
  return new Set(alerts.flatMap((alert) => alert.identities));
}

export function pruneSeenNotificationIdentities(
  seen: Set<string>,
  alerts: NotificationAlert[],
): Set<string> {
  const active = notificationIdentities(alerts);
  return new Set([...seen].filter((identity) => active.has(identity)));
}

export function markNotificationAlertsRead(
  seen: Set<string>,
  alerts: NotificationAlert[],
): Set<string> {
  return new Set([...seen, ...notificationIdentities(alerts)]);
}
