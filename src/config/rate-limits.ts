export const RATE_LIMITS = {
  register: { window: 3600_000, limit: 5 },
  login: {
    ip: { window: 300_000, limit: 20 },
    account: { window: 900_000, limit: 5 },
    ipAccount: { window: 900_000, limit: 5 },
  },
  forgot: {
    email: { window: 3600_000, limit: 5 },
    ip: { window: 3600_000, limit: 10 },
  },
  resend: {
    user: { window: 3600_000, limit: 5 },
    ip: { window: 3600_000, limit: 10 },
  },
} as const;