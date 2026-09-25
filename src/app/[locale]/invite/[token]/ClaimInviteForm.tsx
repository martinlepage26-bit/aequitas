"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function ClaimInviteForm({ token, locale }: { token: string; locale: string }) {
  const t = useTranslations("invite");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function postJson(body: unknown) {
    const res = await fetch("/api/auth/invite/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Request failed.");
    return data;
  }

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const optionsJSON = await postJson({ step: "options", token });
      const response = await startRegistration({ optionsJSON });
      await postJson({ step: "verify", token, response });
      router.push(`/${locale}/cases`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={claim} disabled={busy}>
        {busy ? t("busy") : t("submit")}
      </button>
      {error && (
        <p role="alert" style={{ color: "#9b1c1c" }}>
          {error}
        </p>
      )}
    </div>
  );
}
