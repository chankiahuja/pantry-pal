import type { InventoryItem } from "@workspace/api-client-react";

export type AttentionCondition = "expired" | "outOfStock" | "expiringSoon" | "lowStock";
export type AttentionStatus = AttentionCondition;
export type AttentionItem = InventoryItem & {
  conditions: Record<AttentionCondition, boolean>;
  primaryStatus: AttentionStatus;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const PRIORITY: AttentionStatus[] = ["expired", "outOfStock", "expiringSoon", "lowStock"];

export function utcDate(value: Date | string = new Date()): string {
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

export function isExpired(expiresAt: string | null | undefined, now = new Date()): boolean {
  return !!expiresAt && expiresAt.slice(0, 10) < utcDate(now);
}

export function isExpiringSoon(expiresAt: string | null | undefined, now = new Date()): boolean {
  const expirationDate = expiresAt?.slice(0, 10);
  if (!expirationDate) return false;
  const today = utcDate(now);
  const sevenDaysFromNow = utcDate(new Date(new Date(`${today}T00:00:00Z`).getTime() + 7 * DAY_MS));
  return expirationDate >= today && expirationDate <= sevenDaysFromNow;
}

function conditionsFor(item: InventoryItem, now: Date): AttentionItem["conditions"] {
  const outOfStock = item.quantity === 0;
  const hasStock = item.quantity > 0;
  return {
    outOfStock,
    lowStock: hasStock && item.quantity <= item.minThreshold,
    expired: hasStock && isExpired(item.expiresAt, now),
    expiringSoon: hasStock && isExpiringSoon(item.expiresAt, now),
  };
}

function primaryStatusFor(conditions: AttentionItem["conditions"]): AttentionStatus {
  if (conditions.expired) return "expired";
  if (conditions.outOfStock) return "outOfStock";
  if (conditions.expiringSoon) return "expiringSoon";
  return "lowStock";
}

/** Build canonical, deduplicated dashboard rows from inventory. */
export function getAttentionItems(items: InventoryItem[], now = new Date()): AttentionItem[] {
  const byId = new Map<number, AttentionItem>();
  for (const item of items) {
    if (byId.has(item.id)) continue;
    const conditions = conditionsFor(item, now);
    if (!Object.values(conditions).some(Boolean)) continue;
    byId.set(item.id, { ...item, conditions, primaryStatus: primaryStatusFor(conditions) });
  }
  return [...byId.values()].sort(compareAttentionItems);
}

/** Stable urgency ordering: expiry date, name, then numeric inventory ID. */
export function compareAttentionItems(a: AttentionItem, b: AttentionItem): number {
  const priority = PRIORITY.indexOf(a.primaryStatus) - PRIORITY.indexOf(b.primaryStatus);
  if (priority !== 0) return priority;
  if ((a.primaryStatus === "expired" || a.primaryStatus === "expiringSoon") && a.expiresAt && b.expiresAt) {
    const expiry = a.expiresAt.slice(0, 10).localeCompare(b.expiresAt.slice(0, 10));
    if (expiry !== 0) return expiry;
  }
  const name = a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.name.localeCompare(b.name);
  return name || a.id - b.id;
}

/** Shopping eligibility is stock-based, independent of primary urgency. */
export function isShoppingEligible(item: InventoryItem): boolean {
  return item.id != null && (item.quantity === 0 || (item.quantity > 0 && item.quantity <= item.minThreshold));
}

// Compatibility for inventory consumers that still use category summaries.
export type CategoryAttention = {
  category: string;
  attentionItems: number;
  outOfStock: number;
  lowStock: number;
  expiringSoon: number;
  expired: number;
};

export function getCategoryAttention(items: InventoryItem[], now = new Date()): CategoryAttention[] {
  const grouped = new Map<string, CategoryAttention>();
  for (const item of items) {
    const current = grouped.get(item.category) ?? {
      category: item.category, attentionItems: 0, outOfStock: 0, lowStock: 0, expiringSoon: 0, expired: 0,
    };
    const conditions = conditionsFor(item, now);
    if (conditions.outOfStock) current.outOfStock++;
    if (conditions.lowStock) current.lowStock++;
    if (conditions.expiringSoon) current.expiringSoon++;
    if (conditions.expired) current.expired++;
    if (Object.values(conditions).some(Boolean)) current.attentionItems++;
    grouped.set(item.category, current);
  }
  return [...grouped.values()]
    .filter((category) => category.attentionItems > 0)
    .sort((a, b) => b.expired - a.expired || b.outOfStock - a.outOfStock || b.expiringSoon - a.expiringSoon || b.lowStock - a.lowStock || a.category.localeCompare(b.category));
}
