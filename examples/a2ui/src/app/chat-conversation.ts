import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  output,
} from "@angular/core";

import { UiSession } from "./ui-session";
import { UiSurfaces } from "./ui-surfaces";

export const samplePrompts = [
  "Build a dashboard for skein-js/skein-js",
  "Show the GitHub profile for @octocat",
  "List recently pushed repositories for @torvalds",
] as const;

@Component({
  selector: "app-chat-conversation",
  imports: [UiSurfaces],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "conversation" },
  template: `
    @let state = session.snapshot();

    @if (!state.conversation.length && !state.pendingPrompt) {
      <section class="welcome">
        <h1>Explore public GitHub data</h1>
        <p>Enter a username or repository to generate a view you can refine.</p>
        <div class="samples" aria-label="Sample prompts">
          @for (sample of samples; track sample) {
            <button
              type="button"
              [disabled]="state.busy || !!state.review || state.needsRefresh"
              (click)="sampleSelected.emit(sample)"
            >
              {{ sample }} ↗
            </button>
          }
        </div>
      </section>
    }

    @for (turn of state.conversation; track turn.generationId) {
      <p class="user-message">{{ turn.prompt }}</p>
      @if (turn.ui && (turn.generationId !== state.ui?.generationId || state.pendingPrompt)) {
        <article class="assistant-message history-response" aria-label="Earlier generated UI">
          <div class="response-header">Saved version · read-only</div>
          <app-ui-surfaces [ui]="turn.ui" [disabled]="true" />
        </article>
      } @else if (turn.generationId !== state.ui?.generationId) {
        <p class="earlier-response">This earlier response has no saved UI.</p>
      }
    }

    @if (state.pendingPrompt) {
      <p class="user-message">{{ state.pendingPrompt }}</p>
    }
    @if (state.error) {
      <p class="notice error" role="alert">{{ state.error }}</p>
    }
    @if (state.recovery) {
      <p class="notice" role="status">{{ state.recovery }}</p>
    }

    @if (state.busy || state.view) {
      <article class="assistant-message current-response">
        <div class="response-header" role="status">
          <span class="assistant-mark">↗</span>
          @if (state.preview) {
            Preview · saving after validation
          } @else if (state.busy) {
            Looking up GitHub data and generating UI…
          } @else {
            Saved in this chat
          }
        </div>
        @if ((!state.pendingPrompt || state.preview) && state.view; as view) {
          <app-ui-surfaces [ui]="view" [disabled]="session.actionsDisabled()" />
        }
        @if (state.review && !state.busy && !state.needsRefresh) {
          <section class="review" aria-label="Review generated UI">
            <div>
              <strong>Keep this version?</strong>
              <p>Review the saved UI to enable its controls and continue chatting.</p>
            </div>
            <div class="button-row">
              <button type="button" (click)="session.decide(false)">Reject</button>
              <button class="primary" type="button" (click)="session.decide(true)">
                Approve UI
              </button>
            </div>
          </section>
        }
        @if (state.approved !== null && !state.busy) {
          <p class="decision" role="status">
            {{
              state.approved
                ? "UI approved. Keep refining it."
                : "UI rejected. Describe another direction."
            }}
          </p>
        }
      </article>
    }
  `,
})
export class ChatConversation {
  protected readonly session = inject(UiSession);
  protected readonly samples = samplePrompts;
  readonly sampleSelected = output<string>();
  private readonly container = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly scrollVersion = computed(() => {
    const state = this.session.snapshot();
    return [state.conversation.length, state.pendingPrompt, state.busy].join(":");
  });

  constructor() {
    afterRenderEffect(() => {
      this.scrollVersion();
      const element = this.container.nativeElement;
      element.scrollTop = element.scrollHeight;
    });
  }
}
