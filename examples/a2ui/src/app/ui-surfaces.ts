import { SurfaceComponent } from "@a2ui/angular";
import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";

import type { SavedUi } from "../ui-contract.js";

import { UiSession } from "./ui-session";

@Component({
  selector: "app-ui-surfaces",
  imports: [SurfaceComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (surfaceId of surfaceIds(); track surfaceId) {
      @let title = surfaceTitle(surfaceId);
      <section class="surface-card" [attr.aria-label]="title">
        <h2>{{ title }}</h2>
        <fieldset class="generated" [disabled]="disabled()">
          <a2ui-v09-surface [surfaceId]="surfaceId" />
        </fieldset>
      </section>
    }
  `,
})
export class UiSurfaces {
  readonly ui = input.required<SavedUi>();
  readonly disabled = input(false);
  private readonly session = inject(UiSession);

  protected readonly surfaceIds = computed(() => {
    const mounted = this.session.surfaceIds();
    return this.ui()
      .bootstrapMessages.map(({ createSurface }) => createSurface.surfaceId)
      .filter((surfaceId) => mounted.has(surfaceId));
  });

  protected surfaceTitle(surfaceId: string) {
    if (surfaceId.endsWith(":canvas")) return "Generated interface";
    if (surfaceId.endsWith(":controls")) return "Refine this UI";
    return "Notes";
  }
}
