import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { Button } from "./button";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  side = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  side?: boolean;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <DialogPrimitive.Content
          onOpenAutoFocus={() => {
            returnFocus.current = document.activeElement as HTMLElement;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
          }}
          className={cn(
            "fixed z-50 overflow-y-auto border bg-card p-6 shadow-xl outline-none",
            side
              ? "inset-y-0 right-0 w-[min(100%,380px)]"
              : "left-1/2 top-1/2 max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl",
          )}
        >
          <DialogPrimitive.Title className="pr-8 text-lg font-semibold">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description
            className={cn(
              "mb-5 mt-2 text-sm leading-relaxed text-muted-foreground",
              !description && "sr-only",
            )}
          >
            {description ?? title}
          </DialogPrimitive.Description>
          {children}
          <DialogPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close dialog"
              className="absolute right-3 top-3"
            >
              <X className="size-4" />
            </Button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

type Confirmation = { title: string; description: string; confirmLabel?: string };
const ConfirmationContext = createContext<(confirmation: Confirmation) => Promise<boolean>>(
  async ({ title, description }) => window.confirm(`${title}\n\n${description}`),
);

/** Resolve only after an explicit decision; route changes cannot submit a destructive action. */
export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{
    confirmation: Confirmation;
    resolve: (answer: boolean) => void;
  }>();
  useEffect(() => {
    const cancel = () => {
      pending?.resolve(false);
      setPending(undefined);
    };
    window.addEventListener("hashchange", cancel);
    return () => {
      window.removeEventListener("hashchange", cancel);
      pending?.resolve(false);
    };
  }, [pending]);
  const settle = (answer: boolean) => {
    pending?.resolve(answer);
    setPending(undefined);
  };
  return (
    <ConfirmationContext.Provider
      value={(confirmation) =>
        new Promise((resolve) => {
          pending?.resolve(false);
          setPending({ confirmation, resolve });
        })
      }
    >
      {children}
      <Dialog
        open={pending !== undefined}
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
        title={pending?.confirmation.title ?? "Confirm action"}
        description={pending?.confirmation.description}
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => settle(false)}>
            Cancel
          </Button>
          <Button onClick={() => settle(true)}>
            {pending?.confirmation.confirmLabel ?? "Confirm"}
          </Button>
        </div>
      </Dialog>
    </ConfirmationContext.Provider>
  );
}
export function useConfirmation() {
  return useContext(ConfirmationContext);
}
