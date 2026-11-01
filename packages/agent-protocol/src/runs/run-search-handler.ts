import { SkeinHttpError } from "@skein-js/core";

import type { ProtocolHandler } from "../create-handlers.js";
import { operationContracts, createOperationJson } from "../http/operation-contracts.js";
import { parse } from "../validation/parse.js";

import type { RunService } from "./run-service.js";

export function createRunSearchHandler(service: RunService): ProtocolHandler {
  return async (request) => {
    const query = parse(operationContracts.searchRuns.body, request.body ?? {});
    if (!service.search)
      throw SkeinHttpError.notImplemented("This service does not support cross-thread run search.");
    // Map only public fields. Server ownership constraints never come from the request body.
    const runs = await service.search({
      status: query.status,
      assistantId: query.assistant_id,
      threadId: query.thread_id,
      createdAfter: query.created_after,
      createdBefore: query.created_before,
      updatedAfter: query.updated_after,
      updatedBefore: query.updated_before,
      limit: query.limit,
      offset: query.offset,
    });
    return createOperationJson("searchRuns", runs);
  };
}
