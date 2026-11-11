export type ThiepnAuthPolicy = 'guest-first' | 'required';

export type ThiepnIdentity =
  | { readonly status: 'signed-out' }
  | { readonly status: 'unavailable'; readonly code: string }
  | {
      readonly status: 'signed-in';
      readonly id: string;
      readonly email: string | null;
    };

export interface ThiepnAccountSessionOptions {
  readonly issuer: string;
  readonly publishableKey: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  readonly storageKey: string;
  readonly authPolicy: ThiepnAuthPolicy;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly localStorage?: Storage;
  readonly sessionStorage?: Storage;
  readonly crypto?: Crypto;
}

interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly scope: string;
}

interface PendingAuthorization {
  readonly state: string;
  readonly verifier: string;
  readonly startedAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

interface UserResponse {
  id: string;
  email?: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const DEFAULT_SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access',
] as const;
const PENDING_TTL_MS = 10 * 60 * 1000;
const TOKEN_SKEW_MS = 30 * 1000;

function secureOAuthTransport(url: URL): boolean {
  // OAuth bearer tokens and PKCE codes must never travel over HTTP except
  // when explicitly testing a client on the developer's own loopback host.
  return url.protocol === 'https:' || (
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  );
}

function exactOrigin(raw: string): string {
  const value = new URL(raw);
  if (
    !secureOAuthTransport(value) ||
    value.username ||
    value.password ||
    value.search ||
    value.hash ||
    value.pathname !== '/'
  ) {
    throw new TypeError('issuer must be an exact HTTPS origin (HTTP loopback only)');
  }
  return value.origin;
}

function exactRedirect(raw: string): string {
  const value = new URL(raw);
  if (
    !secureOAuthTransport(value) ||
    value.username ||
    value.password ||
    value.hash ||
    value.search
  ) {
    throw new TypeError(
      'redirectUri must be an HTTPS URL without query or fragment (HTTP loopback only)',
    );
  }
  return value.href;
}

function validClientId(value: string): string {
  if (!UUID_RE.test(value)) throw new TypeError('clientId must be a UUID');
  return value;
}

function validStorageKey(value: string): string {
  if (!/^[a-z0-9:._-]{8,160}$/i.test(value)) {
    throw new TypeError('storageKey is invalid');
  }
  return value;
}

function normalizedScopes(values: readonly string[] | undefined): string[] {
  const input = values ?? DEFAULT_SCOPES;
  const result = [
    ...new Set(input.map((value) => value.trim()).filter(Boolean)),
  ];
  if (
    result.length === 0 ||
    result.some((value) => !/^[a-z][a-z0-9._:-]{0,63}$/i.test(value))
  ) {
    throw new TypeError('scopes contain an invalid value');
  }
  return result.sort();
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomToken(cryptoImpl: Crypto, size = 32): string {
  return encodeBase64Url(cryptoImpl.getRandomValues(new Uint8Array(size)));
}

async function challengeFor(
  cryptoImpl: Crypto,
  verifier: string,
): Promise<string> {
  const digest = await cryptoImpl.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

function hasForbiddenOAuthValueCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127 || /\s/.test(character)) return true;
  }
  return false;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function tokenResponse(value: unknown): TokenResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ACCOUNT_TOKEN_RESPONSE_INVALID');
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.access_token !== 'string' ||
    row.access_token.length < 20 ||
    typeof row.refresh_token !== 'string' ||
    row.refresh_token.length < 8 ||
    row.refresh_token.length > 4096 ||
    !/^[A-Za-z0-9._~-]+$/.test(row.refresh_token) ||
    typeof row.expires_in !== 'number' ||
    !Number.isFinite(row.expires_in) ||
    row.expires_in <= 0 ||
    (typeof row.token_type !== 'string' || row.token_type.toLowerCase() !== 'bearer')
  ) {
    throw new Error('ACCOUNT_TOKEN_RESPONSE_INVALID');
  }
  return {
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expires_in: row.expires_in,
    token_type: row.token_type,
    ...(typeof row.scope === 'string' ? { scope: row.scope } : {}),
  };
}

