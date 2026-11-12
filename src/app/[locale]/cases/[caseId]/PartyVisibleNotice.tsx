"use client";

import { useTranslations } from "next-intl";

/** Shown where a mediator is writing text a party may read. */
export default function PartyVisibleNotice({ partyName }: { partyName?: string }) {
  const t = useTranslations("workspace");
  return (
    <p className="hint" role="note">
      {partyName ? t("partyOutcomeNotice", { name: partyName }) : t("partyVisibleNotice")}
    </p>
  );
}
