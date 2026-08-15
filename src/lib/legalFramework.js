// Static, human-verified reference to consumer-protection law. Scoped to
// Québec only because that is the only jurisdiction verified here — consumer
// protection in Canada is provincial, and nothing here should be read as
// applying elsewhere. Sourced 2026-08-14 from CanLII and the Office de la
// protection du consommateur; not legal advice and not a determination that
// any given case complies with the Act.

export const JURISDICTION = {
  id: 'QC-CA',
  label: 'Québec, Canada',
  regulator: {
    name: 'Office de la protection du consommateur (OPC)',
    url: 'https://www.opc.gouv.qc.ca/en/',
  },
  courtRecourse: 'the Small Claims Division of the Court of Québec',
};

export const STATUTE = {
  name: 'Consumer Protection Act (Québec)',
  citation: 'CQLR c P-40.1',
  sourceUrl: 'https://www.canlii.org/en/qc/laws/stat/cqlr-c-p-40.1/latest/cqlr-c-p-40.1.html',
  sourceName: 'CanLII',
};

export const PROVISIONS = [
  {
    section: 's. 37',
    inForce: true,
    summary: 'Goods must be fit for the purposes for which goods of that kind are ordinarily used.',
  },
  {
    section: 's. 38',
    inForce: true,
    summary:
      'Goods must be durable in normal use for a reasonable length of time, having regard to their price, the terms of the contract, and the conditions of their use. There is no fixed statutory timetable — reasonableness depends on the facts.',
  },
  {
    section: 's. 272',
    inForce: true,
    summary:
      'On breach of an obligation under the Act, the consumer may demand performance of the obligation (e.g. repair), a reduction of their obligation (e.g. a partial refund), or resolution of the contract (cancellation and refund) — plus damages where appropriate. These are alternative remedies, not a required sequence; which one fits depends on the severity of the defect.',
  },
  {
    section: 's. 11.1',
    inForce: true,
    summary:
      "A contract clause that obliges a consumer to submit a dispute to arbitration, or that restricts their right to go to court (including barring a class action), is prohibited. Once a dispute has actually arisen, the consumer may voluntarily agree to arbitrate it — but never as a pre-condition of the original purchase.",
  },
  {
    section: 'ss. 38.1–38.4',
    inForce: false,
    effectiveDate: '2026-10-05',
    summary:
      'A new "warranty of good working order" for specified new electronics and appliances (covering parts and labour). Not yet in force as of this case.',
  },
];

export const PARTICIPATION_DISCLOSURE =
  "Participation in this resolution process is voluntary. Recording your consent here does not waive your right to file a complaint with the Office de la protection du consommateur or to bring this matter before the Small Claims Division of the Court of Québec. You may only agree to binding arbitration for this specific dispute after it has arisen — never as a condition of your original purchase (Consumer Protection Act (Québec), CQLR c P-40.1, s. 11.1).";

export const LEGAL_FRAMEWORK_CAVEAT =
  'Informational reference only, compiled for this jurisdiction and not kept in sync with legislative amendments. It is not legal advice and is not a determination that this case complies with the Act — verify against the current legislation and consult qualified counsel before relying on it.';
