import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { useOpenAiGlobal } from "./use-openai-global";
import {
  SET_GLOBALS_EVENT_TYPE,
  type SetGlobalsEvent,
  type UnknownObject,
} from "./types";

const NULL_WIDGET_STATE_SERIALIZED = "__widget_state_null__";

function serializeWidgetState(value: UnknownObject | null): string {
  if (value == null) {
    return NULL_WIDGET_STATE_SERIALIZED;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return `${NULL_WIDGET_STATE_SERIALIZED}_error`;
  }
}

function localBroadcastWidgetState(state: UnknownObject | null) {
  if (typeof window === "undefined" || window.openai == null) {
    return;
  }

  window.openai.widgetState = state;
  window.dispatchEvent(
    new CustomEvent(SET_GLOBALS_EVENT_TYPE, {
      detail: { globals: { widgetState: state } },
    }) as SetGlobalsEvent
  );
}

export function useWidgetState<T extends UnknownObject>(
  defaultState: T | (() => T)
): readonly [T, (state: SetStateAction<T>) => void];
export function useWidgetState<T extends UnknownObject>(
  defaultState?: T | (() => T | null) | null
): readonly [T | null, (state: SetStateAction<T | null>) => void];
export function useWidgetState<T extends UnknownObject>(
  defaultState?: T | (() => T | null) | null
): readonly [T | null, (state: SetStateAction<T | null>) => void] {
  const widgetStateFromWindow = useOpenAiGlobal("widgetState") as T | null;
  const lastRemoteStateRef = useRef<string>("__widget_state_unset__");

  const [widgetState, _setWidgetState] = useState<T | null>(() => {
    if (widgetStateFromWindow != null) {
      return widgetStateFromWindow;
    }

    return typeof defaultState === "function"
      ? defaultState()
      : defaultState ?? null;
  });

  useEffect(() => {
    const serialized = serializeWidgetState(widgetStateFromWindow);
    if (serialized === lastRemoteStateRef.current) {
      return;
    }

    // Ignore host updates that clear widgetState so we don't clobber in-session
    // state that came from toolInput/toolOutput.
    if (widgetStateFromWindow == null) {
      return;
    }

    lastRemoteStateRef.current = serialized;
    _setWidgetState(widgetStateFromWindow);
  }, [widgetStateFromWindow]);

  const setWidgetState = useCallback(
    (state: SetStateAction<T | null>) => {
      _setWidgetState((prevState) => {
        const newState = typeof state === "function" ? state(prevState) : state;

        lastRemoteStateRef.current = serializeWidgetState(newState);

        if (typeof window !== "undefined") {
          localBroadcastWidgetState(newState);

          if (newState != null && window.openai?.setWidgetState) {
            void window.openai.setWidgetState(newState);
          }
        }

        return newState;
      });
    },
    []
  );

  return [widgetState, setWidgetState] as const;
}
