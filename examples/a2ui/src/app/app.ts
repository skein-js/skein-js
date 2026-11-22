import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { FormControl, Validators } from "@angular/forms";

import { ChatConversation, samplePrompts } from "./chat-conversation";
import { JsonInspector } from "./json-inspector";
import { PromptComposer } from "./prompt-composer";
import { UiSession } from "./ui-session";

@Component({
  imports: [ChatConversation, JsonInspector, PromptComposer],
  selector: "app-root",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="playground">
      <header class="site-header">
        <a class="wordmark" href="/">↗ <span>Skein playground</span></a>
        <span class="platform">A2UI · Angular</span>
        <nav aria-label="Playground controls">
          <a href="https://skein.js.org/recipes/a2ui">Guide ↗</a>
          <button type="button" (click)="refresh()" [disabled]="!session.snapshot().threadId">
            Refresh chat
          </button>
          <button type="button" (click)="newChat()">New chat</button>
        </nav>
      </header>
      <div class="workspace">
        <main class="chat-panel" aria-label="UI conversation">
          <app-chat-conversation (sampleSelected)="send($event)" />
          <app-prompt-composer [prompt]="prompt" (promptSubmitted)="send($event)" />
        </main>
        <aside appJsonInspector class="inspector" aria-label="Generated JSON"></aside>
      </div>
    </div>
  `,
})
export class App {
  protected readonly session = inject(UiSession);
  private readonly initialThreadId = new URLSearchParams(window.location.search).get("thread");
  protected readonly prompt = new FormControl<string>(
    this.initialThreadId ? "" : samplePrompts[0],
    {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(2000)],
    },
  );

  constructor() {
    void this.session.open(this.initialThreadId);
  }

  protected send(prompt: string) {
    const draft = this.prompt.value;
    void this.session.generate(prompt, () => {
      if (draft.trim() === prompt.trim() && this.prompt.value === draft) this.prompt.setValue("");
    });
  }

  protected newChat() {
    this.prompt.setValue("");
    void this.session.newChat();
  }

  protected refresh() {
    void this.session.open(this.session.snapshot().threadId);
  }
}
