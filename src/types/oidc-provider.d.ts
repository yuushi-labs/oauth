declare module 'oidc-provider' {
  import type { IncomingMessage, ServerResponse } from 'node:http';

  export type OidcInteractionParams = Record<string, string | string[] | undefined>;

  export interface OidcInteractionDetails {
    uid?: string;
    params?: OidcInteractionParams;
    prompt?: { name: string };
    session?: { accountId?: string; grantId?: string };
    grantId?: string;
    iat?: number;
  }

  export interface ProviderClient {
    clientId: string;
    clientSecret?: string;
    compareClientSecret(actual: string): boolean | Promise<boolean>;
  }

  export interface OidcGrant {
    accountId?: string;
    clientId?: string;
    addOIDCScope(scope: string): void;
    getOIDCScope(): string;
    save(): Promise<string>;
  }

  export default class Provider {
    constructor(issuer: string, configuration: Record<string, unknown>);
    Client: {
      new (...args: unknown[]): ProviderClient;
      find(id: string): Promise<ProviderClient | undefined>;
      needsSecret(metadata: { token_endpoint_auth_method?: string }): boolean;
    };
    callback(): (request: IncomingMessage, response: ServerResponse) => void;
    on(event: string, listener: (ctx: unknown, error?: unknown) => void): void;
    interactionDetails(request: IncomingMessage, response: ServerResponse): Promise<OidcInteractionDetails>;
    interactionFinished(
      request: IncomingMessage,
      response: ServerResponse,
      result: Record<string, unknown>,
      options?: { mergeWithLastSubmission?: boolean },
    ): Promise<void>;
    Grant: {
      new (metadata: { accountId: string; clientId: string }): OidcGrant;
      find(id: string): Promise<OidcGrant | undefined>;
    };
  }

  export const interactionPolicy: {
    base(): {
      get(name: string): { checks: { add(check: object): void } };
    };
    Check: new (reason: string, description: string, check: (ctx: { req: IncomingMessage; oidc: { session: { accountId?: string } } }) => boolean | Promise<boolean>) => object;
  };
}