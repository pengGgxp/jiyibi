import { createRemoteJWKSet, jwtVerify } from "jose";
import { ApiError } from "./errors";
import type { AuthenticatedUser, CloudSyncState, Env } from "./types";

const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export const GITHUB_OAUTH_CALLBACK_PATH = "/api/callback";
export const GITHUB_OAUTH_NONCE_COOKIE = "__Host-jiyibi-oauth-nonce";
export const GITHUB_SESSION_COOKIE = "__Host-jiyibi-session";

const GITHUB_ISSUER = "https://github.com";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  allowedUserId: string;
}

interface OAuthStateRow {
  return_to: string;
}

interface AuthSessionRow {
  user_id: string;
  github_user_id: string;
  email: string;
}

interface GitHubTokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  error?: unknown;
}

interface GitHubUserResponse {
  id?: unknown;
  login?: unknown;
  email?: unknown;
}

export interface GitHubOAuthStart {
  authorizationUrl: string;
  nonceCookie: string;
}

export interface GitHubOAuthCompletion {
  returnTo: string;
  sessionCookie: string;
}

type OAuthFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function normalizeTeamDomain(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new ApiError(500, "auth_not_configured", "Authentication is not configured");
  }
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new ApiError(500, "auth_not_configured", "Authentication is not configured");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") {
    throw new ApiError(500, "auth_not_configured", "Authentication is not configured");
  }
  return url.origin;
}

function validEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 320 &&
    /^[^\s@]+@[^\s@]+$/.test(value)
  );
}

function githubAllowedUserId(env: Env): string | undefined {
  const value = env.GITHUB_ALLOWED_USER_ID?.trim();
  if (!value) return undefined;
  if (
    !/^[1-9]\d{0,15}$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new ApiError(500, "auth_not_configured", "Authentication is not configured");
  }
  return value;
}

