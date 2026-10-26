/**
 * WebAuthn 認証（ログイン・再認証）の薄いラッパ（D-34-03 / §67）。
 * 署名検証・challenge 照合・origin / rpID 照合・`sign_count` 後退検知はすべて
 * `@simplewebauthn/server` が行う。ここは引数の詰め替えとエラーの丸めだけを行う。
 */
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { ApiError } from '@/lib/errors';
import type { WebauthnConfig } from '@/lib/auth/passkey/config';

export async function generatePasskeyAuthenticationOptions(args: {
  credentials?: { credentialId: string; transports: string[] | null }[];
  config: WebauthnConfig;
  /** DB に保存済みの challenge。渡すと options にその値が入り、verify で照合できる（§8.3）。 */
  challenge?: string;
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const allowCredentials = (args.credentials ?? []).map((credential) => ({
    id: credential.credentialId,
    ...(credential.transports && credential.transports.length > 0
      ? { transports: credential.transports as never }
      : {}),
  }));

  return generateAuthenticationOptions({
    rpID: args.config.rpID,
    userVerification: 'preferred',
    // 文字列を渡すと UTF-8 として再エンコードされ値が変わる。base64url の**バイト列**に直して渡し、
    // `options.challenge` が保存値と同一の文字列になるようにする。
    ...(args.challenge ? { challenge: isoBase64URL.toBuffer(args.challenge) } : {}),
    // 空配列は discoverable credential を許容する（§32 のログイン）。
    allowCredentials,
  });
}

export async function verifyPasskeyAuthentication(args: {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  storedCredential: {
    credentialId: string;
    publicKey: string;
    signCount: number;
    transports: string[] | null;
  };
  config: WebauthnConfig;
}): Promise<{ newCounter: number; backedUp: boolean }> {
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response: args.response,
      expectedChallenge: args.expectedChallenge,
      expectedOrigin: args.config.allowedOrigins,
      expectedRPID: args.config.rpID,
      credential: {
        id: args.storedCredential.credentialId,
        publicKey: isoBase64URL.toBuffer(args.storedCredential.publicKey),
        counter: args.storedCredential.signCount,
        ...(args.storedCredential.transports
          ? { transports: args.storedCredential.transports as never }
          : {}),
      },
      // 登録と同じく UV フラグを必須にしない（D-34-04）。
      requireUserVerification: false,
    });
  } catch {
    // 署名不正・challenge 不一致・origin / rpID 不一致・sign_count 後退はすべてここに来る。
    throw new ApiError('INVALID_CODE', 'パスキーの認証を検証できませんでした', 400);
  }

  if (result.verified !== true) {
    throw new ApiError('INVALID_CODE', 'パスキーの認証を検証できませんでした', 400);
  }

  return {
    newCounter: result.authenticationInfo.newCounter,
    backedUp: result.authenticationInfo.credentialBackedUp,
  };
}
