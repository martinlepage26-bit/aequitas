import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptEmailPayload,
  encryptEmailPayload,
  invitationEmailPayload,
  recoveryEmailPayload,
} from "../../src/lib/emailPayload";

afterEach(() => vi.unstubAllEnvs());
function configure() {
  vi.stubEnv("SESSION_SECRET", "");
  vi.stubEnv("AEQUITAS_EMAIL_OUTBOX_ENCRYPTION_KEY", "synthetic-email-outbox-key-with-more-than-32-bytes");
  vi.stubEnv("EMAIL_FROM", "noreply@example.org");
  vi.stubEnv("EMAIL_REPLY_TO", "reply@example.org");
  vi.stubEnv("APP_URL", "https://aequitas.example");
}

describe("encrypted token email payloads", () => {
  it("encrypts the complete request with a dedicated key and binds it to the invitation record", () => {
    configure();
    const token = "synthetic-single-use-token-value";
    const email = "private-recipient@example.org";
    const payload = invitationEmailPayload({ email, locale: "fr-CA", claimPath: `/fr-CA/invite/${token}`, validForDays: 5 });
    const encrypted = encryptEmailPayload("invitation", "invitation-id-1", payload);
    const stored = Buffer.concat([encrypted.deliveryPayloadCiphertext, encrypted.deliveryPayloadNonce, encrypted.deliveryPayloadTag]);

    expect(stored.includes(Buffer.from(token))).toBe(false);
    expect(stored.includes(Buffer.from(email))).toBe(false);
    expect(decryptEmailPayload({
      kind: "invitation", id: "invitation-id-1",
      ciphertext: encrypted.deliveryPayloadCiphertext,
      nonce: encrypted.deliveryPayloadNonce,
      tag: encrypted.deliveryPayloadTag,
    })).toEqual(payload);
    expect(() => decryptEmailPayload({
      kind: "invitation", id: "invitation-id-2",
      ciphertext: encrypted.deliveryPayloadCiphertext,
      nonce: encrypted.deliveryPayloadNonce,
      tag: encrypted.deliveryPayloadTag,
    })).toThrow();
  });

  it("rejects tampered ciphertext and missing key material", () => {
    configure();
    const encrypted = encryptEmailPayload("recovery", "recovery-id", recoveryEmailPayload({ email: "private@example.org", locale: "en-CA", token: "synthetic-recovery-token" }));
    const tampered = Buffer.from(encrypted.deliveryPayloadCiphertext);
    tampered[0] = tampered[0] ^ 0x01;
    expect(() => decryptEmailPayload({ kind: "recovery", id: "recovery-id", ciphertext: tampered, nonce: encrypted.deliveryPayloadNonce, tag: encrypted.deliveryPayloadTag })).toThrow();
    vi.stubEnv("AEQUITAS_EMAIL_OUTBOX_ENCRYPTION_KEY", "too-short");
    expect(() => encryptEmailPayload("recovery", "recovery-id-2", recoveryEmailPayload({ email: "private@example.org", locale: "en-CA", token: "token" }))).toThrow("Email delivery encryption is not configured.");
  });

  it("keeps invitation and recovery messages bilingual and short-lived", () => {
    configure();
    const frenchInvite = invitationEmailPayload({ email: "f@example.org", locale: "fr-CA", claimPath: "/fr-CA/invite/secret", validForDays: 1 });
    const englishInvite = invitationEmailPayload({ email: "e@example.org", locale: "en-CA", claimPath: "/en-CA/invite/secret", validForDays: 5 });
    expect(frenchInvite.subject).toBe("Votre invitation à Aequitas");
    expect(frenchInvite.text).toContain("valide pendant 1 jour");
    expect(englishInvite.text).toContain("valid for 5 days");
    const recovery = recoveryEmailPayload({ email: "r@example.org", locale: "en-CA", token: "single-use" });
    expect(recovery.subject).toBe("Recover your Aequitas access");
    expect(recovery.text).toContain("within 30 minutes");
    expect(recovery.text).toContain("/en-CA/auth/recover/single-use");
  });
});
