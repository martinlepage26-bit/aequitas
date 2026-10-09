"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { usePasskeyFlow } from "../../../../components/usePasskeyFlow";

export default function ClaimInviteForm({ token, locale }: { token: string; locale: string }) {
  const t = useTranslations("invite");
  const router = useRouter();
  const flow = usePasskeyFlow();
  const { busy } = flow;
  const [error, setError] = useState<string | null>(null);

  async function postJson(body: unknown, signal: AbortSignal) {
    const res = await fetch("/api/auth/invite/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Request failed.");
    return data;
  }

  async function claim() {
    setError(null);
    try {
      await flow.run(async signal => {
        const optionsJSON = await postJson({ step: "options", token }, signal);
        signal.throwIfAborted();
        const response = await startRegistration({ optionsJSON });
        signal.throwIfAborted();
        await postJson({ step: "verify", token, response }, signal);
        signal.throwIfAborted();
        router.replace(`/${locale}/cases`);
        router.refresh();
      });
    } catch {
      setError(t("failed"));
    }
  }

  return (
    <div>
      <button type="button" onClick={claim} disabled={busy}>
        {busy ? t("busy") : t("submit")}
      </button>
      {busy && <button type="button" onClick={flow.cancel}>{t("cancel")}</button>}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </div>
  );
}
