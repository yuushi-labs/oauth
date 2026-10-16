/** Fixed-window limits from implementation plan §8.6 / Phase 2 design §6.2. */
export const RATE_LIMITS = {
  register: { window: 3_600_000, limit: 5, softLimit: 4 },
  login: {
    ip: { window: 300_000, limit: 20, softLimit: 5 },
    account: { window: 900_000, limit: 5, softLimit: 3 },
    ipAccount: { window: 900_000, limit: 5, softLimit: 3 },
  },
  forgot: {
    email: { window: 3_600_000, limit: 5, softLimit: 2 },
    ip: { window: 3_600_000, limit: 10, softLimit: 5 },
  },
  resend: {
    user: { window: 3_600_000, limit: 5, softLimit: 4 },
    ip: { window: 3_600_000, limit: 10, softLimit: 5 },
  },
  oauth: {
    start: { window: 600_000, limit: 10, softLimit: 5 },
    callback: { window: 600_000, limit: 20, softLimit: 10 },
  },
  twoFactor: { window: 300_000, limit: 10, softLimit: 3 },
  passkey: { window: 300_000, limit: 30, softLimit: 10 },
  settings: { window: 60_000, limit: 120, softLimit: 60 },
  oidc: {
    authorize: { window: 600_000, limit: 30 },
    interaction: { window: 600_000, limit: 60 },
    token: { window: 60_000, limit: 30 },
    userinfo: { window: 60_000, limit: 90 },
    revoke: { window: 60_000, limit: 10 },
  },
} as const;
