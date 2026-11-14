import { SurfaceComponent } from "@a2ui/angular";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { FormControl, ReactiveFormsModule, Validators } from "@angular/forms";

import { TripSession } from "./trip-session";

@Component({
  imports: [ReactiveFormsModule, SurfaceComponent],
  selector: "app-root",
  templateUrl: "./app.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  readonly session = inject(TripSession);
  readonly prompt = new FormControl(
    "Plan a three-day city break with good food and time to wander.",
    {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(2000)],
    },
  );
  constructor() {
    void this.session.open(new URLSearchParams(window.location.search).get("thread"));
  }
  plan(event: Event) {
    event.preventDefault();
    if (this.prompt.valid) void this.session.generate(this.prompt.value);
  }
  refresh() {
    void this.session.open(this.session.snapshot().threadId);
  }
  surfaceTitle(surfaceId: string) {
    if (surfaceId.endsWith(":itinerary")) return "Your itinerary";
    if (surfaceId.endsWith(":preferences")) return "Make it yours";
    return "A little travel wisdom";
  }
}
