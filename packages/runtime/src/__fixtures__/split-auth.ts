import { SkeinHttpError, type AuthEngine } from "@skein-js/core";

export const splitAuth: AuthEngine = {
  enabled: true,
  studioAuthDisabled: true,
  async authenticate(request) {
    const identity = request.headers.get("x-user");
    if (!identity) throw SkeinHttpError.unauthorized("Missing user");
    return {
      user: { identity, display_name: identity, is_authenticated: true, permissions: [] },
      scopes: [],
    };
  },
  async authorize({ resource, value, context }) {
    return {
      value,
      ...(resource === "threads" ? { filters: { owner: context!.user.identity } } : {}),
    };
  },
  matchesFilters: (metadata, filters) => !filters || metadata?.["owner"] === filters["owner"],
};
