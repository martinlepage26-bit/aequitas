// Relying Party config. Not in Section 3's explicit env var list — added
// here and logged in DECISIONS.md, since a WebAuthn RP cannot function
// without an RP ID and expected origin.
export const RP_NAME = process.env.WEBAUTHN_RP_NAME ?? "Aequitas";
export const RP_ID = process.env.WEBAUTHN_RP_ID ?? "localhost";
export const ORIGIN = process.env.WEBAUTHN_ORIGIN ?? "http://localhost:3417";

export const CHALLENGE_COOKIE = "aequitas_webauthn_challenge";
export const CHALLENGE_TTL_SECONDS = 5 * 60;
