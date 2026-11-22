import { A2uiRendererService } from "@a2ui/angular";
import type { ActionPayload } from "@a2ui/web_core/v1_0";
import { computed, DestroyRef, inject, Injectable, signal, type OnDestroy } from "@angular/core";
import { Client } from "@langchain/langgraph-sdk";

import { prepareUiRun } from "../ui-client.js";
import type { RendererMetadata, SavedUi } from "../ui-contract.js";
import { createUiSession } from "../ui-session.js";

/** Angular owns presentation; the framework-independent session owns SDK observation. */
@Injectable({ providedIn: "root" })
export class UiSession implements OnDestroy {
  private readonly renderer = inject(A2uiRendererService);
  private readonly surfaceGroup = this.renderer.surfaceGroup;
  private readonly session = createUiSession(
    new Client<Record<string, unknown>>({
      apiUrl: window.location.origin + "/api",
      apiKey: null,
      defaultHeaders: { "x-user": "demo-user" },
      onRequest: prepareUiRun,
    }),
    () => this.readMetadata(),
  );

  readonly snapshot = signal(this.session.read());
  private readonly mountedSurfaceIds = signal(new Set(this.surfaceGroup.surfacesMap.keys()));
  readonly surfaceIds = this.mountedSurfaceIds.asReadonly();
  readonly actionsDisabled = computed(() => {
    const state = this.snapshot();
    return (
      state.busy ||
      state.preview ||
      state.approved === null ||
      Boolean(state.review) ||
      state.needsRefresh
    );
  });

  private displayedUi: SavedUi | null = null;
  private displayedSurfaces = new Map<string, string>();
  private readonly unsubscribe = this.session.subscribe(() => {
    const snapshot = this.session.read();
    this.snapshot.set(snapshot);

    if (snapshot.threadId) {
      const url = new URL(window.location.href);
      url.searchParams.set("thread", snapshot.threadId);
      window.history.replaceState(null, "", url);
    }

    if (snapshot.view === this.displayedUi) return;
    this.displayedUi = snapshot.view;
    const history = snapshot.conversation
      .filter((turn) => turn.generationId !== snapshot.view?.generationId)
      .flatMap((turn) =>
        (turn.ui?.bootstrapMessages ?? []).map((message) => ({
          ...message,
          createSurface: { ...message.createSurface, sendDataModel: false },
        })),
      );

    const messages = [...history, ...(snapshot.view?.bootstrapMessages ?? [])];

    const nextSurfaces = new Map(
      messages.map((message) => [message.createSurface.surfaceId, JSON.stringify(message)]),
    );

    // Keep unchanged surfaces mounted so a sibling update preserves local field values.
    for (const [surfaceId, previous] of this.displayedSurfaces) {
      if (previous !== nextSurfaces.get(surfaceId))
        this.renderer.processMessages({ version: "1.0", deleteSurface: { surfaceId } });
    }

    for (const message of messages) {
      const { surfaceId } = message.createSurface;
      if (this.displayedSurfaces.get(surfaceId) !== nextSurfaces.get(surfaceId))
        this.renderer.processMessages(message);
    }

    this.displayedSurfaces = nextSurfaces;
  });

  constructor() {
    const syncSurfaces = () =>
      this.mountedSurfaceIds.set(new Set(this.surfaceGroup.surfacesMap.keys()));

    const created = this.surfaceGroup.onSurfaceCreated.subscribe(syncSurfaces);
    const deleted = this.surfaceGroup.onSurfaceDeleted.subscribe(syncSurfaces);
    inject(DestroyRef).onDestroy(() => {
      created.unsubscribe();
      deleted.unsubscribe();
    });
  }

  private readMetadata(): RendererMetadata {
    const dataModel = this.renderer.processor.getRendererDataModel("1.0");
    return {
      a2uiRendererCapabilities: this.renderer.processor.getRendererCapabilities({
        versions: ["1.0"],
        includeInlineCatalogs: false,
      }),
      ...(dataModel ? { a2uiRendererDataModel: dataModel } : {}),
    } as RendererMetadata;
  }

  open(threadId: string | null) {
    return this.session.open(threadId);
  }

  generate(prompt: string, onCommitted?: () => void) {
    return this.session.generate(prompt, onCommitted);
  }

  decide(approved: boolean) {
    return this.session.decide(approved);
  }

  act(action: ActionPayload) {
    return this.session.act({ version: "1.0", action });
  }

  disconnect() {
    this.session.disconnect();
  }

  reconnect() {
    return this.session.reconnect();
  }

  stop() {
    return this.session.stop();
  }

  newChat() {
    window.history.replaceState(null, "", window.location.pathname);
    return this.session.open(null);
  }

  ngOnDestroy() {
    this.unsubscribe();
    this.session.dispose();
  }
}
