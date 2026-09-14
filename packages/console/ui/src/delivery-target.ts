/**
 * A delivery destination safe to put on screen.
 *
 * Webhook paths and channel reply payloads commonly contain credentials or personal identifiers.
 * Keep only the routing information an operator needs; malformed values reveal nothing at all.
 */
export function formatDeliveryTarget(target: string): string {
  const channelPrefix = "skein+channel://";
  if (target.startsWith(channelPrefix)) {
    const encodedName = target.slice(channelPrefix.length).split("/", 1)[0];
    if (!encodedName) return "<unparseable url>";
    try {
      return `channel · ${decodeURIComponent(encodedName)}`;
    } catch {
      return "<unparseable url>";
    }
  }

  try {
    const { protocol, host, pathname } = new URL(target);
    if ((protocol !== "http:" && protocol !== "https:") || !host) return "<unparseable url>";
    return `webhook · ${host}${pathname === "/" ? "" : "/…"}`;
  } catch {
    return "<unparseable url>";
  }
}
