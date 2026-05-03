"use client";

import { cn } from "@/lib/utils";
import { type VariantProps, cva } from "class-variance-authority";
import { useEffect, useRef } from "react";

const checkboxVariants = cva(
  "peer size-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
  {
    variants: {
      variant: {
        default: "",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "size">,
    VariantProps<typeof checkboxVariants> {
  indeterminate?: boolean;
}

function Checkbox({ className, variant, indeterminate = false, ...props }: CheckboxProps) {
  const innerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (innerRef.current) {
      innerRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <input
      type="checkbox"
      ref={innerRef}
      className={cn(checkboxVariants({ variant, className }))}
      {...props}
    />
  );
}

export { Checkbox, checkboxVariants };
