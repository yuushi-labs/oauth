import { describe, expect, it } from 'vitest';
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { createMockAuthenticator } from '@/test/helpers/webauthn-mock';

/**
 * §11.4 / P6-A-07: mock が作った応答が**実ライブラリの検証を通る**ことを固定する。
 * ここが green にならないと、以降の実 HTTP テストは書けない。
 */

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const CHALLENGE = isoBase64URL.fromBuffer(new Uint8Array(32).fill(7));

describe('webauthn-mock (P6-A-07)', () => {
  it('登録応答が verifyRegistrationResponse を通る', async () => {
    const auth = createMockAuthenticator({ rpID: RP_ID, origin: ORIGIN });
    const response = auth.createRegistrationResponse({ challenge: CHALLENGE });

    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false,
    });

    expect(result.verified).toBe(true);
    expect(result.registrationInfo?.credential.id).toBe(auth.credentialId);
    expect(result.registrationInfo?.aaguid).toBe('00000000-0000-0000-0000-000000000000');
    expect(isoBase64URL.fromBuffer(result.registrationInfo!.credential.publicKey)).toBe(auth.publicKey);
    // 登録の戻り値は excludeCredentials にそのまま渡せる形（base64url）。
    expect(auth.credentialId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('認証応答が verifyAuthenticationResponse を通る', async () => {
    const auth = createMockAuthenticator({ rpID: RP_ID, origin: ORIGIN });
    const response = auth.createAuthenticationResponse({ challenge: CHALLENGE, signCount: 5 });

    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: auth.credentialId,
        publicKey: isoBase64URL.toBuffer(auth.publicKey),
        counter: 0,
      },
      requireUserVerification: false,
    });

    expect(result.verified).toBe(true);
    expect(result.authenticationInfo.newCounter).toBe(5);
  });

  it('origin を外すと登録・認証とも throw する', async () => {
    const auth = createMockAuthenticator({ rpID: RP_ID, origin: ORIGIN });
    const registration = auth.createRegistrationResponse({ challenge: CHALLENGE, origin: 'https://evil.example' });
    await expect(
      verifyRegistrationResponse({
        response: registration,
        expectedChallenge: CHALLENGE,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false,
      }),
    ).rejects.toThrow();

    const authentication = auth.createAuthenticationResponse({ challenge: CHALLENGE, origin: 'https://evil.example' });
    await expect(
      verifyAuthenticationResponse({
        response: authentication,
        expectedChallenge: CHALLENGE,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: { id: auth.credentialId, publicKey: isoBase64URL.toBuffer(auth.publicKey), counter: 0 },
        requireUserVerification: false,
      }),
    ).rejects.toThrow();
  });

  it('rpID を外すと登録・認証とも throw する', async () => {
    const auth = createMockAuthenticator({ rpID: RP_ID, origin: ORIGIN });
    const registration = auth.createRegistrationResponse({ challenge: CHALLENGE, rpID: 'evil.example' });
    await expect(
      verifyRegistrationResponse({
        response: registration,
        expectedChallenge: CHALLENGE,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false,
      }),
    ).rejects.toThrow();

    const authentication = auth.createAuthenticationResponse({ challenge: CHALLENGE, rpID: 'evil.example' });
    await expect(
      verifyAuthenticationResponse({
        response: authentication,
        expectedChallenge: CHALLENGE,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: { id: auth.credentialId, publicKey: isoBase64URL.toBuffer(auth.publicKey), counter: 0 },
        requireUserVerification: false,
      }),
    ).rejects.toThrow();
  });

  it('challenge を外すと throw する', async () => {
    const auth = createMockAuthenticator({ rpID: RP_ID, origin: ORIGIN });
    const response = auth.createAuthenticationResponse({ challenge: isoBase64URL.fromBuffer(new Uint8Array(32).fill(9)) });
    await expect(
      verifyAuthenticationResponse({
        response,
        expectedChallenge: CHALLENGE,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: { id: auth.credentialId, publicKey: isoBase64URL.toBuffer(auth.publicKey), counter: 0 },
        requireUserVerification: false,
      }),
    ).rejects.toThrow();
  });

  it('sign_count 後退は throw する', async () => {
    const auth = createMockAuthenticator({ rpID: RP_ID, origin: ORIGIN });
    const response = auth.createAuthenticationResponse({ challenge: CHALLENGE, signCount: 3 });
    await expect(
      verifyAuthenticationResponse({
        response,
        expectedChallenge: CHALLENGE,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: { id: auth.credentialId, publicKey: isoBase64URL.toBuffer(auth.publicKey), counter: 5 },
        requireUserVerification: false,
      }),
    ).rejects.toThrow();
  });

  it('別の鍵で署名すると verified=false になる（署名不正の再現）', async () => {
    const auth = createMockAuthenticator({ rpID: RP_ID, origin: ORIGIN });
    const other = createMockAuthenticator({ rpID: RP_ID, origin: ORIGIN });
    const response = auth.createAuthenticationResponse({ challenge: CHALLENGE, signWith: other });
    // 署名不一致は throw ではなく `{ verified: false }` で返る（ラッパが ApiError に丸める）。
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: { id: auth.credentialId, publicKey: isoBase64URL.toBuffer(auth.publicKey), counter: 0 },
      requireUserVerification: false,
    });
    expect(result.verified).toBe(false);
  });
});
