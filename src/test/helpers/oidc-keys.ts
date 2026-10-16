import { createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';

export type TestOidcKeys = {
  jwks: string;
  adapterKey: string;
  kid: string;
};

export function generateTestOidcKeys(modulusLength = 2048): TestOidcKeys {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const jwk = createPrivateKey(privateKey).export({ format: 'jwk' }) as Record<string, string>;
  const kid = randomBytes(12).toString('hex');
  jwk.kid = kid;
  jwk.use = 'sig';
  jwk.alg = 'RS256';
  return {
    jwks: JSON.stringify({ keys: [jwk] }),
    adapterKey: randomBytes(32).toString('base64'),
    kid,
  };
}