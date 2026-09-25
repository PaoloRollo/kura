"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

// Kura toast (Components sheet): surface-2 box, hairline border, 14px radius, deep shadow, a 34px tinted
// icon box, 13px semibold title, 12px body and a shu text action. Kura is dark only.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--kura-surface-2)",
          "--normal-text": "var(--kura-text)",
          "--normal-border": "var(--kura-border)",
          "--border-radius": "14px",
          "--width": "380px",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast:
            "cn-toast !items-center !gap-3 !p-3.5 !shadow-toast !font-sans data-[type=error]:[--kura-tone:var(--kura-shu)] data-[type=success]:[--kura-tone:var(--kura-good-fg)] data-[type=warning]:[--kura-tone:var(--kura-kin)] data-[type=info]:[--kura-tone:var(--kura-text-2)]",
          icon: "!m-0 !flex !size-[34px] !shrink-0 !items-center !justify-center !rounded-[10px] !bg-bg ![color:var(--kura-tone,var(--kura-shu))]",
          title: "!text-[13px] !font-semibold !text-text",
          description: "!text-[12px] !text-text-2",
          actionButton: "!bg-transparent !px-0 !text-[12px] !font-semibold !text-shu",
          cancelButton: "!bg-transparent !px-0 !text-[12px] !text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
