import { satisfies } from "semver";

/** Reviewed baseline: re-check Node 26 after its October 2026 LTS transition and native CI. */
export const RECOMMENDED_NODE_MAJOR = "24";
export const SUPPORTED_NODE_RANGE = "^22.12.0 || ^24.0.0";

/** Resolve a workspace version-manager value without consulting the network. */
export function resolveNodeVersion(pin: string | undefined): { version: string; notice?: string } {
  if (pin === undefined) return { version: RECOMMENDED_NODE_MAJOR };
  const normalized = pin.trim().replace(/^v/, "");
  if (!/^\d+(?:\.\d+){0,2}$/.test(normalized)) {
    return {
      version: RECOMMENDED_NODE_MAJOR,
      notice: `Could not resolve Node alias "${pin.trim()}" offline; using tested Node ${RECOMMENDED_NODE_MAJOR}.`,
    };
  }
  const parts = normalized.split(".");
  const minimum =
    parts.length === 1 && parts[0] === "22"
      ? "22.12.0"
      : [...parts, ...Array(3 - parts.length).fill("0")].join(".");
  if (!satisfies(minimum, SUPPORTED_NODE_RANGE))
    throw new Error(
      `Node pin "${pin.trim()}" is unsupported by the starter. Use ${SUPPORTED_NODE_RANGE}.`,
    );
  return { version: normalized };
}
