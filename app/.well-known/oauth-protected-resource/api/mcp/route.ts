/**
 * RFC 9728 §3.1: the metadata of the resource `https://gettrafficfa.st/api/mcp`
 * lives at the well-known prefix followed by the resource's path. The MCP
 * endpoint's 401 points here (`resource_metadata`). Same document as the
 * root path.
 */
export { GET, OPTIONS } from "../../route";
