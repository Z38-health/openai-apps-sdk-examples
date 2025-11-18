import { Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useDisplayMode } from "../use-display-mode";
import { useMaxHeight } from "../use-max-height";
import { useWidgetProps } from "../use-widget-props";
import { useWidgetState } from "../use-widget-state";
import { useOpenAiGlobal } from "../use-openai-global";

export type CartItem = {
  id: string;
  image: string;
  quantity: number;
};

type CartItemWidgetStateEntry = Pick<CartItem, "id" | "quantity">;

export type PizzazCartWidgetState = {
  cartItems?: CartItemWidgetStateEntry[];
};

export type PizzazCartWidgetProps = {
  cartItems?: CartItem[];
  widgetState?: Partial<PizzazCartWidgetState> | null;
};

export type PizzazShopAppProps = Record<string, never>;

const MATCHA_PIZZA: CartItem = {
  id: "matcha-pizza",
  image: "https://persistent.oaistatic.com/pizzaz-cart-xl/matcha-pizza.png",
  quantity: 1,
};

const MATCHA_LABEL = "Matcha Pizza";

const buildWidgetState = (quantity: number): PizzazCartWidgetState => {
  if (quantity <= 0) {
    return { cartItems: [] };
  }
  return {
    cartItems: [
      {
        id: MATCHA_PIZZA.id,
        quantity,
      },
    ],
  };
};

const toQuantity = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.round(parsed));
};

export function App({}: PizzazShopAppProps = {}) {
  const maxHeight = useMaxHeight() ?? undefined;
  const displayMode = useDisplayMode();
  const isFullscreen = displayMode === "fullscreen";
  const widgetProps = useWidgetProps<PizzazCartWidgetProps>(() => ({}));
  const toolOutput = useOpenAiGlobal("toolOutput") as Record<string, unknown> | null;
  const [widgetState, setWidgetState] = useWidgetState<PizzazCartWidgetState>(() =>
    buildWidgetState(MATCHA_PIZZA.quantity)
  );
  const toolCartItem = useMemo(() => {
    if (!toolOutput || typeof toolOutput !== "object") {
      return null;
    }
    const entries = (toolOutput as { cartItems?: unknown }).cartItems;
    if (!Array.isArray(entries)) {
      return null;
    }
    const first = entries[0];
    return first && typeof first === "object" ? (first as CartItem) : null;
  }, [toolOutput]);
  const propsCartItem = Array.isArray(widgetProps?.cartItems)
    ? (widgetProps.cartItems[0] as CartItem | undefined) ?? null
    : null;
  const externalQuantity =
    toQuantity(propsCartItem?.quantity) ?? toQuantity(toolCartItem?.quantity);
  const widgetEntry = widgetState?.cartItems?.[0];
  const widgetQuantity = widgetEntry ? toQuantity(widgetEntry.quantity) : null;
  const [quantity, setQuantity] = useState(
    widgetQuantity ?? externalQuantity ?? MATCHA_PIZZA.quantity
  );
  const widgetStateJson = useMemo(
    () => JSON.stringify(widgetState ?? null, null, 2),
    [widgetState]
  );
  useEffect(() => {
    console.log("widgetState", widgetState);
  }, [widgetState]);

  useEffect(() => {
    if (widgetQuantity == null) {
      return;
    }
    setQuantity((previous) =>
      previous === widgetQuantity ? previous : widgetQuantity
    );
  }, [widgetQuantity]);

  useEffect(() => {
    if (widgetQuantity != null || externalQuantity == null) {
      return;
    }
    setWidgetState(buildWidgetState(externalQuantity));
  }, [externalQuantity, setWidgetState, widgetQuantity]);

  const adjustQuantity = useCallback(
    (delta: number) => {
      if (!Number.isFinite(delta) || delta === 0) {
        return;
      }
      setQuantity((previous) => {
        const next = Math.max(0, previous + delta);
        if (next === previous) {
          return previous;
        }
        setWidgetState(buildWidgetState(next));
        return next;
      });
    },
    [setWidgetState]
  );

  const image =
    (propsCartItem &&
    typeof propsCartItem.image === "string" &&
    propsCartItem.image.trim()
      ? propsCartItem.image
      : null) ??
    (toolCartItem &&
    typeof toolCartItem.image === "string" &&
    toolCartItem.image.trim()
      ? toolCartItem.image
      : null) ??
    MATCHA_PIZZA.image;

  return (
    <div
      className="flex items-center justify-center overflow-hidden bg-[#f6f5f1]"
      style={{
        maxHeight,
        height: isFullscreen ? maxHeight : undefined,
      }}
    >
      <div className="flex w-full max-w-2xl flex-col gap-6 p-4">
        <section className="rounded-[32px] border border-black/10 bg-white shadow-[0_6px_20px_rgba(0,0,0,0.05)]">
          <img
            src={image}
            alt={MATCHA_LABEL}
            className="h-80 w-full rounded-t-[32px] object-cover"
            loading="lazy"
          />
          <div className="flex flex-col gap-4 p-6">
            <div>
              <p className="text-2xl font-semibold text-slate-900">
                {MATCHA_LABEL}
              </p>
              <p className="text-sm uppercase tracking-wide text-slate-400">
                {MATCHA_PIZZA.id}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-slate-500">
                The matcha dessert pie is the only product in this demo. Use the
                buttons to adjust the quantity or call the increment tool from your
                MCP client.
              </p>
              <div className="flex items-center rounded-full bg-slate-100 px-2 py-1 text-slate-900">
                <button
                  type="button"
                  aria-label="Decrease quantity"
                  className="flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-white"
                  onClick={() => adjustQuantity(-1)}
                >
                  <Minus strokeWidth={2.5} className="h-4 w-4" />
                </button>
                <span className="min-w-[48px] px-3 text-center text-2xl font-semibold tabular-nums">
                  {quantity}
                </span>
                <button
                  type="button"
                  aria-label="Increase quantity"
                  className="flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-white"
                  onClick={() => adjustQuantity(1)}
                >
                  <Plus strokeWidth={2.5} className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </section>
        <section className="rounded-2xl border border-black/10 bg-white/80 p-4 text-left shadow-[0px_6px_14px_rgba(0,0,0,0.05)]">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-black/70">
            Widget state
          </p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-black/80">
            {widgetStateJson}
          </pre>
        </section>
      </div>
    </div>
  );
}
