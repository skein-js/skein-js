import { cn } from "@/lib/utils";

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: readonly { value: T; label: string }[];
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex shrink-0 gap-1 overflow-x-auto border-b px-3"
    >
      {tabs.map((tab, index) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          tabIndex={value === tab.value ? 0 : -1}
          className={cn(
            "whitespace-nowrap border-b-2 px-3 py-3 text-sm transition-colors",
            value === tab.value
              ? "border-primary font-medium text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onChange(tab.value)}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % tabs.length
                : event.key === "ArrowLeft"
                  ? (index + tabs.length - 1) % tabs.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : undefined;
            if (next === undefined || !tabs[next]) return;
            event.preventDefault();
            onChange(tabs[next].value);
            (
              event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined
            )?.focus();
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