function userResponse(value: unknown): UserResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ACCOUNT_IDENTITY_INVALID');
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !UUID_RE.test(row.id)) {
    throw new Error('ACCOUNT_IDENTITY_INVALID');
  }
  if (
    row.email !== undefined &&
    row.email !== null &&
    typeof row.email !== 'string'
  ) {
    throw new Error('ACCOUNT_IDENTITY_INVALID');
  }
  return {
    id: row.id,
    email: typeof row.email === 'string' ? row.email : null,
  };
}

export function readThiepnOAuthCallback(
  location: Pick<Location, 'href' | 'hash'>,
): { code: string; state: string } | { error: string; state: string } | null {
  const url = new URL(location.href);
  if (location.hash || url.hash) return null;
  const keys = [...url.searchParams.keys()];
  const state = url.searchParams.get('state');
  if (
    !state ||
    !STATE_RE.test(state) ||
    url.searchParams.getAll('state').length !== 1
  ) {
    return null;
  }

  if (url.searchParams.has('code')) {
    if (
      keys.some((key) => !['code', 'state'].includes(key)) ||
      url.searchParams.getAll('code').length !== 1
    )
      return null;
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096 || hasForbiddenOAuthValueCharacter(code))
      return null;
    return { code, state };
  }

  if (
    keys.some(
      (key) => !['error', 'error_description', 'state'].includes(key),
    ) ||
    url.searchParams.getAll('error').length !== 1
  )
    return null;
  const error = url.searchParams.get('error');
  if (!error || error.length > 256) return null;
  return { error, state };
}

