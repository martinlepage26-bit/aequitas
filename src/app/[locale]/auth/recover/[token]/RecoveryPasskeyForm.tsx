"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { usePasskeyFlow } from "../../../../../components/usePasskeyFlow";

export default function RecoveryPasskeyForm({ token, locale }: { token: string; locale: string }) {
  const t = useTranslations("recovery");
  const router = useRouter();
  const flow = usePasskeyFlow();
  const [error, setError] = useState(false);

  async function post(step: "options" | "verify", response: unknown, signal: AbortSignal) {
    const result = await fetch("/api/auth/recovery/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step, token, response }), signal });
    if (!result.ok) throw new Error("Recovery failed");
    return result.json();
  }

  async function replace() {
    setError(false);
    try {
      await flow.run(async signal => {
        const optionsJSON = await post("options", null, signal);
        signal.throwIfAborted();
        const response = await startRegistration({ optionsJSON });
        signal.throwIfAborted();
        await post("verify", response, signal);
        signal.throwIfAborted();
        router.replace(`/${locale}/cases`);
        router.refresh();
      });
    } catch { setError(true); }
  }

  return <div>
    <button type="button" onClick={replace} disabled={flow.busy}>{flow.busy ? t("replacing") : t("replacePasskey")}</button>
    {flow.busy && <button type="button" onClick={flow.cancel}>{t("cancel")}</button>}
    {error && <p role="alert" className="alert">{t("claimError")}</p>}
  </div>;
}
