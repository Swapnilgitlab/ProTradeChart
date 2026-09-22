import { registerLegendAction } from '@luxalgo/vela/plugin';
import { registerIcon, svg16 } from '@luxalgo/vela/ui';
import { publishDockRequest } from './dockBus';

const EDIT_ICON = 'charting.pine.edit';

let installed = false;

/** Adds an "Edit script" button to the legend row of every script indicator — TradingView's
 *  "Source code" action — which opens that script in the Script Editor. Register before the
 *  first workspace is built, like every Vela contribution. */
export function installPineHostActions(): void {
  if (installed) return;
  installed = true;
  registerIcon(
    EDIT_ICON,
    svg16('<path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'),
  );
  registerLegendAction({
    id: 'charting.pine.edit',
    icon: EDIT_ICON,
    tooltip: 'Edit script',
    order: 10,
    // Native indicators have no source to show.
    when: (indicator) => indicator.source !== undefined,
    run: (_ctx, indicator) => {
      if (indicator.source === undefined) return;
      publishDockRequest({ type: 'edit-indicator', indicatorId: indicator.id, source: indicator.source, name: indicator.title });
    },
  });
}
