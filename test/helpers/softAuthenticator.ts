import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

/**
 * A software WebAuthn authenticator for tests: produces a real, verifiable
 * `none`-attestation registration response (P-256 / ES256, user present and
 * verified) for the options the server returned. Lets the HTTP suites drive
 * the full register and invite-claim ceremonies without hardware.
 */
function b64url(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString("base64url");
}

const signingKeys = new Map<string, KeyObject>();

export function createRegistrationResponse(options: { challenge: string; rp?: { id?: string } }, origin: string, rpId: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = randomBytes(32);

  const cosePublicKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
    ])
  );

  const rpIdHash = createHash("sha256").update(rpId).digest();
  const flags = Buffer.from([0x45]); // UP | UV | AT
  const signCount = Buffer.alloc(4);
  const aaguid = Buffer.alloc(16);
  const credIdLength = Buffer.alloc(2);
  credIdLength.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([rpIdHash, flags, signCount, aaguid, credIdLength, credentialId, Buffer.from(cosePublicKey)]);

  const attestationObject = isoCBOR.encode(
    new Map<string, string | Map<string, string> | Uint8Array>([
      ["fmt", "none"],
      ["attStmt", new Map<string, string>()],
      ["authData", new Uint8Array(authData)],
    ])
  );

  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }),
    "utf8"
  );

  const id = b64url(credentialId);
  signingKeys.set(id, privateKey);
  return {
    id,
    rawId: id,
    type: "public-key" as const,
    response: {
      clientDataJSON: b64url(clientDataJSON),
      attestationObject: b64url(attestationObject),
      transports: ["internal"],
    },
    clientExtensionResults: {},
  };
}

export function createAuthenticationResponse(credentialId: string, challenge: string, origin: string, rpId: string) {
  const key = signingKeys.get(credentialId);
  if (!key) throw new Error("Unknown software credential");
  const counter = Buffer.alloc(4); counter.writeUInt32BE(1);
  const authenticatorData = Buffer.concat([createHash("sha256").update(rpId).digest(), Buffer.from([0x05]), counter]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
  const signature = sign("sha256", Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]), key);
  return { id: credentialId, rawId: credentialId, type: "public-key", response: { authenticatorData: b64url(authenticatorData), clientDataJSON: b64url(clientDataJSON), signature: b64url(signature) }, clientExtensionResults: {} };
}
