import { JsonPipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";

import { UiSession } from "./ui-session";

@Component({
  selector: "aside[appJsonInspector]",
  imports: [JsonPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let state = session.snapshot();
    <details open>
      <summary>Generated JSON <span>A2UI 1.0</span></summary>
      <p>
        Validated bootstrap for the current {{ state.preview ? "preview" : "saved UI" }}. Earlier
        responses stay read-only in the chat.
      </p>
      <pre
        role="region"
        tabindex="0"
        aria-label="A2UI JSON"
      ><code>{{ (state.view?.bootstrapMessages ?? []) | json }}</code></pre>
    </details>
  `,
})
export class JsonInspector {
  protected readonly session = inject(UiSession);
}
