import { useMemo, useState } from "react";
import { Copy, MessageCircle, Save } from "lucide-react";
import {
  getGetShoppingStoreQueryKey,
  useGetShoppingStore,
  useUpdateShoppingStore,
} from "@workspace/api-client-react";
import type { ShoppingListWithItems } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

interface WhatsAppStoreHandoffProps {
  list: ShoppingListWithItems;
}

export function formatStoreGreeting(storeName: string) {
  const trimmed = storeName.trim();
  return `Hello${trimmed ? ` ${trimmed}` : ""},`;
}

function buildMessage(list: ShoppingListWithItems, storeName: string, pickupTime: string) {
  const items = list.items.filter((item) => !item.purchased);
  const lines = items.map((item) => {
    const notes = item.notes?.trim() ? ` — ${item.notes.trim()}` : "";
    return `- ${item.name}: ${item.quantity} ${item.unit}${notes}`;
  });
  return [
    formatStoreGreeting(storeName),
    "",
    `Please prepare this pickup from my PantryPal list (${list.name}):`,
    ...lines,
    pickupTime ? "" : null,
    pickupTime ? `Preferred pickup time: ${pickupTime}` : null,
    "",
    "Please confirm availability and any substitutions.",
  ].filter((line): line is string => line !== null).join("\n");
}

export async function copyMessageToClipboard(message: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(message);
    return true;
  } catch {
    return false;
  }
}

export function WhatsAppStoreHandoff({ list }: WhatsAppStoreHandoffProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: store, isLoading } = useGetShoppingStore();
  const updateStore = useUpdateShoppingStore();
  const [storeName, setStoreName] = useState("");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [pickupTime, setPickupTime] = useState("");
  const [editing, setEditing] = useState(false);

  const savedName = store?.storeName ?? "";
  const savedNumber = store?.whatsappNumber ?? "";
  const setupFormVisible = editing || !savedName || !savedNumber;
  const name = setupFormVisible ? storeName : savedName;
  const number = editing ? whatsappNumber : savedNumber;
  const itemsToBuy = useMemo(() => list.items.filter((item) => !item.purchased), [list.items]);
  const message = buildMessage(list, name, pickupTime);
  const canSend = Boolean(savedNumber && savedName && itemsToBuy.length > 0 && !editing);

  const startEditing = () => {
    setStoreName(savedName);
    setWhatsappNumber(savedNumber);
    setEditing(true);
  };

  const saveStore = async () => {
    if (!storeName.trim() || !whatsappNumber.trim()) {
      toast({ title: "Store details required", description: "Enter a store name and WhatsApp number.", variant: "destructive" });
      return;
    }
    try {
      await updateStore.mutateAsync({ data: { storeName, whatsappNumber } });
      await queryClient.invalidateQueries({ queryKey: getGetShoppingStoreQueryKey() });
      setEditing(false);
      toast({ title: "Store details saved", description: "Your preferred kirana is ready for WhatsApp handoff." });
    } catch {
      toast({ title: "Could not save store details", description: "Check the WhatsApp number and try again.", variant: "destructive" });
    }
  };

  const copyMessage = async () => {
    if (await copyMessageToClipboard(message)) {
      toast({ title: "Message copied", description: "Paste it into the store's WhatsApp chat." });
    } else {
      toast({ title: "Copy unavailable", description: "The message is still visible above. Select it and copy it manually.", variant: "destructive" });
    }
  };

  const openWhatsApp = () => {
    if (!canSend) return;
    window.open(`https://wa.me/${savedNumber.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
  };

  return (
    <Card data-testid="whatsapp-store-handoff">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><MessageCircle className="h-5 w-5" /> Send to store</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading store details...</p> : editing || !savedName || !savedNumber ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium">Store name<Input className="mt-1" value={storeName} onChange={(event) => setStoreName(event.target.value)} placeholder="e.g. Sharma Kirana" /></label>
            <label className="text-sm font-medium">WhatsApp number<Input className="mt-1" value={whatsappNumber} onChange={(event) => setWhatsappNumber(event.target.value)} placeholder="e.g. 98765 43210" /></label>
            <div className="sm:col-span-2 flex flex-wrap gap-2">
              <Button onClick={() => void saveStore()} disabled={updateStore.isPending}><Save className="mr-2 h-4 w-4" />{updateStore.isPending ? "Saving..." : "Save store"}</Button>
              {savedName && savedNumber && <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
            </div>
            <p className="sm:col-span-2 text-xs text-muted-foreground">Use an international number, or a 10-digit Indian number. PantryPal opens WhatsApp only after you choose to send.</p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div><p className="font-medium">{savedName}</p><p className="text-sm text-muted-foreground">{savedNumber}</p></div>
            <Button variant="outline" size="sm" onClick={startEditing}>Edit store</Button>
          </div>
        )}

        <div className="space-y-3 rounded-lg bg-muted/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium">Pickup request preview</p><p className="text-sm text-muted-foreground">{itemsToBuy.length} item{itemsToBuy.length === 1 ? "" : "s"} still to buy</p></div><label className="text-sm font-medium">Optional pickup time<Input className="mt-1" type="datetime-local" value={pickupTime} onChange={(event) => setPickupTime(event.target.value)} /></label></div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 text-sm">{message}</pre>
          <div className="flex flex-wrap gap-2">
            <Button onClick={openWhatsApp} disabled={!canSend} data-testid="button-send-to-store"><MessageCircle className="mr-2 h-4 w-4" />Open WhatsApp</Button>
            <Button variant="outline" onClick={() => void copyMessage()} disabled={itemsToBuy.length === 0} data-testid="button-copy-store-message"><Copy className="mr-2 h-4 w-4" />Copy message</Button>
          </div>
          {!savedNumber && <p className="text-sm text-muted-foreground">Save a valid store number above to enable WhatsApp.</p>}
          {itemsToBuy.length === 0 && <p className="text-sm text-muted-foreground">Mark at least one item as still to buy to enable the handoff.</p>}
        </div>
      </CardContent>
    </Card>
  );
}
