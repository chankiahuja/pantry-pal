import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Bell, AlertCircle, AlertTriangle, Clock, CheckCheck, Mail, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePantryEvents } from "@/hooks/use-pantry-events";
import { useUtcDate } from "@/hooks/use-utc-date";
import { useSessionAccess } from "@/lib/preview-access";
import {
  getGetGrocerySuggestionsQueryKey,
  useGetGrocerySuggestions,
} from "@workspace/api-client-react";
import {
  deduplicateNotificationAlerts,
  markNotificationAlertsRead,
  pruneSeenNotificationIdentities,
  unreadAlertCount,
  type NotificationAlert,
} from "@/lib/notification-alerts";

const EMAIL_REMINDER_NOTE =
  "Expiry reminders by email are planned for a future release. Check your alerts here for now.";

function loadSeen(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}
function saveSeen(key: string, seen: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...seen]));
  } catch {
    // Current-session behaviour remains usable when storage is unavailable.
  }
}

const URGENCY_CONFIG = {
  expired: {
    icon: AlertCircle,
    label: "Expired",
    color: "text-red-800",
    bg: "bg-red-50",
    dot: "bg-red-700",
  },
  critical: {
    icon: AlertCircle,
    label: "Out of Stock",
    color: "text-destructive",
    bg: "bg-destructive/10",
    dot: "bg-destructive",
  },
  expiring_soon: {
    icon: Clock,
    label: "Expiring Soon",
    color: "text-orange-600",
    bg: "bg-orange-50",
    dot: "bg-orange-500",
  },
  low: {
    icon: AlertTriangle,
    label: "Low Stock",
    color: "text-amber-600",
    bg: "bg-amber-50",
    dot: "bg-amber-500",
  },
} as const;

