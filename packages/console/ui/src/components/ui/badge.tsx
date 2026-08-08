import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

// Low-contrast, hairline-bordered chips. The loud version of this component is a mistake in a console:
// most badges here are ambient context (a phase, a count), and only the status ones are meant to pull
// the eye — which they do through hue, not through a filled background.
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        outline: "text-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
        running: "border-status-running/25 bg-status-running/5 text-status-running",
        success: "border-status-success/25 bg-status-success/5 text-status-success",
        error: "border-status-error/25 bg-status-error/5 text-status-error",
        interrupted: "border-status-interrupted/25 bg-status-interrupted/5 text-status-interrupted",
      },
    },
    defaultVariants: { variant: "muted" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
