export type NodeHostBrowserProxyConfig = {
  /** Enable the browser proxy on the node host (default: true). */
  enabled?: boolean;
  /** Optional allowlist of profile names exposed via the proxy. */
  allowProfiles?: string[];
};

export type NodeHostFileGetConfig = {
  /**
   * Allowlist of absolute path patterns allowed for `file.get`.
   * Uses the same glob semantics as exec approvals (supports `*`, `**`, `?`).
   * Default: empty (deny all).
   */
  allowPaths?: string[];
  /**
   * Optional denylist of absolute path patterns denied for `file.get`.
   * Deny wins over allow.
   */
  denyPaths?: string[];
};

export type NodeHostConfig = {
  /** Browser proxy settings for node hosts. */
  browserProxy?: NodeHostBrowserProxyConfig;
  /** Node-host file retrieval policy for `file.get`. */
  fileGet?: NodeHostFileGetConfig;
};
