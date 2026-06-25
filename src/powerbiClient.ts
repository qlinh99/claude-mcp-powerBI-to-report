import { AuthManager } from "./auth.js";

const POWERBI_API = "https://api.powerbi.com/v1.0/myorg";

export type Workspace = {
  id: string | null;
  name: string;
  type?: string;
  isOnDedicatedCapacity?: boolean;
  capacityId?: string;
};

export type SemanticModel = {
  id: string;
  name: string;
  configuredBy?: string;
  isRefreshable?: boolean;
  isEffectiveIdentityRequired?: boolean;
  isEffectiveIdentityRolesRequired?: boolean;
  targetStorageMode?: string;
  webUrl?: string;
};

export type CatalogWorkspace = Workspace & {
  semanticModels: SemanticModel[];
  error?: string;
};

export class PowerBiClient {
  constructor(private readonly auth: AuthManager) {}

  async listWorkspaces(includeMyWorkspace = true): Promise<Workspace[]> {
    const groups = await this.pagedGet<Workspace>("/groups");
    groups.sort((a, b) => a.name.localeCompare(b.name));
    return includeMyWorkspace
      ? [{ id: null, name: "My workspace", type: "PersonalGroup" }, ...groups]
      : groups;
  }

  async listSemanticModels(workspaceId?: string | null): Promise<SemanticModel[]> {
    const path = workspaceId ? `/groups/${encodeURIComponent(workspaceId)}/datasets` : "/datasets";
    const datasets = await this.pagedGet<SemanticModel>(path);
    return datasets.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getCatalog(includeMyWorkspace = true): Promise<{ source: string; generatedAt: string; workspaces: CatalogWorkspace[] }> {
    const workspaces = await this.listWorkspaces(includeMyWorkspace);
    const result: CatalogWorkspace[] = [];
    for (const workspace of workspaces) {
      const entry: CatalogWorkspace = { ...workspace, semanticModels: [] };
      try {
        entry.semanticModels = await this.listSemanticModels(workspace.id);
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
      }
      result.push(entry);
    }
    return {
      source: "powerbi-rest-api",
      generatedAt: new Date().toISOString(),
      workspaces: result
    };
  }

  private async pagedGet<T>(path: string): Promise<T[]> {
    const values: T[] = [];
    let next: string | undefined = `${POWERBI_API}${path}`;
    while (next) {
      const payload: { value?: T[]; "@odata.nextLink"?: string } = await this.get(next);
      values.push(...(payload.value ?? []));
      next = payload["@odata.nextLink"];
    }
    return values;
  }

  private async get<T>(url: string): Promise<T> {
    const token = await this.auth.getAccessToken();
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` }
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`Power BI REST GET ${url} failed: ${response.status} ${text}`);
    }
    return payload as T;
  }
}
