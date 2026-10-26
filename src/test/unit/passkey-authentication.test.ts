import { describe, expect, it } from 'vitest';
import {
  generatePasskeyAuthenticationOptions,
  verifyPasskeyAuthentication,
} from '@/lib/auth/passkey/authentication';
import { createMockAuthenticator } from '@/test/helpers/webauthn-mock';

const ORIGIN = 'http://localhost:3000';
const config = { rpID: 'localhost', rpName: 'Auth System Test', allowedOrigins: [ORIGIN] };

describe('passkey authentication options (P6-A-06)', () => {
  it('credential を渡さないと allowCredentials が空（discoverable）', async () => {
    const options = await generatePasskeyAuthenticationOptions({ config });
    expect(options.allowCredentials).toEqual([]);
    expect(options.rpId).toBe('localhost');
  });

  it('credential を渡すと { id, transports } が入る', async () => {
    const options = await generatePasskeyAuthenticationOptions({
      credentials: [{ credentialId: 'cred-1', transports: ['internal', 'hybrid'] }],
      config,
    });
    expect(options.allowCredentials).toEqual([
      { id: 'cred-1', transports: ['internal', 'hybrid'], type: 'public-key' },
    ]);
  });

  it('transports が null の credential は transports を付けない', async () => {
    const options = await generatePasskeyAuthenticationOptions({
      credentials: [{ credentialId: 'cred-1', transports: null }],
      config,
    });
    expect(options.allowCredentials).toEqual([{ id: 'cred-1', type: 'public-key' }]);
  });

  it('userVerification は preferred', async () => {
    const options = await generatePasskeyAuthenticationOptions({ config });
    expect(options.userVerification).toBe('preferred');
  });
});

describe('verifyPasskeyAuthentication (P6-A-06)', () => {
  it('実鍵の認証応答を検証し、newCounter を返す', async () => {
    const auth = createMockAuthenticator({ rpID: config.rpID, origin: ORIGIN });
    const response = auth.createAuthenticationResponse({ challenge: 'chal', signCount: 7 });
    const result = await verifyPasskeyAuthentication({
      response,
      expectedChallenge: 'chal',
      storedCredential: { credentialId: auth.credentialId, publicKey: auth.publicKey, signCount: 0, transports: null },
      config,
    });
    expect(result.newCounter).toBe(7);
  });

  it('sign_count 後退は ApiError(INVALID_CODE) に丸める', async () => {
    const auth = createMockAuthenticator({ rpID: config.rpID, origin: ORIGIN });
    const response = auth.createAuthenticationResponse({ challenge: 'chal', signCount: 3 });
    await expect(
      verifyPasskeyAuthentication({
        response,
        expectedChallenge: 'chal',
        storedCredential: { credentialId: auth.credentialId, publicKey: auth.publicKey, signCount: 5, transports: null },
        config,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CODE', status: 400 });
  });

  it('別の鍵の署名は ApiError(INVALID_CODE) に丸める', async () => {
    const auth = createMockAuthenticator({ rpID: config.rpID, origin: ORIGIN });
    const other = createMockAuthenticator({ rpID: config.rpID, origin: ORIGIN });
    const response = auth.createAuthenticationResponse({ challenge: 'chal', signWith: other });
    await expect(
      verifyPasskeyAuthentication({
        response,
        expectedChallenge: 'chal',
        storedCredential: { credentialId: auth.credentialId, publicKey: auth.publicKey, signCount: 0, transports: null },
        config,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CODE', status: 400 });
  });
});
