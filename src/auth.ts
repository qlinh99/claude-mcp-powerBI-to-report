import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const POWERBI_SCOPE = "https://analysis.windows.net/powerbi/api/.default";
const USER_SCOPES = [
  "https://analysis.windows.net/powerbi/api/Workspace.Read.All",
  "https://analysis.windows.net/powerbi/api/Dataset.Read.All",
  "offline_access"
].join(" ");

export type TokenPayload = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
};

export type DeviceLoginState = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
  created_at: number;
};

export class AuthError extends Error {}

export class AuthManager {
  private readonly tenant: string;
  private readonly clientId: string;
  private readonly clientSecret?: string;
  private readonly cachePath: string;
  private pendingDeviceLogin?: DeviceLoginState;

  constructor() {
    this.tenant = process.env.POWERBI_TENANT || "organizations";
    this.clientId = process.env.POWERBI_CLIENT_ID || "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
    this.clientSecret = process.env.POWERBI_CLIENT_SECRET;
    this.cachePath =
      process.env.POWERBI_TOKEN_CACHE ||
      join(homedir(), ".mcp-powerbi", "token-cache.json");
  }

  async getAccessToken(): Promise<string> {
    const envToken = process.env.POWERBI_ACCESS_TOKEN?.trim();
    if (envToken) return envToken;

    if (this.clientSecret) {
      return this.getClientCredentialsToken();
    }

    const cached = await this.readCachedToken();
    if (cached?.access_token && cached.expires_at && cached.expires_at > Date.now() + 120_000) {
      return cached.access_token;
    }

    if (cached?.refresh_token) {
      const refreshed = await this.refreshUserToken(cached.refresh_token);
      await this.writeCachedToken(refreshed);
      return refreshed.access_token;
    }

    throw new AuthError(
      "No Power BI token available. Set POWERBI_ACCESS_TOKEN, configure POWERBI_CLIENT_ID/POWERBI_CLIENT_SECRET, or run start_device_login + complete_device_login once."
    );
  }

  async startDeviceLogin(): Promise<Omit<DeviceLoginState, "device_code">> {
    const url = `https://login.microsoftonline.com/${encodeURIComponent(this.tenant)}/oauth2/v2.0/devicecode`;
    const body = new URLSearchParams({
      client_id: this.clientId,
      scope: USER_SCOPES
    });
    const payload = await postForm<DeviceLoginState>(url, body);
    this.pendingDeviceLogin = { ...payload, created_at: Date.now() };
    return {
      user_code: payload.user_code,
      verification_uri: payload.verification_uri,
      expires_in: payload.expires_in,
      interval: payload.interval,
      message: payload.message,
      created_at: this.pendingDeviceLogin.created_at
    };
  }

  async completeDeviceLogin(): Promise<{ status: "authorized"; expiresAt: string } | { status: "pending"; message: string }> {
    if (!this.pendingDeviceLogin) {
      throw new AuthError("No pending device login. Call start_device_login first.");
    }
    const login = this.pendingDeviceLogin;
    if (Date.now() > login.created_at + login.expires_in * 1000) {
      this.pendingDeviceLogin = undefined;
      throw new AuthError("Device login expired. Call start_device_login again.");
    }

    const url = `https://login.microsoftonline.com/${encodeURIComponent(this.tenant)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: this.clientId,
      device_code: login.device_code
    });

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    const payload = await response.json() as Record<string, unknown>;
    if (response.ok) {
      const token = normalizeToken(payload as TokenPayload);
      await this.writeCachedToken(token);
      this.pendingDeviceLogin = undefined;
      return { status: "authorized", expiresAt: new Date(token.expires_at ?? Date.now()).toISOString() };
    }

    if (payload.error === "authorization_pending") {
      return { status: "pending", message: "Authorization is still pending in the browser." };
    }
    throw new AuthError(`Device login failed: ${JSON.stringify(payload)}`);
  }

  async status(): Promise<{ authMode: string; hasCachedToken: boolean; tenant: string; clientId: string }> {
    const cached = await this.readCachedToken();
    return {
      authMode: this.clientSecret ? "service_principal" : process.env.POWERBI_ACCESS_TOKEN ? "access_token" : "user_cache",
      hasCachedToken: Boolean(cached?.access_token || cached?.refresh_token),
      tenant: this.tenant,
      clientId: this.clientId
    };
  }

  private async getClientCredentialsToken(): Promise<string> {
    if (["organizations", "common", "consumers"].includes(this.tenant)) {
      throw new AuthError("Service principal auth requires POWERBI_TENANT to be a concrete tenant ID/domain.");
    }
    const url = `https://login.microsoftonline.com/${encodeURIComponent(this.tenant)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret!,
      scope: POWERBI_SCOPE
    });
    const token = await postForm<TokenPayload>(url, body);
    return token.access_token;
  }

  private async refreshUserToken(refreshToken: string): Promise<TokenPayload> {
    const url = `https://login.microsoftonline.com/${encodeURIComponent(this.tenant)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.clientId,
      refresh_token: refreshToken,
      scope: USER_SCOPES
    });
    return normalizeToken(await postForm<TokenPayload>(url, body));
  }

  private async readCachedToken(): Promise<TokenPayload | undefined> {
    try {
      return JSON.parse(await readFile(this.cachePath, "utf8")) as TokenPayload;
    } catch {
      return undefined;
    }
  }

  private async writeCachedToken(token: TokenPayload): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, JSON.stringify(normalizeToken(token), null, 2), { mode: 0o600 });
  }
}

function normalizeToken(token: TokenPayload): TokenPayload {
  if (!token.expires_at && token.expires_in) {
    token.expires_at = Date.now() + Math.max(0, token.expires_in - 120) * 1000;
  }
  return token;
}

async function postForm<T>(url: string, body: URLSearchParams): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await response.json() as T;
  if (!response.ok) {
    throw new AuthError(`Token request failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}
