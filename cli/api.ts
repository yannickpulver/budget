/** Thin client for the budget server's /api/v1 endpoints. */

export class Api {
  private readonly base: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.base = `${url.replace(/\/+$/, "")}/api/v1`;
    this.token = token;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.base}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      const cause = error instanceof Error ? (error.cause as { code?: string; message?: string } | undefined) : undefined;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot reach ${url}: ${cause?.code ?? cause?.message ?? message}`);
    }

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return parsed as T;
  }
}
