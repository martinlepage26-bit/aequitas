import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { cfg } from "./config";
import type { Client, Res } from "./http";

/**
 * Software WebAuthn authenticator. Produces cryptographically valid `none`-attestation registrations
 * and ES256 assertions, so the server's real verification code (@simplewebauthn/server) runs unmodified.
 * Unlike test/helpers/softAuthenticator.ts the signature counter is controllable, which replay tests need.
 */
const b64 = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");
export type CounterMode = "increment" | "zero" | "repeat";
export type Tamper = "signature" | "challenge" | "type" | "rp" | "origin" | "flags";

export class SoftAuthenticator {
  readonly credentialId = b64(randomBytes(32));
  readonly privateKey: KeyObject;
  readonly publicJwk: { x: string; y: string };
  counter = 0;
  constructor(private origin = cfg.origin, private rpId = cfg.rpId) {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.publicJwk = { x: jwk.x!, y: jwk.y! };
  }

  attestation(challenge: string, opts: { origin?: string; rpId?: string; signCount?: number; type?: string } = {}) {
    const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1, 2], [3, -7], [-1, 1],
      [-2, new Uint8Array(Buffer.from(this.publicJwk.x, "base64url"))],
      [-3, new Uint8Array(Buffer.from(this.publicJwk.y, "base64url"))],
    ]));
    const credId = Buffer.from(this.credentialId, "base64url");
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credId.length);
    const signCount = Buffer.alloc(4); signCount.writeUInt32BE(opts.signCount ?? 0);
    const authData = Buffer.concat([createHash("sha256").update(opts.rpId ?? this.rpId).digest(), Buffer.from([0x45]), signCount, Buffer.alloc(16), idLen, credId, Buffer.from(cose)]);
    const attestationObject = isoCBOR.encode(new Map<string, string | Map<string, string> | Uint8Array>([["fmt", "none"], ["attStmt", new Map<string, string>()], ["authData", new Uint8Array(authData)]]));
    const clientData = Buffer.from(JSON.stringify({ type: opts.type ?? "webauthn.create", challenge, origin: opts.origin ?? this.origin, crossOrigin: false }), "utf8");
    this.counter = opts.signCount ?? 0;
    return { id: this.credentialId, rawId: this.credentialId, type: "public-key" as const,
      response: { clientDataJSON: b64(clientData), attestationObject: b64(attestationObject), transports: ["internal"] }, clientExtensionResults: {} };
  }

  assertion(challenge: string, opts: { counter?: CounterMode; tamper?: Tamper; origin?: string; rpId?: string } = {}) {
    const mode = opts.counter ?? "increment";
    if (mode === "increment") this.counter += 1; else if (mode === "zero") this.counter = 0;
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.counter);
    const flags = opts.tamper === "flags" ? 0x00 : 0x05; // UP|UV; "flags" tamper clears user-presence
    const authData = Buffer.concat([createHash("sha256").update(opts.tamper === "rp" ? "evil.invalid" : (opts.rpId ?? this.rpId)).digest(), Buffer.from([flags]), counter]);
    const clientData = Buffer.from(JSON.stringify({
      type: opts.tamper === "type" ? "webauthn.create" : "webauthn.get",
      challenge: opts.tamper === "challenge" ? b64(randomBytes(32)) : challenge,
      origin: opts.tamper === "origin" ? "https://evil.invalid" : (opts.origin ?? this.origin), crossOrigin: false }), "utf8");
    let signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientData).digest()]), this.privateKey);
    if (opts.tamper === "signature") { signature = Buffer.from(signature); signature[signature.length - 1] ^= 0xff; }
    return { id: this.credentialId, rawId: this.credentialId, type: "public-key" as const,
      response: { authenticatorData: b64(authData), clientDataJSON: b64(clientData), signature: b64(signature) }, clientExtensionResults: {} };
  }
}

export async function register(client: Client, input: { email: string; displayName: string; globalRole: string; locale?: string; authenticator?: SoftAuthenticator }) {
  const auth = input.authenticator ?? new SoftAuthenticator();
  const options = await client.post("/api/auth/webauthn/register", { step: "options", email: input.email, displayName: input.displayName, globalRole: input.globalRole, locale: input.locale ?? "fr-CA" });
  if (options.status !== 200) return { options, verify: null as Res | null, auth };
  const verify = await client.post("/api/auth/webauthn/register", { step: "verify", response: auth.attestation(options.json.challenge) });
  return { options, verify, auth };
}

export async function signInOptions(client: Client, email: string) {
  return client.post("/api/auth/webauthn/authenticate", { step: "options", email });
}
export async function signIn(client: Client, auth: SoftAuthenticator, email: string, opts: { counter?: CounterMode; tamper?: Tamper } = {}) {
  const options = await signInOptions(client, email);
  if (options.status !== 200) return { options, verify: null as Res | null };
  const verify = await client.post("/api/auth/webauthn/authenticate", { step: "verify", response: auth.assertion(options.json.challenge, opts) });
  return { options, verify };
}

export async function claimInvite(client: Client, token: string, authenticator?: SoftAuthenticator) {
  const auth = authenticator ?? new SoftAuthenticator();
  const options = await client.post("/api/auth/invite/claim", { step: "options", token });
  if (options.status !== 200) return { options, verify: null as Res | null, auth };
  const verify = await client.post("/api/auth/invite/claim", { step: "verify", token, response: auth.attestation(options.json.challenge) });
  return { options, verify, auth };
}

/** Token carried in a claimPath like /fr-CA/invite/<urlencoded token>. */
export const tokenFromClaimPath = (claimPath: string) => decodeURIComponent(claimPath.split("/invite/")[1]);
