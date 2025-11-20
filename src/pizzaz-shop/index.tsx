import { useEffect, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useOpenAiGlobal } from "../use-openai-global";
import { useWidgetState } from "../use-widget-state";

type JsonPanelProps = {
  label: string;
  value: unknown;
};

type CartItem = {
  name: string;
  quantity: number;
  [key: string]: unknown;
};

type CartWidgetState = {
  cartId?: string;
  items?: CartItem[];
  [key: string]: unknown;
};

function usePrettyJson(value: unknown): string {
  return useMemo(() => {
    if (value === undefined || value === null) {
      return "null";
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return `<<unable to render: ${error}>>`;
    }
  }, [value]);
}

function JsonPanel({ label, value }: JsonPanelProps) {
  const pretty = usePrettyJson(value);

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-slate-900/70 p-4 shadow-[0_10px_25px_rgba(15,23,42,0.45)] backdrop-blur">
      <header>
        <p className="text-sm font-semibold uppercase tracking-widest text-slate-400">
          {label}
        </p>
      </header>
      <pre className="overflow-auto rounded-lg bg-black/40 p-3 font-mono text-xs leading-snug text-slate-100">
        {pretty}
      </pre>
    </section>
  );
}

function App() {
  const toolInput = useOpenAiGlobal("toolInput");
  const toolResponseMetadata = useOpenAiGlobal("toolResponseMetadata");
  const toolOutput = useOpenAiGlobal("toolOutput");
  const widgetState = useOpenAiGlobal("widgetState");
  const [cartState, setCartState] = useWidgetState<CartWidgetState>(() => {
    if (widgetState && typeof widgetState === "object") {
      return widgetState as CartWidgetState;
    }

    return { items: [] };
  });
  const cartItems = Array.isArray(cartState?.items) ? cartState.items : [];

  function adjustQuantity(name: string, delta: number) {
    if (!name || delta === 0) {
      return;
    }

    console.log("adjustQuantity", { name, delta });
    setCartState((prevState) => {
      const baseState: CartWidgetState = prevState ?? {};
      const items = Array.isArray(baseState.items)
        ? baseState.items.map((item) => ({ ...item }))
        : [];
      console.log("adjustQuantity:prev", baseState);

      const idx = items.findIndex((item) => item.name === name);
      if (idx === -1) {
        console.log("adjustQuantity:missing", name);
        return baseState;
      }

      const current = items[idx];
      const nextQuantity = Math.max(0, (current.quantity ?? 0) + delta);
      if (nextQuantity === 0) {
        items.splice(idx, 1);
      } else {
        items[idx] = { ...current, quantity: nextQuantity };
      }

      const nextState = { ...baseState, items };
      console.log("adjustQuantity:next", nextState);
      return nextState;
    });
  }

  function widgetStateEqual(a: unknown, b: unknown): boolean {
    if (a == null && b == null) {
      return true;
    }

    if (a == null || b == null) {
      return false;
    }

    return JSON.stringify(a) === JSON.stringify(b);
  }

  const lastMergedStateRef = useRef<string>("__cart_merge_unset__");

  useEffect(() => {
    // Merge streamed toolInput items with the latest host widgetState or local cart
    // state. Runs whenever toolInput/toolOutput/widgetState changes so host updates
    // do not wipe in-session cart.
    if (toolInput == null && toolOutput == null && widgetState == null) {
      return;
    }

    console.log("merge effect triggered", {
      toolInput,
      toolOutput,
      widgetState,
      cartState,
    });

    const incomingItems = Array.isArray(
      (toolInput as { items?: unknown } | null)?.items
    )
      ? ((toolInput as { items?: CartItem[] }).items ?? [])
      : [];

    const baseState =
      widgetState && typeof widgetState === "object"
        ? (widgetState as CartWidgetState)
        : cartState ?? { items: [] };
    const baseItems = Array.isArray(baseState.items) ? baseState.items : [];

    const itemsByName = new Map<string, CartItem>();
    for (const item of baseItems) {
      if (item?.name) {
        itemsByName.set(item.name, item);
      }
    }
    for (const item of incomingItems) {
      if (item?.name) {
        itemsByName.set(item.name, { ...itemsByName.get(item.name), ...item });
      }
    }

    const nextItems = Array.from(itemsByName.values());
    const nextState = { ...baseState, items: nextItems };

    const serialized = JSON.stringify(nextState);
    if (serialized === lastMergedStateRef.current) {
      console.log("merge effect skipped (no change)");
      return;
    }

    lastMergedStateRef.current = serialized;

    if (!widgetStateEqual(nextState, cartState)) {
      console.log("setting cartState from merge", nextState);
      setCartState(nextState);
    } else {
      console.log("merge effect detected equal state, no setCartState");
    }
  }, [toolInput, toolOutput, widgetState, cartState]);

  const panels: JsonPanelProps[] = [
    { label: "window.openai.toolInput", value: toolInput },
    { label: "window.openai.toolResponseMetadata", value: toolResponseMetadata },
    { label: "window.openai.toolOutput", value: toolOutput },
    { label: "window.openai.widgetState", value: widgetState },
  ];

  const itemCards = cartItems.length ? (
    <div className="grid gap-4 md:grid-cols-2">
      {cartItems.map((item) => (
        <div
          key={item.name}
          className="flex items-center justify-between rounded-2xl border border-white/10 bg-slate-800/70 p-4"
        >
          <div>
            <p className="text-base font-semibold text-white">{item.name}</p>
            <p className="text-sm text-slate-300">
              Quantity: <span className="font-mono">{item.quantity}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => adjustQuantity(item.name, -1)}
              className="h-8 w-8 rounded-full border border-white/30 text-lg font-bold text-white transition hover:bg-white/20"
              aria-label={`Decrease ${item.name}`}
            >
              -
            </button>
            <button
              type="button"
              onClick={() => adjustQuantity(item.name, 1)}
              className="h-8 w-8 rounded-full border border-white/30 text-lg font-bold text-white transition hover:bg-white/20"
              aria-label={`Increase ${item.name}`}
            >
              +
            </button>
          </div>
        </div>
      ))}
    </div>
  ) : (
    <p className="rounded-2xl border border-dashed border-white/20 bg-slate-800/50 p-6 text-center text-sm text-slate-300">
      The cart is empty. Tool calls that return widget state will populate this
      section.
    </p>
  );

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-slate-900 via-slate-950 to-black">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 text-white md:px-6 lg:px-8">
        <section className="space-y-3">
          <header>
            <p className="text-sm font-semibold uppercase tracking-widest text-slate-400">
              Cart Items
            </p>
          </header>
          {itemCards}
        </section>
        {panels.map((panel) => (
          <JsonPanel key={panel.label} label={panel.label} value={panel.value} />
        ))}
      </div>
    </div>
  );
}

const rootElement = document.getElementById("pizzaz-shop-root");
if (!rootElement) {
  throw new Error("Missing pizzaz-shop-root element");
}

createRoot(rootElement).render(<App />);
