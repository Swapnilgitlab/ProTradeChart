/** Vela's own indicator ids carry no meaning for us; the ones we mint look like
 *  `<scriptId>~<suffix>`, so a legend row can be traced back to the library script it came
 *  from — and so an indicator Vela added itself (a bundled script from the Indicators
 *  picker) can be told apart from one this app added. Kept apart from the engine module so
 *  code that only needs the ids doesn't load the worker engine. */
const ID_SEPARATOR = '~';

export function makeIndicatorId(scriptId: string): string {
  return `${scriptId}${ID_SEPARATOR}${crypto.randomUUID().slice(0, 8)}`;
}

/** The library script an indicator id was minted for, or null for an id we didn't mint. */
export function scriptIdOf(indicatorId: string): string | null {
  const at = indicatorId.indexOf(ID_SEPARATOR);
  return at > 0 ? indicatorId.slice(0, at) : null;
}