export function createThiepnAccountSession(
  options: ThiepnAccountSessionOptions,
) {
  const issuer = exactOrigin(options.issuer);
  const redirectUri = exactRedirect(options.redirectUri);
  const clientId = validClientId(options.clientId);
  const storageKey = validStorageKey(options.storageKey);
  const scopes = normalizedScopes(options.scopes);
  const transport = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const local = options.localStorage ?? globalThis.localStorage;
  const session = options.sessionStorage ?? globalThis.sessionStorage;
  const cryptoImpl = options.crypto ?? globalThis.crypto;
  const timeoutMs = options.timeoutMs ?? 8000;
  const tokenKey = `${storageKey}:tokens`;
  const pendingKey = `${storageKey}:pending`;

  if (!options.publishableKey || options.publishableKey.length < 20) {
    throw new TypeError('publishableKey is invalid');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) {
    throw new TypeError('timeoutMs is invalid');
  }

  let current: ThiepnIdentity = { status: 'signed-out' };
  const listeners = new Set<(identity: ThiepnIdentity) => void>();
  let refreshFlight: Promise<StoredTokens | null> | null = null;
  let callbackFlight: Promise<ThiepnIdentity> | null = null;
  let signOutGeneration = 0;

  function publish(identity: ThiepnIdentity): ThiepnIdentity {
    current = identity;
    for (const listener of listeners) listener(identity);
    return identity;
  }

  function clearTokens(): void {
    local.removeItem(tokenKey);
  }

  function readTokens(): StoredTokens | null {
    const value = parseJson<Partial<StoredTokens>>(local.getItem(tokenKey));
    if (
      !value ||
      typeof value.accessToken !== 'string' ||
      typeof value.refreshToken !== 'string' ||
      typeof value.expiresAt !== 'number' ||
      !Number.isFinite(value.expiresAt) ||
      typeof value.scope !== 'string'
    )
      return null;
    return {
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      expiresAt: value.expiresAt,
      scope: value.scope,
    };
  }

  function writeTokens(value: TokenResponse): StoredTokens {
    const stored: StoredTokens = {
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresAt: now() + value.expires_in * 1000,
      scope: value.scope ?? '',
    };
    local.setItem(tokenKey, JSON.stringify(stored));
    return stored;
  }

  async function postToken(body: URLSearchParams): Promise<TokenResponse> {
    const response = await transport(new URL('/auth/v1/oauth/token', issuer), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const oauthError = payload && typeof payload === 'object' &&
        'error' in payload ? (payload as {error?:unknown}).error : null;
      if (
        response.status === 401 ||
        response.status === 403 ||
        (response.status === 400 && oauthError === 'invalid_grant')
      ) throw new Error('ACCOUNT_TOKEN_REVOKED');
      throw new Error('ACCOUNT_TOKEN_EXCHANGE_UNAVAILABLE');
    }
    return tokenResponse(payload);
  }

  async function refresh(tokens: StoredTokens): Promise<StoredTokens | null> {
    if (refreshFlight) return refreshFlight;

    const run = async (): Promise<StoredTokens | null> => {
      const perform = async (): Promise<StoredTokens | null> => {
        // Another tab may have rotated the refresh token while this tab waited.
        const currentTokens = readTokens();
        if (!currentTokens) return null;
        if (currentTokens.refreshToken !== tokens.refreshToken) return currentTokens;
        if (currentTokens.expiresAt - TOKEN_SKEW_MS > now()) return currentTokens;

        try {
          const refreshed = await postToken(
            new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: currentTokens.refreshToken,
              client_id: clientId,
            }),
          );
          // A user may sign out or switch identities during an in-flight fetch.
          // Never resurrect credentials or overwrite newer tokens afterward.
          const latest = readTokens();
          if (!latest) return null;
          if (latest.refreshToken !== currentTokens.refreshToken) return latest;
          return writeTokens(refreshed);
        } catch (error) {
          const latest = readTokens();
          if (!latest || latest.refreshToken !== currentTokens.refreshToken) return latest;
          if (error instanceof Error && error.message === 'ACCOUNT_TOKEN_REVOKED') {
            clearTokens();
            return null;
          }
          // An outage is not an authentication failure; retry later.
          throw new Error('ACCOUNT_REFRESH_UNAVAILABLE');
        }
      };
      const locks = globalThis.navigator?.locks;
      return locks
        ? locks.request(`${storageKey}:oauth-refresh`, perform)
        : perform();
    };

    const promise = run();
    refreshFlight = promise;
    void promise.then(
      () => { if (refreshFlight === promise) refreshFlight = null; },
      () => { if (refreshFlight === promise) refreshFlight = null; },
    );
    return promise;
  }

  async function usableTokens(): Promise<StoredTokens | null> {
    const stored = readTokens();
    if (!stored) return null;
    if (stored.expiresAt - TOKEN_SKEW_MS > now()) return stored;
    return refresh(stored);
  }

  async function verify(): Promise<ThiepnIdentity> {
    let tokens: StoredTokens | null;
    try {
      tokens = await usableTokens();
    } catch {
      return publish({ status: 'unavailable', code: 'ACCOUNT_REFRESH_UNAVAILABLE' });
    }
    if (!tokens) return publish({ status: 'signed-out' });
    try {
      const response = await transport(new URL('/auth/v1/user', issuer), {
        headers: {
          Accept: 'application/json',
          apikey: options.publishableKey,
          Authorization: `Bearer ${tokens.accessToken}`,
        },
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401 || response.status === 403) {
        // Another tab may have rotated/replaced the stored app session while
        // our identity request was in flight. Never revoke the newer login.
        const latest = readTokens();
        if (latest && latest.accessToken !== tokens.accessToken) {
          return publish({ status: 'unavailable', code: 'ACCOUNT_SESSION_CHANGED' });
        }
        clearTokens();
        return publish({ status: 'signed-out' });
      }
      if (!response.ok)
        return publish({
          status: 'unavailable',
          code: 'ACCOUNT_VERIFY_UNAVAILABLE',
        });
      const user = userResponse(await response.json());
      const latest = readTokens();
      if (!latest) return publish({ status: 'signed-out' });
      if (latest.accessToken !== tokens.accessToken) {
        return publish({ status: 'unavailable', code: 'ACCOUNT_SESSION_CHANGED' });
      }
      return publish({
        status: 'signed-in',
        id: user.id,
        email: user.email ?? null,
      });
    } catch {
      return publish({
        status: 'unavailable',
        code: 'ACCOUNT_VERIFY_UNAVAILABLE',
      });
    }
  }

  async function authorizationUrl(): Promise<string> {
    const verifier = randomToken(cryptoImpl);
    if (!VERIFIER_RE.test(verifier)) throw new Error('ACCOUNT_PKCE_INVALID');
    const state = randomToken(cryptoImpl);
    const challenge = await challengeFor(cryptoImpl, verifier);
    const pending: PendingAuthorization = { state, verifier, startedAt: now() };
    session.setItem(pendingKey, JSON.stringify(pending));

    const url = new URL('/auth/v1/oauth/authorize', issuer);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.href;
  }

  function completeCallback(
    location: Pick<Location, 'href' | 'hash'>,
  ): Promise<ThiepnIdentity> {
    if (callbackFlight) return callbackFlight;

    const run = async (): Promise<ThiepnIdentity> => {
      const actual = new URL(location.href);
      const expected = new URL(redirectUri);
      if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
        return publish({ status: 'unavailable', code: 'ACCOUNT_CALLBACK_INVALID' });
      }
      const callback = readThiepnOAuthCallback(location);
      const pending = parseJson<Partial<PendingAuthorization>>(
        session.getItem(pendingKey),
      );
      session.removeItem(pendingKey);

      if (
        !callback ||
        !pending ||
        typeof pending.state !== 'string' ||
        pending.state !== callback.state ||
        typeof pending.verifier !== 'string' ||
        !VERIFIER_RE.test(pending.verifier) ||
        typeof pending.startedAt !== 'number' ||
        now() < pending.startedAt ||
        now() - pending.startedAt > PENDING_TTL_MS
      ) {
        return publish({
          status: 'unavailable',
          code: 'ACCOUNT_CALLBACK_INVALID',
        });
      }

      if ('error' in callback) {
        // A cancelled new connection is not proof that an existing
        // independently verified local session has been revoked.
        return publish({ status: 'unavailable', code: 'ACCOUNT_AUTHORIZATION_CANCELLED' });
      }

      const initialTokens = readTokens();
      const generation = signOutGeneration;
      let exchanged: TokenResponse;
      try {
        exchanged = await postToken(
          new URLSearchParams({
            grant_type: 'authorization_code',
            code: callback.code,
            client_id: clientId,
            redirect_uri: redirectUri,
            code_verifier: pending.verifier,
          }),
        );
      } catch {
        // An invalid/expired code or temporary outage must not log out a
        // previously verified session. The one-use PKCE request is consumed.
        return publish({
          status: 'unavailable',
          code: 'ACCOUNT_CODE_EXCHANGE_FAILED',
        });
      }

      // The user may have signed out or another tab may have authenticated a
      // different identity while the one-use code was being exchanged.
      if (signOutGeneration !== generation) {
        return publish({ status: 'signed-out' });
      }
      const latest = readTokens();
      if (
        (latest?.refreshToken ?? null) !== (initialTokens?.refreshToken ?? null)
      ) {
        return publish({ status: 'unavailable', code: 'ACCOUNT_SESSION_CHANGED' });
      }
      writeTokens(exchanged);
      return verify();
    };

    const promise = run();
    callbackFlight = promise;
    const release = () => {
      if (callbackFlight === promise) callbackFlight = null;
    };
    void promise.then(release, release);
    return promise;
  }

  async function accessToken(): Promise<string | null> {
    const tokens = await usableTokens();
    return tokens?.accessToken ?? null;
  }

  function signOutLocal(): ThiepnIdentity {
    ++signOutGeneration;
    clearTokens();
    session.removeItem(pendingKey);
    return publish({ status: 'signed-out' });
  }

  return Object.freeze({
    issuer,
    clientId,
    redirectUri,
    authPolicy: options.authPolicy,
    identity: () => current,
    verify,
    authorizationUrl,
    completeCallback,
    getAccessToken: accessToken,
    signOutLocal,
    subscribe(listener: (identity: ThiepnIdentity) => void) {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
  });
}

export type ThiepnAccountSession = ReturnType<
  typeof createThiepnAccountSession
>;

export { createThiepnBrowserSso, probeThiepnAccount, readThiepnAccountProbeMessage } from './browser-sso.js';
export type { ThiepnBrowserSso, ThiepnBrowserSsoOptions, ThiepnBrowserSsoStatus, ThiepnAccountProbe } from './browser-sso.js';
