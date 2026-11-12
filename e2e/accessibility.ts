import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

const WCAG_A_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Automated checks catch common WCAG issues; they do not establish full conformance. */
export async function expectNoAutomatedWcagViolations(page: Page, surface: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_A_AA_TAGS).analyze();
  const violations = results.violations.map(({ id, impact, help, nodes }) => ({
    id,
    impact,
    help,
    nodes: nodes.map((node) => ({ target: node.target, failureSummary: node.failureSummary })),
  }));
  expect(violations, `${surface} has automated WCAG A/AA violations`).toEqual([]);
}
