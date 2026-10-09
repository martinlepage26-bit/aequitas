import { renderToStaticMarkup } from "react-dom/server";
import type { ClaimsView } from "../../../../domain/claimPresentation";
import { ClaimsList, type ClaimsCopy } from "./ClaimsList";

/** Renders the same panel the case page shows, for the provenance acceptance test. */
export function renderClaimsPanelHtml(props: {
  locale: string;
  view: ClaimsView;
  authors: Array<{ id: string; displayName: string }>;
  copy: ClaimsCopy;
}): string {
  return renderToStaticMarkup(<ClaimsList {...props} />);
}
