import { ChangeDetectionStrategy, Component, inject, input, output } from "@angular/core";
import { ReactiveFormsModule, type FormControl } from "@angular/forms";

import { UiSession } from "./ui-session";

@Component({
  selector: "app-prompt-composer",
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "composer-dock" },
  template: `
    @let state = session.snapshot();

    @if (state.busy && state.runId) {
      <div class="run-tools">
        @if (state.connected) {
          <button type="button" (click)="session.disconnect()">Pause updates</button>
        } @else {
          <button type="button" (click)="session.reconnect()">Reconnect</button>
        }
        <button type="button" (click)="session.stop()">Stop run</button>
      </div>
    }

    <form class="composer" (submit)="submit($event)">
      <label class="sr-only" for="ui-prompt">Describe the UI</label>
      <textarea
        id="ui-prompt"
        [formControl]="prompt()"
        rows="2"
        maxlength="2000"
        placeholder="Ask about a GitHub username or owner/repo…"
      ></textarea>
      <div class="composer-footer">
        <button
          class="primary"
          type="submit"
          [disabled]="prompt().invalid || state.busy || !!state.review || state.needsRefresh"
        >
          Send ↑
        </button>
      </div>
    </form>

    <div class="composer-note">
      <span>Approval records a decision. Nothing is published or submitted.</span>
      @if (state.threadId) {
        <a [href]="'?thread=' + state.threadId">Reopen this chat ↗</a>
      }
    </div>
  `,
})
export class PromptComposer {
  protected readonly session = inject(UiSession);
  readonly prompt = input.required<FormControl<string>>();
  readonly promptSubmitted = output<string>();

  protected submit(event: Event) {
    event.preventDefault();
    if (this.prompt().valid) this.promptSubmitted.emit(this.prompt().value);
  }
}
