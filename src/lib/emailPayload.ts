import { createDecipheriv, createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";
import { RECOVERY_TTL_MINUTES } from "./accountRecoveryConstants";

export type ProviderEmailPayload = {
  from: string;
  reply_to: string;
  to: [string];
  subject: string;
  text: string;
};

export type EncryptedEmailPayload = {
  deliveryPayloadCiphertext: Uint8Array<ArrayBuffer>;
  deliveryPayloadNonce: Uint8Array<ArrayBuffer>;
  deliveryPayloadTag: Uint8Array<ArrayBuffer>;
};

const payloadSchema = z.object({
  from: z.string().min(1).max(320),
  reply_to: z.string().min(1).max(320),
  to: z.tuple([z.string().min(1).max(320)]),
  subject: z.string().min(1).max(998),
  text: z.string().min(1).max(20_000),
}).strict();

function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) throw new Error("Email delivery encryption is not configured.");
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from("aequitas-email-outbox-v1", "utf8"),
    Buffer.from("AES-256-GCM", "utf8"),
    32,
  ));
}

function associatedData(kind: "invitation" | "recovery", id: string): Buffer {
  return Buffer.from(`aequitas:token-email:${kind}:${id}:v1`, "utf8");
}

export function encryptEmailPayload(kind: "invitation" | "recovery", id: string, payload: ProviderEmailPayload): EncryptedEmailPayload {
  const parsed = payloadSchema.parse(payload);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(associatedData(kind, id));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(parsed), "utf8"), cipher.final()]);
  const asDbBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
    const output = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    output.set(bytes);
    return output;
  };
  return {
    deliveryPayloadCiphertext: asDbBytes(ciphertext),
    deliveryPayloadNonce: asDbBytes(nonce),
    deliveryPayloadTag: asDbBytes(cipher.getAuthTag()),
  };
}

export function decryptEmailPayload(input: {
  kind: "invitation" | "recovery";
  id: string;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array;
}): ProviderEmailPayload {
  if (input.nonce.byteLength !== 12 || input.tag.byteLength !== 16 || input.ciphertext.byteLength > 24_000) {
    throw new Error("Stored email delivery payload is invalid.");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(input.nonce));
  decipher.setAAD(associatedData(input.kind, input.id));
  decipher.setAuthTag(Buffer.from(input.tag));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(input.ciphertext)), decipher.final()]).toString("utf8");
  return payloadSchema.parse(JSON.parse(plaintext));
}

function appUrl(path: string): string {
  const base = process.env.APP_URL;
  if (!base) throw new Error("Email delivery is not configured.");
  const url = new URL(base);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") throw new Error("Email delivery is not configured.");
  return new URL(path, url).toString();
}

function providerPayload(input: { email: string; subject: string; text: string }): ProviderEmailPayload {
  const from = process.env.EMAIL_FROM?.trim();
  const replyTo = process.env.EMAIL_REPLY_TO?.trim() || process.env.REPLY_TO?.trim();
  if (!from || !replyTo) throw new Error("Email delivery is not configured.");
  return { from, reply_to: replyTo, to: [input.email], subject: input.subject, text: input.text };
}

export function invitationEmailPayload(input: { email: string; locale: string; claimPath: string; validForDays?: number }): ProviderEmailPayload {
  const french = input.locale === "fr-CA";
  const validForDays = input.validForDays ?? 3;
  if (!Number.isSafeInteger(validForDays) || validForDays < 1) throw new Error("Invalid invitation validity period.");
  const validPeriod = french
    ? `${validForDays} ${validForDays === 1 ? "jour" : "jours"}`
    : `${validForDays} ${validForDays === 1 ? "day" : "days"}`;
  const link = appUrl(input.claimPath);
  return providerPayload({
    email: input.email,
    subject: french ? "Votre invitation à Aequitas" : "Your invitation to Aequitas",
    text: french
      ? `Vous avez reçu une invitation à Aequitas. Créez votre clé d’accès avec ce lien, valide pendant ${validPeriod} :\n\n${link}\n\nSi vous n’attendiez pas cette invitation, vous pouvez l’ignorer.`
      : `You have been invited to Aequitas. Create your passkey using this link, valid for ${validPeriod}:\n\n${link}\n\nIf you were not expecting this invitation, you can ignore it.`,
  });
}

export function recoveryEmailPayload(input: { email: string; locale: string; token: string }): ProviderEmailPayload {
  const french = input.locale === "fr-CA";
  const link = appUrl(`/${french ? "fr-CA" : "en-CA"}/auth/recover/${encodeURIComponent(input.token)}`);
  return providerPayload({
    email: input.email,
    subject: french ? "Récupérer votre accès Aequitas" : "Recover your Aequitas access",
    text: french
      ? `Une demande de récupération de votre accès Aequitas a été reçue. Pour créer une nouvelle clé d’accès, ouvrez ce lien à usage unique dans les ${RECOVERY_TTL_MINUTES} prochaines minutes :\n\n${link}\n\nSi vous n’avez pas demandé cette récupération, ignorez ce message. Votre clé d’accès actuelle reste valide tant que la récupération n’est pas terminée.`
      : `A request to recover your Aequitas access was received. To create a new passkey, open this single-use link within ${RECOVERY_TTL_MINUTES} minutes:\n\n${link}\n\nIf you did not request this, ignore this message. Your current passkey remains valid until recovery is completed.`,
  });
}
