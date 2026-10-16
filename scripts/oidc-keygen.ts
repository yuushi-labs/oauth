import 'dotenv/config';
import { createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const jwk = createPrivateKey(privateKey).export({ format: 'jwk' }) as Record<string, string>;
jwk.kid = randomBytes(12).toString('hex');
jwk.use = 'sig';
jwk.alg = 'RS256';
process.stdout.write(`OIDC_ADAPTER_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`);
process.stdout.write(`OIDC_JWKS_JSON=${JSON.stringify({ keys: [jwk] })}\n`);
process.stdout.write('Store these values in a secret manager. Keep a protected copy of the old public JWK when rotating signing keys.\n');
process.stdout.write('Write OIDC_JWKS_JSON into .env without surrounding quotes.\n');

