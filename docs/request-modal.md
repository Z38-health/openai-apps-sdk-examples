# `window.openai.requestModal`

`window.openai.requestModal` lets a widget ask the ChatGPT host to reopen the experience inside a modal. The host re-mounts the widget in `view.mode === "modal"` and passes back the `params` you supply so you can render a focused flow (for example, checkout).

```ts
type ModalAnchor = { top: number; left: number; width: number; height: number };

await window.openai.requestModal({
  title: "Checkout",
  params: { state: "checkout" }, // returned as window.openai.view.params in the modal
  heightHint: 720, // optional: give the host a preferred height in px
  anchor: anchorRect, // optional: helps the host animate from the clicked element
});
```

## Usage patterns

- Call from a user gesture and guard for environments where the API is missing.
- Keep the payload small and serializable; the host echoes it back as `window.openai.view.params`.
- In the modal view, use the echoed params plus any persisted widget state (via `setWidgetState`) to rebuild the UI.

### 1) Basic invocation (inline view)

```ts
async function openCheckout() {
  try {
    await window.openai?.requestModal?.({
      title: "Checkout",
      params: { state: "checkout" },
    });
  } catch (error) {
    console.error("Unable to open checkout modal", error);
  }
}
```

### 2) Anchor the modal to the click target

This mirrors the pizza-shop helper in `src/pizzaz-shop/index.tsx`: measure the trigger element so the host can animate the modal from that spot.

```ts
function openItemModal(event: React.MouseEvent<HTMLButtonElement>, itemId: string) {
  const rect = event.currentTarget.getBoundingClientRect();

  void window.openai?.requestModal?.({
    title: "Item details",
    params: { state: "checkout", selectedCartItemId: itemId },
    anchor: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
  });
}
```

### 3) Render using the modal params

When the host reopens the widget in a modal, read `window.openai.view` to hydrate your view.

```ts
const view = window.openai?.view ?? { mode: "inline", params: null };
const isModalView = view.mode === "modal";
const modalParams = (view.params ?? {}) as { state?: string; selectedCartItemId?: string };

useEffect(() => {
  if (!isModalView) return;

  if (modalParams.state === "checkout") {
    setActiveView("checkout");
    setSelectedCartItemId(modalParams.selectedCartItemId ?? null);
  }
}, [isModalView, modalParams.state, modalParams.selectedCartItemId]);
```

## Tips

- Fall back gracefully (`window.openai?.requestModal`) so the widget still works in hosts that have not rolled out modals.
- Pair modal params with persistent widget state via `window.openai.setWidgetState` to keep carts or selections in sync between inline and modal views.
- Use `heightHint` to prevent scroll-clipped layouts; the host may clamp the value.
- Avoid passing large data blobs—send identifiers and refetch using your existing tool calls instead.

## State management (inline ↔ modal)

The host remounts your widget when the modal opens, so treat state as reconstructable:

- **Persist shared state** with `window.openai.setWidgetState` (e.g., cart contents, selections). The host restores `window.openai.widgetState` on every mount.
- **Use modal params for intent**, not full data. Pass `{ state: "checkout", selectedCartItemId }`, then re-derive the UI from `widgetState`.
- **Detect view changes** via `window.openai.view.mode` to branch behavior (e.g., hide inline-only controls when `mode === "modal"`).

### Example: keep cart and selection in sync

```ts
// Inline view: ask for modal and persist selection
async function openCartItemModal(itemId: string, anchor?: DOMRect) {
  await window.openai.setWidgetState((prev) => ({
    ...(prev ?? {}),
    selectedCartItemId: itemId,
  }));

  await window.openai.requestModal({
    title: "Checkout",
    params: { state: "checkout", selectedCartItemId: itemId },
    anchor: anchor && {
      top: anchor.top,
      left: anchor.left,
      width: anchor.width,
      height: anchor.height,
    },
  });
}

// Modal view: rebuild from persisted state + params
const view = window.openai.view;
const isModalView = view.mode === "modal";
const modalParams = (view.params ?? {}) as { state?: string; selectedCartItemId?: string };
const widgetState = window.openai.widgetState as {
  cartItems?: Array<{ id: string; quantity: number }>;
  selectedCartItemId?: string | null;
} | null;

const selectedId = modalParams.selectedCartItemId ?? widgetState?.selectedCartItemId ?? null;
const cartItems = widgetState?.cartItems ?? [];

useEffect(() => {
  if (!isModalView) return;

  setSelectedCartItemId(selectedId);
  setVisibleView(modalParams.state === "checkout" ? "checkout" : "cart");
}, [isModalView, selectedId, modalParams.state]);
```

### Sync tool output into widget state

Many samples (including `src/pizzaz-shop/index.tsx`) keep tool responses and widget state aligned. If a tool returns the canonical cart, mirror it into `setWidgetState` so both inline and modal mounts see the same data:

```ts
useEffect(() => {
  if (!toolOutput || !window.openai?.setWidgetState) return;

  // Only sync when the content actually changes
  const toolCart = toolOutput.cartItems;
  if (!Array.isArray(toolCart)) return;

  void window.openai.setWidgetState((prev) => ({
    ...(prev ?? {}),
    cartItems: toolCart,
  }));
}, [toolOutput]);
```

### Degrade gracefully

- Wrap calls with optional chaining (`window.openai?.requestModal`) so the widget still works where modals are unsupported.
- If the modal API is missing, continue to use inline flows; rely on `widgetState` to avoid losing user progress.
