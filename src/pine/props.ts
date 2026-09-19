/** A strategy's settings as the engine will use them: each declared default, overridden by
 *  whatever the user changed on the Properties tab. Vela stores only the overrides
 *  (`propValues`), so commission, capital and currency have to be read through this. */

interface PropsSource {
  props: readonly { key: string; defval: unknown }[];
  propValues(): Record<string, unknown>;
}

export function effectiveProps(source: PropsSource): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of source.props) out[p.key] = p.defval;
  return { ...out, ...source.propValues() };
}

export function numberProp(props: Record<string, unknown>, key: string, fallback: number): number {
  const v = props[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** `undefined` when the script didn't pick a currency (`NONE`). */
export function currencyProp(props: Record<string, unknown>): string | undefined {
  const v = props.currency;
  return typeof v === 'string' && v && v !== 'NONE' ? v : undefined;
}
