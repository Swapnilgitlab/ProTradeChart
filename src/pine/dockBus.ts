/** How things outside the React tree (a Vela legend button, the Script Editor tab) ask the
 *  Strategy Tester dock or the workspace to do something. Vela's contribution registries take
 *  plain callbacks with no access to React state, so they publish here and React subscribes. */

export type DockRequest =
  | { type: 'toggle-tester' }
  | { type: 'open-tester' }
  /** Open a chart indicator's source in the Script Editor tab. `indicatorId` is what the legend row
   *  carries; `source`/`name` let the editor show it even if the library script is gone. */
  | { type: 'edit-indicator'; indicatorId: string; source: string; name: string };

type Listener = (request: DockRequest) => void;

const listeners = new Set<Listener>();

export function publishDockRequest(request: DockRequest): void {
  for (const listener of [...listeners]) listener(request);
}

export function subscribeDockRequests(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
