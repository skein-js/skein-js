// The console's whole data layer: load-on-mount, reload-on-demand, with the request aborted when the
// view goes away. There is no cache and no query library on purpose — an operations console should
// show what the server says *now*, and a stale-while-revalidate layer is the wrong default when the
// user is watching a run change state.

import { useCallback, useEffect, useState } from "react";

export interface AsyncState<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  /**
   * When `data` arrived, as epoch ms.
   *
   * Lets a caller tell a fetch that predates some event from one that followed it — which matters
   * whenever a view mixes loaded state with streamed state and must not apply the older of the two.
   */
  fetchedAt?: number;
  /** Re-run the loader (e.g. after a mutation, or from a Refresh button). */
  reload: () => void;
}

/**
 * Run `load` on mount and whenever `deps` change. The loader receives an `AbortSignal` that fires if
 * the component unmounts or the deps change mid-flight, so a slow response can never overwrite the
 * state belonging to a newer request.
 */
export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const [state, setState] = useState<{
    data?: T;
    error?: Error;
    loading: boolean;
    fetchedAt?: number;
  }>({ loading: true });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true }));
    load(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ data, loading: false, fetchedAt: Date.now() });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          error: error instanceof Error ? error : new Error(String(error)),
          loading: false,
        });
      });
    return () => controller.abort();
    // `load` is intentionally not a dependency: callers pass an inline closure, which would make it a
    // new function on every render and loop forever. `deps` is the honest dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  return { ...state, reload };
}
