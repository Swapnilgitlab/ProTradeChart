import type { ProviderInfo } from '../../lib/ipc';

/** A data source's terms notice (from the backend's provider catalogue), with a
 *  link to the terms themselves. Renders nothing for a source without one. */
export function TermsNotice({ provider }: { provider: ProviderInfo }) {
  if (!provider.termsNotice) return null;
  return (
    <div className="notice terms-notice about-links">
      <p>{provider.termsNotice}</p>
      {provider.termsUrl && <a href={provider.termsUrl}>Read {provider.label}&rsquo;s terms</a>}
    </div>
  );
}
