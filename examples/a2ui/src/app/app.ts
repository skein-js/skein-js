import { SurfaceComponent } from "@a2ui/angular";
import { JsonPipe } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  afterRenderEffect,
  computed,
  inject,
  viewChild,
} from "@angular/core";
import { FormControl, ReactiveFormsModule, Validators } from "@angular/forms";

import { UiSession } from "./ui-session";

@Component({
  imports: [ReactiveFormsModule, SurfaceComponent, JsonPipe],
  selector: "app-root",
  templateUrl: "./app.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  readonly session = inject(UiSession);
  readonly prompt = new FormControl("Website traffic dashboard", {
    nonNullable: true,
    validators: [Validators.required, Validators.maxLength(2000)],
  });
  private readonly conversation = viewChild<ElementRef<HTMLElement>>("conversation");
  private readonly scrollVersion = computed(() => {
    const state = this.session.snapshot();
    return [state.conversation.length, state.pendingPrompt, state.busy].join(":");
  });
  readonly samples = [
    "Website traffic dashboard",
    "Event registration form",
    "Product comparison cards",
  ];
  constructor() {
    const threadId = new URLSearchParams(window.location.search).get("thread");
    if (threadId) this.prompt.setValue("");
    void this.session.open(threadId);
    afterRenderEffect(() => {
      this.scrollVersion();
      const element = this.conversation()?.nativeElement;
      if (element) element.scrollTop = element.scrollHeight;
    });
  }
  async send(event?: Event) {
    event?.preventDefault();
    if (this.prompt.invalid) return;
    const submitted = this.prompt.value;
    await this.session.generate(submitted);
    if (!this.session.snapshot().error && this.prompt.value === submitted) this.prompt.setValue("");
  }
  chooseSample(prompt: string) {
    this.prompt.setValue(prompt);
    void this.send();
  }
  newChat() {
    this.prompt.setValue("");
    void this.session.newChat();
  }
  refresh() {
    void this.session.open(this.session.snapshot().threadId);
  }
  surfaceTitle(surfaceId: string) {
    if (surfaceId.endsWith(":canvas")) return "Generated interface";
    if (surfaceId.endsWith(":controls")) return "Refine this UI";
    return "Notes";
  }
}
