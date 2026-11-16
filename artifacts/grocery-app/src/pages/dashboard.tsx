import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { AlertCircle, ArrowRight, CheckCircle2, Clock, Package, RefreshCw, ShoppingCart } from "lucide-react";
import {
  getListShoppingListsQueryKey,
  getInventoryItem,
  type InventoryItem,
  useGenerateShoppingListFromSuggestions,
  useGetGrocerySuggestions,
  useGetInventoryStats,
  useListInventoryItems,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { StatCard } from "@/components/stat-card";
import { UrgencyBadge } from "@/components/urgency-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatQuantity } from "@/lib/inventory-units";
import { getAttentionItems, isShoppingEligible, type AttentionItem } from "@/lib/category-attention";
import { useToast } from "@/hooks/use-toast";
import { useUtcDate } from "@/hooks/use-utc-date";
import { InventoryItemDialog } from "@/components/inventory-item-dialog";
import { refreshPantry } from "@/lib/refresh-pantry";
import { useSessionAccess } from "@/lib/preview-access";

type ReviewItem = {
  inventoryItemId: number;
  name: string;
  category: string;
  unit: string;
  currentQuantity: number;
  quantity: number;
  reason: string;
};

const statusUrgency = {
  expired: "expired",
  outOfStock: "critical",
  expiringSoon: "expiring_soon",
  lowStock: "low",
} as const;

function AttentionRow({ item, onEdit, loading }: { item: AttentionItem; onEdit: (id: number, button: HTMLButtonElement) => void; loading: boolean }) {
  const { conditions } = item;
  return (
    <div className="dashboard-attention-row" data-testid={`attention-item-${item.id}`}>
      <div className="dashboard-attention-icon" aria-hidden="true"><Package className="h-5 w-5" /></div>
      <div className="dashboard-attention-details">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Link href={`/inventory?item=${item.id}`} className="dashboard-attention-item-link">{item.name}</Link>
          <UrgencyBadge className="dashboard-attention-status" urgency={statusUrgency[item.primaryStatus]} />
          {conditions.lowStock && item.primaryStatus !== "lowStock" ? <UrgencyBadge className="dashboard-attention-status" urgency="low" /> : null}
        </div>
        <div className="dashboard-attention-meta">
          <span>{item.category}</span>
          <span>{formatQuantity(item.quantity, item.unit)} on hand</span>
          <span>Min {formatQuantity(item.minThreshold, item.unit)}</span>
          {conditions.expired && item.expiresAt ? <span>Expired on {item.expiresAt}</span> : null}
          {conditions.expiringSoon && item.expiresAt ? <span>Use by {item.expiresAt}</span> : null}
        </div>
      </div>
      <div className="dashboard-attention-action-slot"><Button type="button" variant="ghost" size="sm" disabled={loading} aria-label={`Edit ${item.name}`} onClick={(event) => onEdit(item.id, event.currentTarget)}>Edit</Button></div>
    </div>
  );
}

export default function Dashboard() {
  const utcDay = useUtcDate();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { account, demo } = useSessionAccess();
  const scope = `${demo}:${account?.id ?? "anonymous"}`;
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [editingItem, setEditingItem] = useState<InventoryItem>();
  const [editorScope, setEditorScope] = useState(scope);
  const [itemError, setItemError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const editSession = useRef(0);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const editTrigger = useRef<HTMLButtonElement | null>(null);
  const attentionFilter = useRef<HTMLSelectElement | null>(null);
  const closeEditor = () => { editSession.current++; setSelectedItemId(null); setEditingItem(undefined); setItemError(""); };
  useEffect(() => { closeEditor(); editTrigger.current = null; }, [scope]);
  useEffect(() => {
    if (selectedItemId === null || editorScope !== scope) return;
    const controller = new AbortController();
    const session = editSession.current;
    setItemError("");
    void getInventoryItem(selectedItemId, { signal: controller.signal }).then((item) => {
      if (!controller.signal.aborted && editSession.current === session && currentScope.current === scope) setEditingItem(item);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted || editSession.current !== session || currentScope.current !== scope) return;
      const missing = typeof failure === "object" && failure !== null && "status" in failure && failure.status === 404;
      setItemError(missing ? "This item is no longer available. It may have been deleted or become inaccessible." : "Unable to load this item. Try again or close this dialog.");
      refreshPantry(queryClient);
    });
    return () => controller.abort();
  }, [selectedItemId, loadAttempt, editorScope, scope, queryClient]);
  const openEditor = (id: number, button: HTMLButtonElement) => {
    editSession.current++;
    editTrigger.current = button;
    setEditingItem(undefined);
    setItemError("");
    setEditorScope(scope);
    setSelectedItemId(id);
  };
  const returnEditFocus = (event: Event) => {
    event.preventDefault();
    const trigger = editTrigger.current;
    (trigger?.isConnected ? trigger : attentionFilter.current)?.focus();
  };
  const {
    data: stats,
    isLoading: statsLoading,
    isError: statsError,
    refetch: refetchStats,
  } = useGetInventoryStats();
  const {
    data: suggestions,
    isLoading: suggestionsLoading,
    isError: suggestionsError,
    isFetching: suggestionsFetching,
    refetch: refetchSuggestions,
  } = useGetGrocerySuggestions();
  const generateList = useGenerateShoppingListFromSuggestions();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [attentionCategory, setAttentionCategory] = useState("All categories");
  const [attentionExpanded, setAttentionExpanded] = useState(false);
  const {
    data: inventoryItems,
    isLoading: inventoryLoading,
    isError: inventoryError,
    isFetching: inventoryFetching,
    refetch: refetchInventory,
  } = useListInventoryItems();

  const attentionItems = useMemo(
    () => getAttentionItems(inventoryItems ?? [], new Date(`${utcDay}T00:00:00Z`)),
    [inventoryItems, utcDay],
  );
  const categories = useMemo(
    () => ["All categories", ...new Set([...(inventoryItems ?? []).map((item) => item.category), ...(attentionCategory !== "All categories" ? [attentionCategory] : [])].sort((a, b) => a.localeCompare(b)))],
    [inventoryItems, attentionCategory],
  );
  const filteredAttentionItems = useMemo(
    () => attentionItems.filter((item) => attentionCategory === "All categories" || item.category === attentionCategory),
    [attentionCategory, attentionItems],
  );
  const visibleAttentionItems = attentionExpanded ? filteredAttentionItems : filteredAttentionItems.slice(0, 6);
  const hasStockSuggestions = suggestions !== undefined && suggestions.some((suggestion) => suggestion.inventoryItemId != null && (
    suggestion.currentQuantity === 0 || (suggestion.currentQuantity > 0 && suggestion.currentQuantity <= suggestion.minThreshold)
  ));

  const handleGenerateShoppingList = async () => {
    const candidates = new Map<number, ReviewItem>();
    for (const suggestion of suggestions ?? []) {
      if (suggestion.inventoryItemId == null || !isShoppingEligible({
        id: suggestion.inventoryItemId,
        name: suggestion.name,
        category: suggestion.category,
        quantity: suggestion.currentQuantity,
        unit: suggestion.unit,
        minThreshold: suggestion.minThreshold,
        expiresAt: null,
        notes: null,
        revision: 0,
        createdAt: "",
        updatedAt: "",
      })) continue;
      if (!candidates.has(suggestion.inventoryItemId)) {
        candidates.set(suggestion.inventoryItemId, {
          inventoryItemId: suggestion.inventoryItemId,
          name: suggestion.name,
          category: suggestion.category,
          unit: suggestion.unit,
          currentQuantity: suggestion.currentQuantity,
          quantity: Math.max(suggestion.minThreshold - suggestion.currentQuantity, 1),
          reason: suggestion.reason,
        });
      }
    }
    const items = [...candidates.values()];
    if (!items.length) {
      toast({ title: "No stock shortages remain", description: "Refresh suggestions and try again." });
      void refetchSuggestions();
      return;
    }
    setReviewItems(items);
    setReviewOpen(true);
  };

  const handleConfirmShoppingList = async () => {
    try {
      const list = await generateList.mutateAsync({ data: { items: reviewItems.map(({ inventoryItemId, quantity }) => ({ inventoryItemId, quantity })) } });
      await queryClient.invalidateQueries({ queryKey: getListShoppingListsQueryKey() });
      toast({ title: "Shopping list generated", description: `${list.items.length} item${list.items.length === 1 ? "" : "s"} added from low-stock suggestions.` });
      setReviewOpen(false);
      setLocation(`/shopping-lists/${list.id}`);
    } catch {
      toast({ title: "Could not generate a shopping list", description: "Refresh your suggestions and try again.", variant: "destructive" });
    }
  };

  const renderReview = () => (
    <div className="dashboard-review space-y-5" data-testid="shopping-list-preview">
      <div><h3 className="text-lg font-semibold">Review shopping list</h3><p className="text-sm text-muted-foreground">Adjust quantities or remove items before creating the list.</p></div>
      {[...new Set(reviewItems.map((item) => item.category))].map((category) => (
        <section key={category} className="space-y-2"><h4 className="font-medium">{category}</h4>
          {reviewItems.filter((item) => item.category === category).map((item) => (
            <div key={item.inventoryItemId} className="dashboard-review-item" data-testid={`preview-item-${item.inventoryItemId}`}>
              <div className="dashboard-review-name"><p className="font-medium">{item.name}</p><p className="text-xs text-muted-foreground">{item.reason}</p></div>
              <span className="dashboard-review-current text-xs text-muted-foreground">Current: {formatQuantity(item.currentQuantity, item.unit)}</span>
              <Input type="number" min="0" step="any" value={item.quantity} aria-label={`${item.name} quantity`} className="dashboard-review-quantity w-24" onChange={(event) => {
                const quantity = Number(event.target.value);
                setReviewItems((previous) => previous.map((candidate) => candidate.inventoryItemId === item.inventoryItemId ? { ...candidate, quantity: Number.isFinite(quantity) ? quantity : 0 } : candidate));
              }} />
              <span className="dashboard-review-unit text-sm">{item.unit}</span>
              <Button type="button" variant="ghost" size="sm" className="dashboard-review-remove" aria-label={`Remove ${item.name} from shopping list review`} onClick={() => setReviewItems((previous) => previous.filter((candidate) => candidate.inventoryItemId !== item.inventoryItemId))}>Remove</Button>
            </div>
          ))}
        </section>
      ))}
      <div className="flex flex-wrap justify-end gap-3"><Button type="button" variant="outline" onClick={() => setReviewOpen(false)}>Cancel</Button><Button type="button" onClick={handleConfirmShoppingList} disabled={generateList.isPending || reviewItems.length === 0}>{generateList.isPending ? "Creating..." : "Create shopping list"}</Button></div>
    </div>
  );

  return (
    <Layout><div className="dashboard-page flex flex-col gap-8">
      <h1 className="sr-only">Dashboard</h1>
      <div className="dashboard-intro"><span className="pantry-eyebrow">A little more in order</span><h2 className="text-3xl font-bold tracking-tight">Make room for the everyday.</h2><p className="text-muted-foreground mt-1">A calmer home starts with the little things.</p></div>
      <section className="pantry-hero" aria-label="Your home. A little more together."><img src={`${import.meta.env?.BASE_URL ?? "/"}brand/household.png`} alt="" fetchPriority="high" /><div className="pantry-hero-copy"><span className="pantry-eyebrow">Your home. A little more together.</span><h3>Life’s little essentials.<br />All in one place.</h3><p>From the laundry shelf to the breakfast cupboard. A little less keeping track, a little more living.</p><Link href="/inventory">Step into your home <ArrowRight className="h-4 w-4" /></Link></div></section>
      <div className="dashboard-stats pantry-stats grid grid-cols-2 lg:grid-cols-5" aria-label="Inventory and attention counts">
        {statsLoading ? Array.from({ length: 5 }).map((_, i) => <Card key={i}><CardContent className="p-6"><Skeleton className="h-20 w-full" /></CardContent></Card>) : statsError && !stats ? <div className="col-span-full flex items-center justify-between rounded-lg border p-4" role="alert"><span>Inventory counts could not be loaded.</span><Button variant="outline" size="sm" onClick={() => void refetchStats()}>Retry</Button></div> : <>
          <StatCard label="Total Items" value={stats?.totalItems ?? "—"} icon={Package} testId="stat-total-items" href="/inventory" />
          <StatCard label="Low Stock" value={stats?.lowStockCount ?? "—"} icon={AlertCircle} testId="stat-low-stock" href="/inventory?stock=low" />
          <StatCard label="Out of Stock" value={stats?.outOfStockCount ?? "—"} icon={AlertCircle} testId="stat-out-of-stock" href="/inventory?stock=out" />
          <StatCard label="Expiring Soon" value={stats?.expiringCount ?? "—"} icon={Clock} testId="stat-expiring" href="/inventory?stock=expiring" />
          <StatCard label="Expired" value={stats?.expiredCount ?? "—"} icon={AlertCircle} testId="stat-expired" href="/inventory?stock=expired" />
        </>}
      </div>

      <Card className="dashboard-panel dashboard-attention" aria-busy={inventoryFetching && !inventoryLoading}>
        <CardHeader className="dashboard-panel-header"><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle className="dashboard-panel-title">Needs attention</CardTitle><p className="dashboard-panel-description text-sm text-muted-foreground">Stock and freshness issues, most urgent first.</p></div><label className="dashboard-category-select">Category <select ref={attentionFilter} value={attentionCategory} onChange={(event) => { setAttentionCategory(event.target.value); setAttentionExpanded(false); }} aria-label="Filter attention by category">{categories.map((category) => <option key={category}>{category}</option>)}</select></label></div></CardHeader>
        <CardContent className="dashboard-panel-content">
          {inventoryLoading && !inventoryItems ? <div className="space-y-3" data-testid="pantry-attention-loading" aria-label="Loading attention items">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div> : inventoryError && !inventoryItems ? <div className="flex flex-col items-center gap-3 py-8 text-center text-muted-foreground" role="alert"><AlertCircle className="h-10 w-10 opacity-60" /><p className="font-medium text-foreground">Needs attention could not be loaded.</p><Button variant="outline" size="sm" onClick={() => void refetchInventory()} disabled={inventoryFetching}><RefreshCw className={cn("h-4 w-4", inventoryFetching && "animate-spin")} /> Retry</Button></div> : <>
            {inventoryError && inventoryItems ? <div className="mb-3 flex items-center justify-between rounded border border-amber-200 bg-amber-50 p-3 text-sm" role="status">Refresh failed; showing the latest attention items.<Button variant="outline" size="sm" onClick={() => void refetchInventory()}>Retry</Button></div> : null}
            {attentionItems.length === 0 ? <div className="dashboard-empty text-center" data-testid="attention-healthy"><CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-primary/70" /><p className="font-medium text-foreground">Your pantry is in good shape.</p><p className="text-sm">No stock or expiry issues need attention.</p></div> : filteredAttentionItems.length === 0 ? <div className="dashboard-empty text-center" data-testid="attention-filtered-empty"><p className="font-medium text-foreground">No items in {attentionCategory} need attention</p><Button variant="link" onClick={() => { setAttentionCategory("All categories"); setAttentionExpanded(false); }}>Show all categories</Button></div> : <>
              <div className="dashboard-attention-list" data-testid="attention-list">{visibleAttentionItems.map((item) => <AttentionRow key={item.id} item={item} onEdit={openEditor} loading={selectedItemId === item.id && !editingItem && !itemError} />)}</div>
              {filteredAttentionItems.length > 6 ? <Button variant="link" onClick={() => setAttentionExpanded((expanded) => !expanded)}>{attentionExpanded ? "Show fewer" : `View all ${filteredAttentionItems.length} items`}</Button> : null}
            </>}
          </>}
        </CardContent>
      </Card>

      <Card className="dashboard-panel dashboard-suggestions"><CardHeader className="dashboard-suggestions-header flex flex-row flex-wrap items-center justify-between gap-4"><CardTitle className="dashboard-panel-title">Shopping</CardTitle><Button className="dashboard-generate-button" onClick={handleGenerateShoppingList} disabled={suggestionsLoading || suggestionsError || !hasStockSuggestions || generateList.isPending} data-testid="button-generate-shopping-list"><ShoppingCart className="h-4 w-4" />{generateList.isPending ? "Generating..." : "Review shopping suggestions"}</Button></CardHeader><CardContent className="dashboard-suggestions-content">
        {suggestionsError ? <div className="mb-3 flex items-center justify-between rounded border border-amber-200 bg-amber-50 p-3 text-sm" role="alert">Shopping suggestions could not be loaded.<Button variant="outline" size="sm" onClick={() => void refetchSuggestions()} disabled={suggestionsFetching}>Retry</Button></div> : null}
        {reviewOpen ? renderReview() : suggestionsLoading ? <div className="space-y-3" aria-label="Loading shopping suggestions">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div> : <p className="text-sm text-muted-foreground">Review low-stock and out-of-stock items before creating a shopping list.</p>}
      </CardContent></Card>
    </div>{selectedItemId !== null && editorScope === scope && <InventoryItemDialog key={`${scope}:${selectedItemId}`} open item={editingItem} loading={!editingItem && !itemError} loadError={itemError} onRetry={() => setLoadAttempt((value) => value + 1)} onOpenChange={(open) => { if (!open) closeEditor(); }} onCloseAutoFocus={returnEditFocus} />}</Layout>
  );
}
