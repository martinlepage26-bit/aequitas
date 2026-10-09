"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export default function WithdrawButton({ caseId }: { caseId: string }) {
  const t = useTranslations("workspace.withdraw");
  const router = useRouter();
  const [status, setStatus] = useState<{ kind: "idle" | "confirming" | "busy" | "error"; message?: string }>({ kind: "idle" });

  async function handleWithdraw() {
    setStatus({ kind: "busy" });
    const res = await fetch(`/api/cases/${caseId}/withdraw`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus({ kind: "error", message: data.message || t("error") });
      return;
    }
    setStatus({ kind: "idle" });
    router.refresh();
  }

  if (status.kind === "confirming") {
    return (
      <div style={{ marginTop: "1rem" }}>
        <p role="alert">{t("confirmPrompt")}</p>
        <button type="button" onClick={handleWithdraw}>
          {t("confirmButton")}
        </button>{" "}
        <button type="button" onClick={() => setStatus({ kind: "idle" })}>
          {t("cancelButton")}
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: "1rem" }}>
      <button type="button" onClick={() => setStatus({ kind: "confirming" })} disabled={status.kind === "busy"}>
        {status.kind === "busy" ? t("withdrawing") : t("withdrawButton")}
      </button>
      {status.kind === "error" && (
        <p role="alert" className="alert">
          {status.message}
        </p>
      )}
    </div>
  );
}