function githubOAuthConfig(env: Env): GitHubOAuthConfig {
  const clientId = env.GITHUB_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim() ?? "";
  const allowedUserId = githubAllowedUserId(env);
  if (!clientId || !clientSecret || !allowedUserId) {
    throw new ApiError(500, "auth_not_configured", "Authentication is not configured");
  }
  return { clientId, clientSecret, allowedUserId };
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function secureCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearGitHubOAuthNonceCookie(): string {
  return secureCookie(GITHUB_OAUTH_NONCE_COOKIE, "", 0);
}

export function clearGitHubSessionCookie(): string {
  return secureCookie(GITHUB_SESSION_COOKIE, "", 0);
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function callbackUrl(request: Request): string {
  return new URL(GITHUB_OAUTH_CALLBACK_PATH, new URL(request.url).origin).toString();
}

export async function beginGitHubOAuth(
  request: Request,
  env: Env,
  returnTo: string,
): Promise<GitHubOAuthStart> {
  const config = githubOAuthConfig(env);
  const state = randomToken();
  const nonce = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_SECONDS * 1000);

  await env.DB
    .prepare("DELETE FROM oauth_states WHERE expires_at <= ?")
    .bind(now.toISOString())
    .run();
  await env.DB
    .prepare(
      `INSERT INTO oauth_states (
         state_hash, nonce_hash, return_to, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      await sha256Hex(state),
      await sha256Hex(nonce),
      returnTo,
      now.toISOString(),
      expiresAt.toISOString(),
    )
    .run();

  const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
  authorizationUrl.searchParams.set("client_id", config.clientId);
  authorizationUrl.searchParams.set("redirect_uri", callbackUrl(request));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("allow_signup", "false");
  return {
    authorizationUrl: authorizationUrl.toString(),
    nonceCookie: secureCookie(GITHUB_OAUTH_NONCE_COOKIE, nonce, OAUTH_STATE_TTL_SECONDS),
  };
}

async function consumeOAuthState(
  request: Request,
  env: Env,
): Promise<string> {
  const requestUrl = new URL(request.url);
  const state = requestUrl.searchParams.get("state") ?? "";
  const nonce = cookieValue(request, GITHUB_OAUTH_NONCE_COOKIE) ?? "";
  if (!TOKEN_PATTERN.test(state) || !TOKEN_PATTERN.test(nonce)) {
    throw new ApiError(400, "invalid_oauth_state", "OAuth state is invalid or expired");
  }
  const row = await env.DB
    .prepare(
      `DELETE FROM oauth_states
       WHERE state_hash = ? AND nonce_hash = ? AND expires_at > ?
       RETURNING return_to`,
    )
    .bind(
      await sha256Hex(state),
      await sha256Hex(nonce),
      new Date().toISOString(),
    )
    .first<OAuthStateRow>();
  if (!row || row.return_to.length > 2048) {
    throw new ApiError(400, "invalid_oauth_state", "OAuth state is invalid or expired");
  }
  const origin = new URL(request.url).origin;
  let returnUrl: URL;
  try {
    returnUrl = new URL(row.return_to, origin);
  } catch {
    throw new ApiError(400, "invalid_oauth_state", "OAuth state is invalid or expired");
  }
  if (
    returnUrl.origin !== origin ||
    returnUrl.pathname === "/api" ||
    returnUrl.pathname.startsWith("/api/")
  ) {
    throw new ApiError(400, "invalid_oauth_state", "OAuth state is invalid or expired");
  }
  return `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ApiError(502, "github_oauth_failed", "GitHub authentication failed");
  }
}

async function exchangeGitHubCode(
  code: string,
  redirectUri: string,
  config: GitHubOAuthConfig,
  fetcher: OAuthFetch,
): Promise<string> {
  const response = await fetcher("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "User-Agent": "jiyibi",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });
  const payload = await responseJson(response) as GitHubTokenResponse;
  if (
    !response.ok ||
    payload.error !== undefined ||
    typeof payload.access_token !== "string" ||
    payload.access_token.length < 1 ||
    payload.access_token.length > 1024 ||
    (payload.token_type !== undefined && payload.token_type !== "bearer")
  ) {
    throw new ApiError(502, "github_oauth_failed", "GitHub authentication failed");
  }
  return payload.access_token;
}

async function fetchGitHubUser(
  accessToken: string,
  fetcher: OAuthFetch,
): Promise<GitHubUserResponse> {
  const response = await fetcher("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "jiyibi",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const payload = await responseJson(response);
  if (!response.ok || typeof payload !== "object" || payload === null) {
    throw new ApiError(502, "github_oauth_failed", "GitHub authentication failed");
  }
  return payload as GitHubUserResponse;
}

function githubEmail(profile: GitHubUserResponse, githubUserId: string): string {
  if (validEmail(profile.email)) return profile.email.trim().toLowerCase();
  const login = typeof profile.login === "string" ? profile.login.trim().toLowerCase() : "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(login)) {
    throw new ApiError(502, "github_oauth_failed", "GitHub authentication failed");
  }
  return `${githubUserId}+${login}@users.noreply.github.com`;
}

export async function completeGitHubOAuth(
  request: Request,
  env: Env,
  fetcher: OAuthFetch = fetch,
): Promise<GitHubOAuthCompletion> {
  const config = githubOAuthConfig(env);
  const returnTo = await consumeOAuthState(request, env);
  const requestUrl = new URL(request.url);
  if (requestUrl.searchParams.has("error")) {
    throw new ApiError(400, "github_oauth_denied", "GitHub authentication was cancelled");
  }
  const code = requestUrl.searchParams.get("code") ?? "";
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(code)) {
    throw new ApiError(400, "invalid_oauth_code", "OAuth code is invalid");
  }

  const accessToken = await exchangeGitHubCode(
    code,
    callbackUrl(request),
    config,
    fetcher,
  );
  const profile = await fetchGitHubUser(accessToken, fetcher);
  if (!Number.isSafeInteger(profile.id) || Number(profile.id) < 1) {
    throw new ApiError(502, "github_oauth_failed", "GitHub authentication failed");
  }
  const githubUserId = String(profile.id);
  if (githubUserId !== config.allowedUserId) {
    throw new ApiError(403, "github_account_not_allowed", "This GitHub account is not allowed");
  }

  const email = githubEmail(profile, githubUserId);
  const userId = await stableUserId(GITHUB_ISSUER, githubUserId);
  const sessionToken = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  await env.DB
    .prepare("DELETE FROM auth_sessions WHERE expires_at <= ?")
    .bind(now.toISOString())
    .run();
  await env.DB
    .prepare(
      `INSERT INTO auth_sessions (
         token_hash, user_id, github_user_id, email, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      await sha256Hex(sessionToken),
      userId,
      githubUserId,
      email,
      now.toISOString(),
      expiresAt.toISOString(),
    )
    .run();

  return {
    returnTo,
    sessionCookie: secureCookie(GITHUB_SESSION_COOKIE, sessionToken, SESSION_TTL_SECONDS),
  };
}

async function authenticateGitHubSession(
  request: Request,
  env: Env,
): Promise<AuthenticatedUser | undefined> {
  const token = cookieValue(request, GITHUB_SESSION_COOKIE);
  if (!token || !TOKEN_PATTERN.test(token)) return undefined;
  const allowedUserId = githubAllowedUserId(env);
  if (!allowedUserId) {
    if (env.ENVIRONMENT === "production") {
      throw new ApiError(500, "auth_not_configured", "Authentication is not configured");
    }
    return undefined;
  }
  const row = await env.DB
    .prepare(
      `SELECT user_id, github_user_id, email
       FROM auth_sessions
       WHERE token_hash = ? AND github_user_id = ? AND expires_at > ?`,
    )
    .bind(await sha256Hex(token), allowedUserId, new Date().toISOString())
    .first<AuthSessionRow>();
  if (
    !row ||
    !/^usr_[a-f0-9]{64}$/.test(row.user_id) ||
    !validEmail(row.email) ||
    row.github_user_id !== allowedUserId
  ) {
    return undefined;
  }
  return {
    id: row.user_id,
    email: row.email.trim().toLowerCase(),
    issuer: GITHUB_ISSUER,
    subject: row.github_user_id,
  };
}

export async function revokeGitHubSession(request: Request, env: Env): Promise<void> {
  const token = cookieValue(request, GITHUB_SESSION_COOKIE);
  if (!token || !TOKEN_PATTERN.test(token)) return;
  await env.DB
    .prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .run();
}

async function stableUserId(issuer: string, subject: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([issuer, subject]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `usr_${hex}`;
}

function getJwks(url: URL): ReturnType<typeof createRemoteJWKSet> {
  const key = url.toString();
  const existing = jwksByUrl.get(key);
  if (existing) return existing;
  const created = createRemoteJWKSet(url);
  jwksByUrl.set(key, created);
  return created;
}

export async function authenticate(request: Request, env: Env): Promise<AuthenticatedUser> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (!assertion) {
    const githubUser = await authenticateGitHubSession(request, env);
    if (githubUser) return githubUser;
    if (env.ENVIRONMENT === "development" && env.LOCAL_AUTH_EMAIL) {
      const email = env.LOCAL_AUTH_EMAIL.trim().toLowerCase();
      if (!validEmail(email)) {
        throw new ApiError(500, "auth_not_configured", "Local authentication is not configured");
      }
      const issuer = "development";
      return {
        id: await stableUserId(issuer, email),
        email,
        issuer,
        subject: email,
      };
    }
    throw new ApiError(401, "authentication_required", "Authentication required");
  }

  const issuer = normalizeTeamDomain(env.TEAM_DOMAIN);
  const audience = env.POLICY_AUD?.trim();
  if (!audience) {
    throw new ApiError(500, "auth_not_configured", "Authentication is not configured");
  }
  try {
    const { payload } = await jwtVerify(
      assertion,
      getJwks(new URL("/cdn-cgi/access/certs", issuer)),
      { algorithms: ["RS256"], audience, issuer },
    );
    if (typeof payload.sub !== "string" || !payload.sub || !validEmail(payload.email)) {
      throw new ApiError(401, "invalid_identity", "Access identity is incomplete");
    }
    const email = payload.email.trim().toLowerCase();
    return {
      id: await stableUserId(issuer, payload.sub),
      email,
      issuer,
      subject: payload.sub,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "invalid_access_token", "Access token is invalid or expired");
  }
}

interface EnsureUserOptions {
  allowSyncDisabled?: boolean;
  allowDeletionInProgress?: boolean;
}

interface UserDeletionState {
  deletion_started_at: string | null;
}

interface CloudSyncStateRow {
  status: CloudSyncState["status"];
  generation: number;
  last_deleted_generation: number | null;
}

const MAX_GENERATION = 9_000_000_000_000_000;

function cloudSyncState(row: CloudSyncStateRow): CloudSyncState {
  return {
    status: row.status,
    generation: row.generation,
    lastDeletedGeneration: row.last_deleted_generation,
  };
}

function staleCloudGeneration(): ApiError {
  return new ApiError(
    409,
    "stale_cloud_generation",
    "Cloud sync state changed; refresh the session and confirm again",
  );
}

async function getOrCreateCloudSyncState(
  db: D1Database,
  userId: string,
): Promise<CloudSyncState> {
  const now = new Date().toISOString();
  const state = await db
    .prepare(
      `INSERT INTO cloud_sync_state (
         user_id, status, generation, last_deleted_generation, updated_at
       ) VALUES (?, 'disabled', 0, NULL, ?)
       ON CONFLICT(user_id) DO UPDATE SET status = cloud_sync_state.status
       RETURNING status, generation, last_deleted_generation`,
    )
    .bind(userId, now)
    .first<CloudSyncStateRow>();
  if (!state) throw new Error("Cloud sync state upsert returned no row");
  return cloudSyncState(state);
}

async function upsertUser(
  db: D1Database,
  user: AuthenticatedUser,
  generation: number,
): Promise<UserDeletionState> {
  const now = new Date().toISOString();
  const state = await db
    .prepare(
      `INSERT INTO users (
         id, issuer, subject, email, generation, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = CASE
           WHEN users.deletion_started_at IS NULL THEN excluded.email
           ELSE users.email
         END,
         updated_at = CASE
           WHEN users.deletion_started_at IS NULL THEN excluded.updated_at
           ELSE users.updated_at
         END
       WHERE users.generation = excluded.generation
       RETURNING deletion_started_at`,
    )
    .bind(user.id, user.issuer, user.subject, user.email, generation, now, now)
    .first<UserDeletionState>();
  if (!state) throw new Error("User upsert returned no row");
  return state;
}

export async function ensureUser(
  db: D1Database,
  user: AuthenticatedUser,
  options: EnsureUserOptions = {},
): Promise<CloudSyncState> {
  const syncState = await getOrCreateCloudSyncState(db, user.id);
  if (syncState.status === "deleting" && !options.allowDeletionInProgress) {
    throw new ApiError(
      409,
      "account_deletion_in_progress",
      "Cloud account deletion is in progress",
    );
  }
  if (syncState.status === "disabled" && !options.allowSyncDisabled) {
    throw new ApiError(
      409,
      "cloud_sync_disabled",
      "Cloud sync must be explicitly enabled",
    );
  }
  if (syncState.status === "enabled") {
    const userState = await upsertUser(db, user, syncState.generation);
    if (userState.deletion_started_at !== null && !options.allowDeletionInProgress) {
      throw new ApiError(
        409,
        "account_deletion_in_progress",
        "Cloud account deletion is in progress",
      );
    }
  }
  return syncState;
}

export async function enableCloudSync(
  db: D1Database,
  user: AuthenticatedUser,
  expectedGeneration: number,
): Promise<number> {
  const initial = await getOrCreateCloudSyncState(db, user.id);
  if (initial.status === "deleting") {
    throw new ApiError(
      409,
      "account_deletion_in_progress",
      "Cloud account deletion is in progress",
    );
  }

  let enabledGeneration: number;
  if (initial.status === "enabled" && initial.generation === expectedGeneration) {
    enabledGeneration = initial.generation;
  } else if (
    initial.status === "enabled" &&
    initial.generation === expectedGeneration + 1
  ) {
    enabledGeneration = initial.generation;
  } else {
    if (
      initial.status !== "disabled" ||
      initial.generation !== expectedGeneration ||
      expectedGeneration >= MAX_GENERATION
    ) {
      throw staleCloudGeneration();
    }
    const enabled = await db
      .prepare(
        `UPDATE cloud_sync_state
         SET status = 'enabled', generation = generation + 1, updated_at = ?
         WHERE user_id = ? AND status = 'disabled' AND generation = ?
         RETURNING status, generation, last_deleted_generation`,
      )
      .bind(new Date().toISOString(), user.id, expectedGeneration)
      .first<CloudSyncStateRow>();
    if (!enabled) throw staleCloudGeneration();
    enabledGeneration = enabled.generation;
  }

  const current = await ensureUser(db, user);
  if (current.status !== "enabled" || current.generation !== enabledGeneration) {
    throw staleCloudGeneration();
  }
  return enabledGeneration;
}
