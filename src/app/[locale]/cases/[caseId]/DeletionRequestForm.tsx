"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

export default function DeletionRequestForm({ caseId, locale }: { caseId: string; locale: string }) {
  const t = useTranslations("deletionRequest");
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  async function submit() {
    setState("busy");
    try {
      const response = await fetch(`/api/cases/${caseId}/deletion`, { method: "POST" });
      if (!response.ok) throw new Error("Request failed");
      router.push(`/${locale}/cases/${caseId}/deletion`);
    } catch { setState("error"); }
  }
  return <section aria-labelledby="deletion-request-title" style={{ marginTop: "2rem" }}>
    <h2 id="deletion-request-title">{t("title")}</h2>
    <p>{t("intro")}</p>
    <button type="button" onClick={submit} disabled={state === "busy"}>{t(state === "busy" ? "busy" : "request")}</button>
    {state === "error" && <p role="alert">{t("error")}</p>}
  </section>;
}
