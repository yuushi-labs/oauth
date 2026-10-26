/**
 * テスト用の WebAuthn authenticator（§11.4）。
 *
 * `@simplewebauthn/server` は**実際の署名を検証する**ため、スタブでは通らない。ここでは
 * `node:crypto` で **P-256 の鍵ペア**を生成し、`clientDataJSON` / `authenticatorData` /
 * `attestationObject` / `signature` を仕様どおり組み立てて**実鍵で署名**する。
 * 生成した応答は `verifyRegistrationResponse` / `verifyAuthenticationResponse` を本当に通る。
 *
 * `origin` / `rpID` / `challenge` / `signCount` を**わざと外せる**ようにし、
 * `webauthn-origin` / `webauthn-rpid` / `webauthn-signcount` のネガティブケースを作る。
 */
import { createHash, generateKeyPairSync, randomBytes, sign as signWithKey, type KeyObject } from 'node:crypto';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

const COSE_KTY_EC2 = 2;
const COSE_ALG_ES256 = -7;
const COSE_CRV_P256 = 1;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

const encoder = new TextEncoder();

/** `Uint8Array<ArrayBuffer>` エイリアス（Web Crypto / simplewebauthn が要求する形）。 */
type Bytes = Uint8Array<ArrayBuffer>;

/** `Uint8Array<ArrayBuffer>` を保証するコピー（TS 5.7 の typed-array ジェネリクス対策）。 */
function toBytes(input: Uint8Array | Buffer | string): Bytes {
  const src = typeof input === 'string' ? encoder.encode(input) : input;
  const out = new Uint8Array(src.byteLength);
  out.set(src);
  return out;
}

export type MockAuthenticator = {
  /** base64url の credential ID。 */
  credentialId: string;
  /** base64url の COSE 公開鍵（`webauthn_credentials.public_key` に入る値）。 */
  publicKey: string;
  signCount: number;
  createRegistrationResponse(opts: {
    challenge: string;
    origin?: string;
    rpID?: string;
    signCount?: number;
    backedUp?: boolean;
  }): RegistrationResponseJSON;
  createAuthenticationResponse(opts: {
    challenge: string;
    origin?: string;
    rpID?: string;
    signCount?: number;
    /** 別の秘密鍵で署名する（クローン・署名不正の再現）。 */
    signWith?: MockAuthenticator;
  }): AuthenticationResponseJSON;
};

function sha256(input: Uint8Array | string): Bytes {
  return toBytes(createHash('sha256').update(typeof input === 'string' ? input : Buffer.from(input)).digest());
}

function encodeCosePublicKey(publicKey: KeyObject): Bytes {
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x = toBytes(isoBase64URL.toBuffer(jwk.x));
  const y = toBytes(isoBase64URL.toBuffer(jwk.y));
  const cose = new Map<string | number, Uint8Array | number>([
    [1, COSE_KTY_EC2],
    [3, COSE_ALG_ES256],
    [-1, COSE_CRV_P256],
    [-2, x],
    [-3, y],
  ]);
  return toBytes(isoCBOR.encode(cose as never));
}

/** ECDSA(P-256, SHA-256) で署名し、ASN.1 DER を返す（`unwrapEC2Signature` が期待する形式）。 */
function signDer(privateKey: KeyObject, data: Uint8Array): Bytes {
  return toBytes(signWithKey('sha256', Buffer.from(data), privateKey));
}

function buildAuthenticatorData(args: {
  rpID: string;
  flags: number;
  signCount: number;
  attestedCredentialData?: Bytes;
}): Bytes {
  const rpIdHash = sha256(args.rpID);
  const counter = new Uint8Array(4);
  new DataView(counter.buffer).setUint32(0, args.signCount >>> 0, false);
  const parts: Bytes[] = [rpIdHash, toBytes(new Uint8Array([args.flags])), toBytes(counter)];
  if (args.attestedCredentialData) parts.push(args.attestedCredentialData);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function buildClientDataJSON(args: {
  type: 'webauthn.create' | 'webauthn.get';
  challenge: string;
  origin: string;
}): Bytes {
  return toBytes(
    JSON.stringify({ type: args.type, challenge: args.challenge, origin: args.origin, crossOrigin: false }),
  );
}

export function createMockAuthenticator(args: { rpID: string; origin: string }): MockAuthenticator {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cosePublicKey = encodeCosePublicKey(publicKey);
  // authenticator ごとに一意な credential ID にする（同じ DB に複数登録するテストがあるため）。
  const credentialIdBytes = new Uint8Array(randomBytes(16));
  const credentialId = isoBase64URL.fromBuffer(credentialIdBytes);

  const authenticator: MockAuthenticator = {
    credentialId,
    publicKey: isoBase64URL.fromBuffer(cosePublicKey),
    signCount: 0,
    createRegistrationResponse(opts) {
      const rpID = opts.rpID ?? args.rpID;
      const origin = opts.origin ?? args.origin;
      const signCount = opts.signCount ?? 0;
      const flags = FLAG_UP | FLAG_UV | FLAG_AT | (opts.backedUp ? FLAG_BE | FLAG_BS : 0);

      const aaguid = new Uint8Array(16);
      const credIdLen = new Uint8Array(2);
      new DataView(credIdLen.buffer).setUint16(0, credentialIdBytes.length, false);
      const attestedCredentialData = new Uint8Array(
        aaguid.length + credIdLen.length + credentialIdBytes.length + cosePublicKey.length,
      );
      let offset = 0;
      attestedCredentialData.set(aaguid, offset);
      offset += aaguid.length;
      attestedCredentialData.set(credIdLen, offset);
      offset += credIdLen.length;
      attestedCredentialData.set(credentialIdBytes, offset);
      offset += credentialIdBytes.length;
      attestedCredentialData.set(cosePublicKey, offset);

      const authData = buildAuthenticatorData({ rpID, flags, signCount, attestedCredentialData });
      const attestationObject = toBytes(
        isoCBOR.encode(
          new Map<string, unknown>([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', authData],
          ]) as never,
        ),
      );

      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: isoBase64URL.fromBuffer(
            buildClientDataJSON({ type: 'webauthn.create', challenge: opts.challenge, origin }),
          ),
          attestationObject: isoBase64URL.fromBuffer(attestationObject),
          transports: ['internal', 'hybrid'],
        },
        clientExtensionResults: {},
      };
    },
    createAuthenticationResponse(opts) {
      const rpID = opts.rpID ?? args.rpID;
      const origin = opts.origin ?? args.origin;
      const signCount = opts.signCount ?? 0;
      const flags = FLAG_UP | FLAG_UV;

      const authData = buildAuthenticatorData({ rpID, flags, signCount });
      const clientDataJSON = buildClientDataJSON({
        type: 'webauthn.get',
        challenge: opts.challenge,
        origin,
      });
      const clientDataHash = sha256(clientDataJSON);
      const signatureBase = new Uint8Array(authData.length + clientDataHash.length);
      signatureBase.set(authData, 0);
      signatureBase.set(clientDataHash, authData.length);

      const signingKey = opts.signWith
        ? (opts.signWith as unknown as { privateKey: KeyObject }).privateKey
        : privateKey;
      const signature = signDer(signingKey, signatureBase);

      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
          authenticatorData: isoBase64URL.fromBuffer(authData),
          signature: isoBase64URL.fromBuffer(signature),
        },
        clientExtensionResults: {},
      };
    },
  };

  // 署名を差し替えられるよう、秘密鍵を非公開プロパティで保持する（`signWith` 用）。
  Object.defineProperty(authenticator, 'privateKey', { value: privateKey, enumerable: false });
  return authenticator;
}
