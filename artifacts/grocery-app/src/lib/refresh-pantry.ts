import type { QueryClient } from "@tanstack/react-query";
import {
  getGetInventoryItemQueryKey,
  getListInventoryItemsQueryKey,
  getGetInventoryStatsQueryKey,
  getGetGrocerySuggestionsQueryKey,
  type InventoryItem,
} from "@workspace/api-client-react";

/** Suggestions also supply the notification bell's recoverable alert snapshot. */
export function refreshPantry(client: QueryClient, item?: InventoryItem, options?: { refetchItemDetails?: boolean }) {
  if (item) {
    client.setQueryData(getGetInventoryItemQueryKey(item.id), item);
    client.setQueriesData<InventoryItem[]>(
      { queryKey: getListInventoryItemsQueryKey() },
      (items) =>
        items?.map((existing) => (existing.id === item.id ? item : existing)),
    );
  }
  for (const queryKey of [
    getListInventoryItemsQueryKey(),
    getGetInventoryStatsQueryKey(),
    getGetGrocerySuggestionsQueryKey(),
    ...(item ? [getGetInventoryItemQueryKey(item.id)] : []),
  ]) {
    void client.invalidateQueries({ queryKey });
  }
  // Logout rollback can reconcile a write whose response was suppressed, so
  // its item is unknown. Refetch cached details as well as the pantry views.
  if (options?.refetchItemDetails) {
    void client.invalidateQueries({
      predicate: ({ queryKey }) => typeof queryKey[0] === "string" && /^\/api\/inventory\/\d+$/.test(queryKey[0]),
      refetchType: "all",
    });
  }
}
