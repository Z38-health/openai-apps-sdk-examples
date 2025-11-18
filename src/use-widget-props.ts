import { useOpenAiGlobal } from "./use-openai-global";
import type { ToolResponseEnvelope } from "./types";

export function useWidgetProps<T extends Record<string, unknown>>(
  defaultState?: T | (() => T)
): T {
  const toolResponse = useOpenAiGlobal("toolOutput") as
    | ToolResponseEnvelope<T>
    | null;
  const structuredContent =
    typeof toolResponse?.structuredContent === "object" &&
    toolResponse.structuredContent !== null
      ? (toolResponse.structuredContent as T)
      : null;

  const props = (structuredContent ??
    (useOpenAiGlobal("toolOutput") as T | null)) as T | null;

  const fallback =
    typeof defaultState === "function"
      ? (defaultState as () => T | null)()
      : defaultState ?? null;

  const resolved = props ?? fallback;

  return resolved ?? ({} as T);
}