export function NotificationCenter() {
  usePantryEvents();
  useUtcDate();
  const { account, demo } = useSessionAccess();
  const storageKey = `pantrypal-seen-notifications:${demo ? "demo" : account?.id ?? "anonymous"}`;
  const [open, setOpen] = useState(false);
  const [seenState, setSeen] = useState(() => ({ key: storageKey, values: loadSeen(storageKey) }));
  const seen = seenState.key === storageKey ? seenState.values : loadSeen(storageKey);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const {
    data: suggestions,
    isError,
    isFetching,
    isSuccess,
    refetch,
  } = useGetGrocerySuggestions({
    query: {
      queryKey: getGetGrocerySuggestionsQueryKey(),
      refetchInterval: 30_000,
    },
  });
  const hasSnapshot = Array.isArray(suggestions);
  const alerts = hasSnapshot ? deduplicateNotificationAlerts(suggestions) : [];
  const initialLoading = !hasSnapshot && !isError;
  const initialError = !hasSnapshot && isError;
  const backgroundError = hasSnapshot && isError;
  const unreadCount = unreadAlertCount(alerts, seen);
  const unresolvedCount = alerts.length;

  useEffect(() => {
    if (!isSuccess || !Array.isArray(suggestions) || seenState.key !== storageKey) return;
    const next = pruneSeenNotificationIdentities(seen, alerts);
    if (next.size === seen.size && [...next].every((identity) => seen.has(identity))) return;
    setSeen({ key: storageKey, values: next });
    saveSeen(storageKey, next);
  }, [alerts, isSuccess, seen, seenState.key, storageKey, suggestions]);

  useEffect(() => {
    if (seenState.key === storageKey) return;
    setSeen({ key: storageKey, values: loadSeen(storageKey) });
    setOpen(false);
  }, [seenState.key, storageKey]);

  useEffect(() => {
    if (!open || !isSuccess || alerts.length === 0 || seenState.key !== storageKey) return;
    const next = markNotificationAlertsRead(seen, alerts);
    if (next.size === seen.size && [...next].every((identity) => seen.has(identity))) return;
    setSeen({ key: storageKey, values: next });
    saveSeen(storageKey, next);
  }, [alerts, isSuccess, open, seen, seenState.key, storageKey]);

  useEffect(() => {
    if (!open) return;
    function handleOutsideClick(event: MouseEvent) {
      if (panelRef.current?.contains(event.target as Node) || buttonRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open]);

  const grouped = [
    { urgency: "expired" as const, items: alerts.filter(({ item }) => item.urgency === "expired") },
    { urgency: "critical" as const, items: alerts.filter(({ item }) => item.urgency === "critical") },
    { urgency: "expiring_soon" as const, items: alerts.filter(({ item }) => item.urgency === "expiring_soon") },
    { urgency: "low" as const, items: alerts.filter(({ item }) => item.urgency === "low") },
  ].filter((group) => group.items.length > 0);

  const attentionCopy = unresolvedCount === 1
    ? "1 item needs attention"
    : `${unresolvedCount} items need attention`;
  const label = initialLoading
    ? "Notifications: loading alerts"
    : initialError
      ? "Notifications: alerts unavailable"
      : unresolvedCount === 0
        ? "Notifications: no items need attention"
        : `Notifications: ${unreadCount > 0 ? `${unreadCount} unread` : "no unread alerts"}; ${attentionCopy}`;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "pantry-notification-trigger relative flex items-center justify-center w-9 h-9 rounded-lg transition-colors",
          open
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        )}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? "pantry-notification-panel" : undefined}
        data-testid="notification-bell"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-white leading-none">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
        {hasSnapshot && unreadCount === 0 && unresolvedCount > 0 && (
          <span aria-hidden="true" className="absolute top-0 right-0 h-2 w-2 rounded-full bg-amber-500" />
        )}
      </button>

      {open && (
        <div
          id="pantry-notification-panel"
          ref={panelRef}
          role="region"
          aria-label="Notifications"
          aria-busy={isFetching}
          className="pantry-notification-panel absolute right-0 top-full mt-3 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border"
          data-testid="notification-panel"
        >
          <div className="pantry-notification-panel-header flex items-center justify-between gap-2 px-4 py-3 border-b border-border">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Bell className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span className="font-semibold text-sm text-foreground">Notifications</span>
              {hasSnapshot && unresolvedCount > 0 && (
                <span className="text-xs text-muted-foreground">
                  {attentionCopy}
                </span>
              )}
            </div>
            <button
              type="button"
              aria-label="Close notifications"
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
              className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="pantry-notification-panel-body max-h-96 overflow-y-auto">
            {initialLoading ? (
              <p className="p-4 text-sm text-muted-foreground" role="status" aria-label="Loading alerts">Loading alerts…</p>
            ) : initialError ? (
              <div className="p-4 text-sm text-destructive" role="alert">
                <p>Alerts could not be loaded.</p>
                <button type="button" className="mt-2 underline underline-offset-4" onClick={() => void refetch()}>Try again</button>
              </div>
            ) : unresolvedCount === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center px-4">
                <CheckCheck className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
                <p className="text-sm font-medium text-foreground">All caught up!</p>
                <p className="text-xs text-muted-foreground">No low stock or expiry alerts right now.</p>
              </div>
            ) : (
              <>
                {backgroundError && (
                  <div className="border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground" role="alert">
                    Alerts could not be refreshed. Showing the last available alerts.
                    <button type="button" className="ml-1 underline underline-offset-4" onClick={() => void refetch()}>Try again</button>
                  </div>
                )}
                {grouped.map(({ urgency, items }) => {
                  const cfg = URGENCY_CONFIG[urgency];
                  const Icon = cfg.icon;
                  return (
                    <div key={urgency}>
                      <div className="px-4 py-2 bg-muted/40 border-b border-border">
                        <div className="flex items-center gap-1.5">
                          <span aria-hidden="true" className={cn("w-1.5 h-1.5 rounded-full", cfg.dot)} />
                          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {cfg.label} · {items.length}
                          </span>
                        </div>
                      </div>
                      {items.map(({ item: suggestion }: NotificationAlert) => (
                        <div
                          key={suggestion.inventoryItemId}
                          className={cn("flex items-start gap-3 px-4 py-3 border-b border-border/60 last:border-b-0", cfg.bg)}
                        >
                          <Icon aria-hidden="true" className={cn("h-4 w-4 mt-0.5 shrink-0", cfg.color)} />
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-foreground leading-snug break-words">
                              <Link href={`/inventory?item=${suggestion.inventoryItemId}`} onClick={() => setOpen(false)} className="hover:underline focus-visible:underline">
                                {suggestion.name}
                              </Link>
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed break-words">{suggestion.reason}</p>
                            <span className="inline-block mt-1 text-[10px] font-medium text-muted-foreground bg-background/80 border border-border/60 rounded px-1.5 py-0.5 break-words">
                              {suggestion.category}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </>
            )}
          </div>

          <div className="border-t border-border px-3 py-3">
            <div className="flex items-start gap-2 rounded-lg border border-[#b9cdb0] bg-[#e6ecdc] px-3 py-3 text-[#314634] dark:border-[#526b56] dark:bg-[#28382b] dark:text-[#e7f0e4]" data-testid="notification-email-reminder-note">
              <Mail className="mt-0.5 h-4 w-4 shrink-0 text-[#526e49] dark:text-[#b8d2ba]" aria-hidden="true" />
              <div className="min-w-0">
                <h3 className="text-sm font-semibold leading-5">Email reminders — coming later</h3>
                <p className="mt-1 text-[13px] leading-relaxed">{EMAIL_REMINDER_NOTE}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
