import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateInventoryItem,
  useUpdateInventoryItem,
  getInventoryItem,
} from "@workspace/api-client-react";
import type {
  InventoryItem,
  InventoryItemInput,
  InventoryItemUpdate,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useNotifications } from "@/hooks/use-notifications";
import { isInvalidUnit } from "@/lib/inventory-units";
import { UnitSelector } from "@/components/unit-selector";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { refreshPantry } from "@/lib/refresh-pantry";

function nullableValue(value: string | undefined) {
  return value === "" || value === undefined ? null : value;
}

const nonBlankNumber = (label: string) =>
  z.preprocess(
    (value) => {
      if (typeof value === "string" && value.trim() === "") return undefined;
      return typeof value === "number" ? value : Number(value);
    },
    z
      .number({
        required_error: `${label} is required`,
        invalid_type_error: `${label} must be a number`,
      })
      .finite(`${label} must be a valid number`)
      .min(0, `${label} must be 0 or greater`),
  );

const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  category: z.string().min(1, "Category is required"),
  quantity: nonBlankNumber("Quantity"),
  unit: z.string()
    .trim()
    .min(1, "Unit is required")
    .max(64, "Unit must be 64 characters or fewer")
    .refine((value) => !isInvalidUnit(value), "Choose a unit or enter a custom text unit"),
  minThreshold: nonBlankNumber("Threshold"),
  expiresAt: z.string().optional(),
  notes: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;
const fieldLabels: Record<keyof FormValues, string> = {
  name: "name", category: "category", quantity: "quantity", unit: "unit",
  minThreshold: "minimum threshold", expiresAt: "expiry date", notes: "notes",
};

function normalizeEditValue(key: keyof FormValues, value: unknown) {
  if (key === "quantity" || key === "minThreshold") {
    if (typeof value === "string" && value.trim() === "") return value;
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (key === "expiresAt" || key === "notes") return value === "" || value == null ? null : value;
  if (key === "unit" && typeof value === "string") return value.trim();
  return value;
}

interface InventoryItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item?: InventoryItem;
  onCloseAutoFocus?: (event: Event) => void;
  loading?: boolean;
  loadError?: string;
  onRetry?: () => void;
}

export function InventoryItemDialog({ open, onOpenChange, item, onCloseAutoFocus, loading = false, loadError = "", onRetry }: InventoryItemDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="dialog-inventory-item" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader><DialogTitle>{item || loading || loadError ? "Edit Item" : "Add New Item"}</DialogTitle></DialogHeader>
        {loading || loadError ? <>
          <p role={loadError ? "alert" : "status"}>{loadError || "Loading current item..."}</p>
          <DialogFooter>{loadError && <Button type="button" variant="outline" onClick={onRetry}>Refresh item</Button>}<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button></DialogFooter>
        </> : open && <InventoryItemEditor key={item?.id ?? "new"} open={open} onOpenChange={onOpenChange} item={item} />}
      </DialogContent>
    </Dialog>
  );
}

