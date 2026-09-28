// JSON-RPC 2.0 messages for the sandbox frame protocol.

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number;
  error: { code: number; message: string };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// Serialised HTTP request/response shapes for the fetch RPC.

export interface SerialisedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface SerialisedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
}

/** The result of resolving a file request inside the sandbox. */
export interface FileResponse {
  status: number;
  contentType: string;
  body: Uint8Array;
}

/** A virtual script served at `path` and injected into HTML responses. */
export interface InjectedScript {
  path: string;
  content: string;
}
