import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { signInPath } from "../../../../lib/authPaths";
import { getSession } from "../../../../lib/session";
import { readCaseAgentStatus, type CaseAgentStatus } from "../../../../domain/caseAgent/status";
import styles from "./operations.module.css";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "adminOperations" });
  return { title: `${t("title")} · Aequitas` };
}

function timestamp(value: string | null, locale: string, notRecorded: string) {
  if (!value) return notRecorded;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

export default async function OperationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const session = await getSession();
  if (!session) redirect(signInPath(locale, `/${locale}/admin/operations`));
  if (session.globalRole !== "ADMIN") notFound();

  const t = await getTranslations("adminOperations");
  const tState = await getTranslations("workspace.state");
  let status: CaseAgentStatus | null = null;
  try {
    status = await readCaseAgentStatus();
  } catch {
    // Keep database/provider configuration details out of the page and logs.
    console.error("Admin operations status unavailable.");
  }

  if (!status) {
    return <main className={styles.page}><h1>{t("title")}</h1><p className={styles.alert} role="status">{t("unavailable")}</p></main>;
  }

  const healthLabel = (health: CaseAgentStatus["scheduledOperations"][number]["health"]) => {
    const labels: Record<typeof health, string> = {
      never_run: t("healthNeverRun"),
      running: t("healthRunning"),
      stalled: t("healthStalled"),
      healthy: t("healthHealthy"),
      overdue: t("healthOverdue"),
      failed: t("healthFailed"),
      interrupted: t("healthInterrupted"),
      unknown: t("healthUnknown"),
    };
    return labels[health];
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>{t("title")}</h1>
        <p>{t("explain")}</p>
        <p className={styles.notice}>{t("scopeNotice")}</p>
        <p className={styles.generated}>
          {t("generatedAt", { time: timestamp(status.generatedAt, locale, t("notRecorded")) })}
          {" · "}<a href={`/${locale}/admin/operations`}>{t("refresh")}</a>
        </p>
      </header>

      <section className={styles.panel} aria-labelledby="agent-readiness">
        <div className={styles.sectionHeading}>
          <h2 id="agent-readiness">{t("agentHeading")}</h2>
          <span className={status.agent.readyForNewCases ? styles.good : styles.bad}>
            {status.agent.readyForNewCases ? t("ready") : t("notReady")}
          </span>
        </div>
        <dl className={styles.metrics}>
          <div><dt>{t("agentEnabled")}</dt><dd>{status.agent.enabled ? t("enabled") : t("disabled")}</dd></div>
          <div><dt>{t("modelConfigured")}</dt><dd>{status.agent.modelConfigured ? t("configured") : t("notConfigured")}</dd></div>
          <div><dt>{t("serviceAccounts")}</dt><dd>{status.agent.serviceAccountCount}</dd></div>
          <div><dt>{t("runtimeConfigured")}</dt><dd>{status.agent.runtimeConfigured ? t("yes") : t("no")}</dd></div>
          <div><dt>{t("dailyCalls")}</dt><dd>{status.agent.dailyModelCalls.limit === null
            ? t("callsUsed", { used: status.agent.dailyModelCalls.used })
            : t("callsRemaining", { used: status.agent.dailyModelCalls.used, limit: status.agent.dailyModelCalls.limit, remaining: status.agent.dailyModelCalls.remaining ?? 0 })}</dd></div>
        </dl>
        {status.agent.missingProgramSettings.length > 0 && (
          <div>
            <h3>{t("missingSettings")}</h3>
            <ul className={styles.codes}>{status.agent.missingProgramSettings.map((name) => <li key={name}><code>{name}</code></li>)}</ul>
          </div>
        )}
      </section>

      <section className={styles.panel} aria-labelledby="case-queues">
        <h2 id="case-queues">{t("caseQueueHeading")}</h2>
        <dl className={styles.metrics}>
          <div><dt>{t("eligibleOpen")}</dt><dd>{status.cases.unassignedRetailOpenWithinLimit ?? t("notAvailable")}</dd></div>
          <div><dt>{t("unassignedEscalations")}</dt><dd>{status.cases.escalatedUnassigned}</dd></div>
          <div><dt>{t("activeLeases")}</dt><dd>{status.cases.leases.active}</dd></div>
          <div><dt>{t("expiredLeases")}</dt><dd>{status.cases.leases.expired}</dd></div>
          <div><dt>{t("latestAttempt")}</dt><dd>{timestamp(status.cases.latestAgentAttemptAt, locale, t("notRecorded"))}</dd></div>
        </dl>
        <div className={styles.columns}>
          <div>
            <h3>{t("activeCases")}</h3>
            {Object.entries(status.cases.activeByState).length === 0
              ? <p>{t("none")}</p>
              : <ul>{Object.entries(status.cases.activeByState).map(([state, count]) => <li key={state}>{tState(state)} <strong>{count}</strong></li>)}</ul>}
          </div>
          <div>
            <h3>{t("escalatedCases")}</h3>
            {Object.entries(status.cases.escalatedOpenByReason).length === 0
              ? <p>{t("none")}</p>
              : <ul>{Object.entries(status.cases.escalatedOpenByReason).map(([reason, count]) => <li key={reason}><code>{reason}</code> <strong>{count}</strong></li>)}</ul>}
          </div>
        </div>
      </section>

      <section className={styles.panel} aria-labelledby="email-operations">
        <h2 id="email-operations">{t("emailHeading")}</h2>
        <p>{t("emailConfigured")}: <strong>{status.email.configured ? t("configured") : t("notConfigured")}</strong></p>
        <dl className={styles.metrics}>
          <div><dt>{t("retryingNotifications")}</dt><dd>{status.email.notifications.retrying}</dd></div>
          <div><dt>{t("exhaustedNotifications")}</dt><dd>{status.email.notifications.exhausted}</dd></div>
          <div><dt>{t("retryingTokenEmails")}</dt><dd>{status.email.notifications.tokenEmailRetrying}</dd></div>
          <div><dt>{t("exhaustedTokenEmails")}</dt><dd>{status.email.notifications.tokenEmailExhausted}</dd></div>
        </dl>
      </section>

      <section className={styles.panel} aria-labelledby="scheduled-operations">
        <h2 id="scheduled-operations">{t("scheduledHeading")}</h2>
        <div className={styles.tableWrap}>
          <table>
            <caption>{t("scheduledCaption")}</caption>
            <thead><tr><th scope="col">{t("operation")}</th><th scope="col">{t("health")}</th><th scope="col">{t("interval")}</th><th scope="col">{t("lastStarted")}</th><th scope="col">{t("lastSucceeded")}</th></tr></thead>
            <tbody>{status.scheduledOperations.map((operation) => (
              <tr key={operation.name}>
                <th scope="row">{operation.name === "case_agent" ? t("caseAgentWorker") : t("notificationRetryWorker")}</th>
                <td>{healthLabel(operation.health)}</td>
                <td>{t("minutes", { count: operation.intervalMinutes })}</td>
                <td>{timestamp(operation.lastStartedAt, locale, t("notRecorded"))}</td>
                <td>{timestamp(operation.lastSuccessfulAt, locale, t("notRecorded"))}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