// Mount only once the authoritative snapshot is available. Keep the modal itself
// mounted through loading so its focus scope and return target remain stable.
function InventoryItemEditor({ open, onOpenChange, item }: InventoryItemDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { notifyOutOfStock } = useNotifications();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [focusNameAfterSave, setFocusNameAfterSave] = useState(false);
  const submitIntent = useRef<"close" | "continue">("close");
  const [isReviewing, setIsReviewing] = useState(false);
  const [hasConflict, setHasConflict] = useState(false);
  const [missing, setMissing] = useState(false);
  const [conflictingFields, setConflictingFields] = useState<(keyof FormValues)[]>([]);
  const baseItem = useRef(item);
  const latestLoaded = useRef(false);
  const [unitSelectorKey, setUnitSelectorKey] = useState(0);
  const dialogSession = useRef(0);
  const openState = useRef(open);
  const lastFormReset = useRef<{ session: number; itemId: number | null } | null>(null);
  const activeItemId = useRef<number | null>(item?.id ?? null);
  const formRevision = useRef<number | null>(null);
  const activeSubmission = useRef<number | null>(null);
  const nextSubmission = useRef(0);
  useEffect(() => () => {
    dialogSession.current += 1;
    openState.current = false;
    activeSubmission.current = null;
  }, []);

  const createItem = useCreateInventoryItem();
  const updateItem = useUpdateInventoryItem();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: item?.name || "",
      category: item?.category || "",
      quantity: item?.quantity || 0,
      unit: item?.unit || "",
      minThreshold: item?.minThreshold || 0,
      expiresAt: item?.expiresAt || "",
      notes: item?.notes || "",
    },
  });
  const { dirtyFields } = form.formState;

  useEffect(() => {
    if (openState.current !== open) {
      openState.current = open;
      dialogSession.current += 1;
      if (!open) {
        activeSubmission.current = null;
        setIsSubmitting(false);
        setFocusNameAfterSave(false);
        formRevision.current = null;
        activeItemId.current = null;
        setIsReviewing(false);
        setHasConflict(false);
      }
    }

    if (!open) return;

    const itemId = item?.id ?? null;
    if (
      lastFormReset.current?.session === dialogSession.current &&
      lastFormReset.current.itemId === itemId
    ) return;
    lastFormReset.current = { session: dialogSession.current, itemId };
    activeItemId.current = itemId;
    formRevision.current = item?.revision ?? null;
    baseItem.current = item;
    latestLoaded.current = false;
    setMissing(false);
    setConflictingFields([]);
    setUnitSelectorKey((key) => key + 1);

    form.reset({
      name: item?.name || "",
      category: item?.category || "",
      quantity: item?.quantity || 0,
      unit: item?.unit || "",
      minThreshold: item?.minThreshold || 0,
      expiresAt: item?.expiresAt || "",
      notes: item?.notes || "",
    });
  }, [form, item, open]);

  useEffect(() => {
    if (!open || !focusNameAfterSave) return;

    form.setFocus("name");
    setFocusNameAfterSave(false);
  }, [focusNameAfterSave, form, open]);
  const handleOpenChange = (nextOpen: boolean) => {
    if (openState.current !== nextOpen) {
      openState.current = nextOpen;
      dialogSession.current += 1;
    }
    if (!nextOpen) {
      submitIntent.current = "close";
      activeSubmission.current = null;
      setIsSubmitting(false);
      setFocusNameAfterSave(false);
      activeSubmission.current = null;
      formRevision.current = null;
      activeItemId.current = null;
      setIsReviewing(false);
      setHasConflict(false);
    }
    onOpenChange(nextOpen);
  };

  const handleInvalidSubmit = () => {
    submitIntent.current = "close";
  };

  const isConflictError = (error: unknown) =>
    typeof error === "object" && error !== null &&
    "status" in error && (error as { status?: unknown }).status === 409;

  const handleNativeInvalid = () => {
    // Native validation owns the browser message; keep the dialog and draft in place.
    submitIntent.current = "close";
  };

  const reviewLatest = async (automatic = false) => {
    if (!item || isReviewing) return;
    if (!automatic && latestLoaded.current) {
      setHasConflict(false);
      return;
    }
    const reviewSession = dialogSession.current;
    const itemId = item.id;
    setIsReviewing(true);
    try {
      const latest = await getInventoryItem(itemId);
      if (
        dialogSession.current !== reviewSession ||
        !openState.current ||
        activeItemId.current !== itemId
      ) return;
      refreshPantry(queryClient, latest);
      formRevision.current = latest.revision;
      setUnitSelectorKey((key) => key + 1);
      const latestValues = {
        name: latest.name,
        category: latest.category,
        quantity: latest.quantity,
        unit: latest.unit,
        minThreshold: latest.minThreshold,
        expiresAt: latest.expiresAt || "",
        notes: latest.notes || "",
      };
      const draft = form.getValues();
      const previous = baseItem.current!;
      const conflicts: (keyof FormValues)[] = [];
      const dirty: Partial<FormValues> = {};
      for (const key of Object.keys(latestValues) as (keyof FormValues)[]) {
        const normalize = (value: unknown) => normalizeEditValue(key, value);
        if (dirtyFields[key] && normalize(draft[key]) !== normalize(previous[key])) {
          Object.assign(dirty, { [key]: draft[key] });
          if (normalize(latest[key]) !== normalize(previous[key]) && normalize(latest[key]) !== normalize(draft[key])) conflicts.push(key);
        }
      }
      baseItem.current = latest;
      form.reset(latestValues);
      for (const key of Object.keys(dirty) as (keyof FormValues)[]) form.setValue(key, dirty[key]!, { shouldDirty: true });
      setConflictingFields(conflicts);
      latestLoaded.current = true;
      setHasConflict(automatic);
      toast({
        title: "Latest item loaded",
        description: "Untouched fields were refreshed. Your edits are preserved; review before retrying.",
      });
    } catch (error) {
      if (
        dialogSession.current !== reviewSession ||
        !openState.current ||
        activeItemId.current !== itemId
      ) return;
      if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
        setMissing(true);
        refreshPantry(queryClient);
      }
      toast({
        title: "Unable to load the latest item",
        description: "The item may have been deleted. Try again or close this dialog.",
        variant: "destructive",
      });
    } finally {
      if (dialogSession.current === reviewSession) setIsReviewing(false);
    }
  };

  const onSubmit = async (values: FormValues) => {
    if (isSubmitting || activeSubmission.current !== null || hasConflict || conflictingFields.length || missing) return;

    const shouldContinue = !item && submitIntent.current === "continue";
    submitIntent.current = "close";
    const submissionSession = dialogSession.current;
    const submissionId = ++nextSubmission.current;
    activeSubmission.current = submissionId;
    const isCurrentSubmission = () =>
      dialogSession.current === submissionSession &&
      activeSubmission.current === submissionId;
    setIsSubmitting(true);
    try {
      if (item) {
        const update: InventoryItemUpdate = {
          revision: formRevision.current ?? item.revision,
        };
        const savedValues = { ...values, expiresAt: nullableValue(values.expiresAt), notes: nullableValue(values.notes) };
        for (const key of Object.keys(savedValues) as (keyof FormValues)[]) {
          if (dirtyFields[key] && normalizeEditValue(key, savedValues[key]) !== normalizeEditValue(key, baseItem.current?.[key])) {
            Object.assign(update, { [key]: savedValues[key] });
          }
        }
        if (Object.keys(update).length === 1) {
          handleOpenChange(false);
          return;
        }
        const updatedItem = await updateItem.mutateAsync({
          id: item.id,
          data: update,
        });
        if (!isCurrentSubmission()) return;
        refreshPantry(queryClient, updatedItem);
        if (isCurrentSubmission()) {
          if (updatedItem.quantity === 0) {
            notifyOutOfStock(updatedItem.name);
            toast({
              title: `${values.name} is out of stock`,
              description: "Consider adding it to a shopping list.",
              variant: "destructive",
            });
          } else {
            toast({
              title: `${updatedItem.name} updated.`,
            });
          }
        }
      } else {
        const input: InventoryItemInput = {
          ...values,
          expiresAt: nullableValue(values.expiresAt),
          notes: nullableValue(values.notes),
        };
        await createItem.mutateAsync({
          data: input,
        });
        if (isCurrentSubmission() && values.quantity === 0) {
          notifyOutOfStock(values.name);
          toast({
            title: `${values.name} added — and already out of stock`,
            description: shouldContinue
              ? "Add your next item."
              : "Consider adding it to a shopping list right away.",
            variant: "destructive",
          });
        } else if (isCurrentSubmission()) {
          toast({
            title: "Item added",
            description: shouldContinue
              ? `${values.name} added. Add your next item.`
              : `${values.name} has been added to inventory.`,
          });
        }
      }

      if (!item) refreshPantry(queryClient);

      if (!isCurrentSubmission()) return;

      if (shouldContinue) {
        form.reset({
          name: "",
          category: values.category,
          quantity: 0,
          unit: values.unit,
          minThreshold: 0,
          expiresAt: "",
          notes: "",
        });
        setFocusNameAfterSave(true);
      } else {
        handleOpenChange(false);
        form.reset();
      }
    } catch (error) {
      if (isCurrentSubmission()) {
        if (item && isConflictError(error)) {
          latestLoaded.current = false;
          setHasConflict(true);
          toast({
            title: "Item changed",
            description: "Your draft is preserved. Review the latest item before saving again.",
            variant: "destructive",
          });
          await reviewLatest(true);
        } else if (item && typeof error === "object" && error !== null && "status" in error && error.status === 404) {
          setMissing(true);
          refreshPantry(queryClient);
        } else {
          toast({
            title: "Error",
            description: "Failed to save item. Please try again.",
            variant: "destructive",
          });
        }
      }
    } finally {
      if (isCurrentSubmission()) {
        activeSubmission.current = null;
        setIsSubmitting(false);
      }
    }
  };

  return (
    <>

        {hasConflict && item && (
          <Alert variant="destructive" data-testid="inventory-conflict">
            <AlertTitle>Item changed elsewhere</AlertTitle>
            <AlertDescription>
              Your draft is preserved. Review latest refreshes untouched fields and identifies conflicting edits. Review before retrying.
              <Button
                type="button"
                variant="outline"
                className="mt-3"
                onClick={() => void reviewLatest()}
                disabled={isReviewing}
                data-testid="button-review-latest"
              >
                {isReviewing ? "Loading latest..." : "Review latest"}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {missing && <Alert variant="destructive" role="alert"><AlertTitle>Item no longer available</AlertTitle><AlertDescription>It may have been deleted or become inaccessible. Dashboard data has been refreshed. Close this dialog to continue.</AlertDescription></Alert>}
        {conflictingFields.map((key) => <Alert key={key} variant="destructive" role="alert"><AlertTitle>Conflicting change: {fieldLabels[key]}</AlertTitle><AlertDescription>
          Saved value: {String(baseItem.current?.[key] ?? "(empty)")}. Your draft: {String(form.getValues(key) ?? "(empty)")}. Choose which value to use before retrying.
          <div className="flex flex-wrap gap-2 mt-2"><Button type="button" variant="outline" onClick={() => setConflictingFields((fields) => fields.filter((field) => field !== key))}>Keep my {fieldLabels[key]}</Button><Button type="button" variant="outline" onClick={() => { form.setValue(key, baseItem.current?.[key] ?? "", { shouldDirty: false }); if (key === "unit") setUnitSelectorKey((value) => value + 1); setConflictingFields((fields) => fields.filter((field) => field !== key)); }}>Use saved {fieldLabels[key]}</Button></div>
        </AlertDescription></Alert>)}

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit, handleInvalidSubmit)}
            onInvalidCapture={handleNativeInvalid}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem className="col-span-full">
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        disabled={isSubmitting || isReviewing || missing}
                        placeholder="e.g. Milk"
                        data-testid="input-item-name"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        disabled={isSubmitting || isReviewing || missing}
                        placeholder="e.g. Dairy"
                        data-testid="input-item-category"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="unit"
                render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Unit</FormLabel>
                    <FormControl>
                      <UnitSelector
                        key={`${item?.id ?? "new"}-${open}-${unitSelectorKey}`}
                        value={field.value}
                        onChange={field.onChange}
                        disabled={isSubmitting || isReviewing || missing}
                        selectTestId="input-item-unit"
                        customInputTestId="input-item-custom-unit"
                        invalid={fieldState.invalid}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="quantity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current Quantity</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.1"
                        {...field}
                        disabled={isSubmitting || isReviewing || missing}
                        data-testid="input-item-quantity"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="minThreshold"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Min Threshold</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.1"
                        {...field}
                        disabled={isSubmitting || isReviewing || missing}
                        data-testid="input-item-threshold"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="expiresAt"
                render={({ field }) => (
                  <FormItem className="col-span-full">
                    <FormLabel>Expires At (optional)</FormLabel>
                    <FormControl>
                      <Input
                        type="date"
                        {...field}
                        disabled={isSubmitting || isReviewing || missing}
                        data-testid="input-item-expires"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem className="col-span-full">
                    <FormLabel>Notes (optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        disabled={isSubmitting || isReviewing || missing}
                        placeholder="Additional notes..."
                        data-testid="input-item-notes"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                data-testid="button-cancel"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={item ? "default" : "outline"}
                disabled={isSubmitting || isReviewing || hasConflict || missing || conflictingFields.length > 0}
                onClick={() => {
                  submitIntent.current = "close";
                }}
                data-testid="button-save-item"
              >
                {isSubmitting ? "Saving..." : item ? "Update" : "Save item"}
              </Button>
              {!item && (
                <Button
                  type="submit"
                  disabled={isSubmitting || isReviewing || missing}
                  onClick={() => {
                    submitIntent.current = "continue";
                  }}
                  data-testid="button-save-and-add-another"
                >
                  {isSubmitting ? "Saving..." : "Save & add another"}
                </Button>
              )}
            </DialogFooter>
          </form>
        </Form>
    </>
  );
}
