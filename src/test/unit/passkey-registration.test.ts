import { describe, expect, it } from 'vitest';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import { generatePasskeyRegistrationOptions, verifyPasskeyRegistration } from '@/lib/auth/passkey/registration';
import { createMockAuthenticator } from '@/test/helpers/webauthn-mock';

const ORIGIN = 'http://localhost:3000';
const config = { rpID: 'localhost', rpName: 'Auth System Test', allowedOrigins: [ORIGIN] };

describe('passkey registration options (P6-A-06)', () => {
  it('rp.id / rp.name を config から設定する', async () => {
    const options = await generatePasskeyRegistrationOptions({
      user: { id: 'usr_00000000000000000000000000', username: 'alice' },
      existingCredentialIds: [],
      config,
    });
    expect(options.rp.id).toBe('localhost');
    expect(options.rp.name).toBe('Auth System Test');
    expect(options.challenge.length).toBeGreaterThanOrEqual(22);
  });

  it('user.id は user.id の bytes で固定される（2 回呼んでも同じ・R4）', async () => {
    const userId = 'usr_01J0000000000000000000000A';
    const first = await generatePasskeyRegistrationOptions({
      user: { id: userId, username: 'alice' },
      existingCredentialIds: [],
      config,
    });
    const second = await generatePasskeyRegistrationOptions({
      user: { id: userId, username: 'alice' },
      existingCredentialIds: [],
      config,
    });
    const expected = isoBase64URL.fromBuffer(isoUint8Array.fromUTF8String(userId));
    expect(first.user.id).toBe(expected);
    expect(second.user.id).toBe(expected);
    expect(first.user.name).toBe('alice');
  });

  it('excludeCredentials に既存 credential を入れる', async () => {
    const options = await generatePasskeyRegistrationOptions({
      user: { id: 'usr_x', username: 'alice' },
      existingCredentialIds: ['cred-one', 'cred-two'],
      config,
    });
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual(['cred-one', 'cred-two']);
  });

  it('authenticatorSelection は residentKey/userVerification=preferred', async () => {
    const options = await generatePasskeyRegistrationOptions({
      user: { id: 'usr_x', username: 'alice' },
      existingCredentialIds: [],
      config,
    });
    expect(options.authenticatorSelection?.residentKey).toBe('preferred');
    expect(options.authenticatorSelection?.userVerification).toBe('preferred');
  });

  it('attestation は none', async () => {
    const options = await generatePasskeyRegistrationOptions({
      user: { id: 'usr_x', username: 'alice' },
      existingCredentialIds: [],
      config,
    });
    expect(options.attestation).toBe('none');
  });
});

describe('verifyPasskeyRegistration (P6-A-06)', () => {
  it('実鍵の登録応答を検証し、base64url の公開鍵と戻り値を返す', async () => {
    const auth = createMockAuthenticator({ rpID: config.rpID, origin: ORIGIN });
    const options = await generatePasskeyRegistrationOptions({
      user: { id: 'usr_x', username: 'alice' },
      existingCredentialIds: [],
      config,
    });
    const response = auth.createRegistrationResponse({ challenge: options.challenge, signCount: 0, backedUp: true });

    const verified = await verifyPasskeyRegistration({
      response,
      expectedChallenge: options.challenge,
      config,
    });

    expect(verified.credentialId).toBe(auth.credentialId);
    expect(verified.publicKey).toBe(auth.publicKey);
    expect(verified.signCount).toBe(0);
    expect(verified.transports).toEqual(['internal', 'hybrid']);
    expect(verified.aaguid).toBe('00000000-0000-0000-0000-000000000000');
    expect(verified.backedUp).toBe(true);
  });

  it('許可外 origin の応答は ApiError(INVALID_CODE) に丸める', async () => {
    const auth = createMockAuthenticator({ rpID: config.rpID, origin: ORIGIN });
    const response = auth.createRegistrationResponse({ challenge: 'chal', origin: 'https://evil.example' });
    await expect(
      verifyPasskeyRegistration({ response, expectedChallenge: 'chal', config }),
    ).rejects.toMatchObject({ code: 'INVALID_CODE', status: 400 });
  });
});
