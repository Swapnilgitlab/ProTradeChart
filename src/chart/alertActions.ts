import type { Vela } from '@luxalgo/vela';
import { registerWidgetAction, type WidgetContext } from '@luxalgo/vela/plugin';
import { openAlerts } from '../alerts/ui';
import { normalizeSymbol } from '../lib/symbols';

/** Puts "set an alert" where people look for it on a chart: the right-click
 *  menu (using the price under the cursor), the price axis's menu, and the
 *  toolbar. Vela hosts these actions; the alerts dialog itself is the app's,
 *  so each action only says what was asked for and where. */

/** The price the cursor was last over, per chart. A right-click is preceded by
 *  the pointer moving there, so this is the price the person clicked at. */
const cursorPrice = new WeakMap<object, number>();

/** Starts remembering the price under the cursor of `chart`. Returns a function that stops. */
export function trackCursorPrice(chart: Vela): () => void {
  return chart.renderer.onCrosshairMove((event) => {
    // A study pane (RSI, volume) has a scale of its own: not a price.
    if (event.price !== null && event.paneKind !== 'study') cursorPrice.set(chart, event.price);
  });
}

function requestAlert(ctx: WidgetContext, atCursor: boolean): void {
  openAlerts({
    symbol: normalizeSymbol(ctx.symbol),
    price: atCursor ? (cursorPrice.get(ctx.chart) ?? null) : null,
  });
}

let installed = false;

/** Registers the actions. Once is enough: Vela reads them for every chart, present and future. */
export function installAlertActions(): void {
  if (installed) return;
  installed = true;
  registerWidgetAction({
    id: 'alerts.add-here',
    target: 'context:body',
    label: 'Add alert here…',
    icon: 'bell',
    order: 10,
    run: (ctx) => requestAlert(ctx, true),
  });
  registerWidgetAction({
    id: 'alerts.add-at-price',
    target: 'context:price-axis',
    label: 'Add alert at this price…',
    icon: 'bell',
    order: 10,
    run: (ctx) => requestAlert(ctx, true),
  });
  registerWidgetAction({
    id: 'alerts.add',
    target: 'topbar',
    label: 'Alert',
    icon: 'bell',
    align: 'left',
    order: 10,
    run: (ctx) => requestAlert(ctx, false),
  });
}
