export const STATUS = {
  PARTY_CONSENT: 'party_consent',
  MANAGER_REVIEW: 'manager_review',
  AGREED: 'agreed',
  DECLINED: 'declined',
};

export class WorkflowError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkflowError';
  }
}

// Status is derived, never stored, so it can never drift from the facts
// (consent grants and the manager's confirmation) that produced it.
export function computeStatus({ consumerConsent, retailerConsent, managerConfirmed }) {
  if (managerConfirmed) return STATUS.AGREED;
  if (consumerConsent && retailerConsent) return STATUS.MANAGER_REVIEW;
  return STATUS.PARTY_CONSENT;
}

export function assertCanAddMessage(status) {
  if (status === STATUS.AGREED || status === STATUS.DECLINED) {
    throw new WorkflowError('This case is closed. New responses cannot be added to a closed case record.');
  }
}

export function assertCanGrantPartyConsent(status, role, { hasRecommendation, acknowledgedVoluntary } = {}) {
  if (role !== 'consumer' && role !== 'retailer') {
    throw new WorkflowError('Only the consumer or retailer can grant party consent.');
  }
  if (status === STATUS.AGREED || status === STATUS.DECLINED) {
    throw new WorkflowError('This case is closed. Consent can no longer be recorded.');
  }
  if (!hasRecommendation) {
    throw new WorkflowError('A recommendation must be drafted before consent can be recorded.');
  }
  if (!acknowledgedVoluntary) {
    throw new WorkflowError(
      "Consent requires acknowledging that participation is voluntary and does not waive your right to the Office de la protection du consommateur or the courts."
    );
  }
}

export function assertCanGenerateRecommendation(status) {
  if (status === STATUS.AGREED || status === STATUS.DECLINED) {
    throw new WorkflowError('This case is closed. A new recommendation cannot be generated.');
  }
}

export function assertCanWithdrawPartyConsent(status, role) {
  if (role !== 'consumer' && role !== 'retailer') {
    throw new WorkflowError('Only the consumer or retailer can withdraw party consent.');
  }
  if (status === STATUS.AGREED) {
    throw new WorkflowError('This case is already agreed and closed. Consent cannot be withdrawn without a separate reopen action, which this prototype does not implement.');
  }
  if (status === STATUS.DECLINED) {
    throw new WorkflowError('This case is closed.');
  }
}

export function assertCanConfirmManagerReview(status) {
  if (status === STATUS.AGREED) {
    throw new WorkflowError('Manager review has already been confirmed for this case.');
  }
  if (status !== STATUS.MANAGER_REVIEW) {
    throw new WorkflowError(
      "Case-manager review requires both parties' consent to be recorded first. This case is not yet ready for review."
    );
  }
}

export function assertCanWithdrawManagerReview(status) {
  if (status !== STATUS.AGREED) {
    throw new WorkflowError('There is no confirmed manager review to withdraw.');
  }
}
