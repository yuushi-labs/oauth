/**
 * WebAuthn 登録の薄いラッパ（D-34-03 / §67）。暗号学的検証は `@simplewebauthn/server` に完全委譲し、
 * 自前実装は一切しない。ここは「引数の詰め替え」と「失敗を `ApiError` に丸める」だけを行う。
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import { ApiError } from '@/lib/errors';
import type { WebauthnConfig } from '@/lib/auth/passkey/config';

export async function generatePasskeyRegistrationOptions(args: {
  user: { id: string; username: string; displayName?: string | null };
  existingCredentialIds: string[];
  config: WebauthnConfig;
  /** DB に保存済みの challenge。渡すと options にその値が入り、verify で照合できる（§8.2）。 */
  challenge?: string;
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: args.config.rpName,
    rpID: args.config.rpID,
    // 文字列を渡すと UTF-8 として再エンコードされ値が変わる。base64url の**バイト列**に直して渡し、
    // `options.challenge` が保存値と同一の文字列になるようにする。
    ...(args.challenge ? { challenge: isoBase64URL.toBuffer(args.challenge) } : {}),
    // userID は省略すると毎回ランダムになり、同じユーザーの passkey が別ユーザー扱いになる。
    // `user.id`（usr_ + ULID）を固定で UTF-8 bytes にする。
    userID: isoUint8Array.fromUTF8String(args.user.id),
    userName: args.user.username,
    userDisplayName: args.user.displayName ?? args.user.username,
    excludeCredentials: args.existingCredentialIds.map((id) => ({ id })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    attestationType: 'none',
  });
}

export type VerifiedPasskeyRegistration = {
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: string[] | null;
  aaguid: string | null;
  backedUp: boolean;
};

export async function verifyPasskeyRegistration(args: {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
  config: WebauthnConfig;
}): Promise<VerifiedPasskeyRegistration> {
  let result;
  try {
    result = await verifyRegistrationResponse({
      response: args.response,
      expectedChallenge: args.expectedChallenge,
      expectedOrigin: args.config.allowedOrigins,
      expectedRPID: args.config.rpID,
      // `userVerification: 'preferred'` で登録するため UV フラグは必須にしない。
      // true にすると UV 非対応のセキュリティキーで登録できなくなる（D-34-04）。
      requireUserVerification: false,
    });
  } catch {
    throw new ApiError('INVALID_CODE', 'パスキーの登録を検証できませんでした', 400);
  }

  if (result.verified !== true) {
    throw new ApiError('INVALID_CODE', 'パスキーの登録を検証できませんでした', 400);
  }

  const { credential, aaguid, credentialBackedUp } = result.registrationInfo;
  const transports = args.response.response.transports;

  return {
    credentialId: credential.id,
    publicKey: isoBase64URL.fromBuffer(credential.publicKey),
    signCount: credential.counter,
    transports: transports && transports.length > 0 ? [...transports] : null,
    aaguid: aaguid ?? null,
    backedUp: credentialBackedUp,
  };
}
