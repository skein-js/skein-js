import { A2uiRendererService } from "@a2ui/angular";
import type { ActionPayload } from "@a2ui/web_core/v1_0";
import { Injectable, type OnDestroy, computed, inject, signal } from "@angular/core";
import { Client } from "@langchain/langgraph-sdk";

import { prepareTripRun } from "../trip-client.js";
import type { RendererMetadata, SavedUi } from "../trip-contract.js";
import { createTripSession } from "../trip-session.js";

/** Angular owns presentation; the framework-independent session owns SDK observation. */
@Injectable({ providedIn: "root" })
export class TripSession implements OnDestroy {
  private readonly renderer = inject(A2uiRendererService);
  private readonly session = createTripSession(
    new Client<Record<string, unknown>>({
      apiUrl: window.location.origin + "/api",
      apiKey: null,
      defaultHeaders: { "x-user": "demo-user" },
      onRequest: prepareTripRun,
    }),
    () => this.readMetadata(),
  );
  readonly snapshot = signal(this.session.read());
  readonly surfaceIds = signal<string[]>([]);
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
    const deletions = [...this.renderer.processor.getSurfaces().keys()].map((surfaceId) => ({
      version: "1.0",
      deleteSurface: { surfaceId },
    }));
    this.renderer.processMessages(deletions);
    if (snapshot.view) this.renderer.processMessages(snapshot.view.bootstrapMessages);
    this.surfaceIds.set(
      snapshot.view?.bootstrapMessages.map((message) => message.createSurface.surfaceId) ?? [],
    );
  });

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
  generate(prompt: string) {
    return this.session.generate(prompt);
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
  newTrip() {
    window.history.replaceState(null, "", window.location.pathname);
    return this.session.open(null);
  }
  ngOnDestroy() {
    this.unsubscribe();
    this.session.dispose();
  }
}
