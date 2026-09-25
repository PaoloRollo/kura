"use client";

import { toast } from "sonner";
import { Button, KuraToast, notify } from "@/components/kura";

/** Fires the themed sonner toasts, so the live look can be checked against the static one. */
export function ToastDemo() {
  return (
    <>
    <KuraToast title="You were outbid on Black Lotus" body="Clearing passed your $1,760 max" action={{ label: "Raise", onClick: () => {} }} />
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" size="compact" onClick={() => notify({ title: "You were outbid on Black Lotus", body: "Clearing passed your $1,760 max", action: { label: "Raise", onClick: () => {} } })}>
        Kura toast
      </Button>
      <Button variant="secondary" size="compact" onClick={() => toast.error("Matching failed", { description: "Search by name instead" })}>
        Error
      </Button>
      <Button variant="secondary" size="compact" onClick={() => toast.success("Minted in block 7,412,901")}>
        Success
      </Button>
      <Button variant="secondary" size="compact" onClick={() => toast.info("No match found, search by name")}>
        Info
      </Button>
    </div>
    </>
  );
}
