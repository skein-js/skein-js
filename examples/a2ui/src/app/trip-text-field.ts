import { TextFieldComponent } from "@a2ui/angular/v0_9";
import { ChangeDetectionStrategy, Component } from "@angular/core";

@Component({
  selector: "app-trip-text-field",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label [for]="inputId">{{ label() }}</label>
    <input
      [id]="inputId"
      [type]="inputType()"
      [value]="value()"
      [placeholder]="placeholder()"
      maxlength="2000"
      (input)="handleInput($event)"
    />
  `,
  styles: `
    :host {
      display: grid;
      gap: 0.5rem;
      width: 100%;
    }
    label {
      font-weight: 600;
    }
    input {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      padding: 0.75rem;
      border: 1px solid var(--a2ui-color-border, #b8c7bd);
      border-radius: 0.5rem;
      background: var(--a2ui-color-surface, white);
      color: var(--a2ui-color-on-surface, #24382d);
      font: inherit;
    }
    input:focus-visible {
      outline: 3px solid var(--a2ui-color-primary, #285b40);
      outline-offset: 3px;
    }
  `,
})
export class TripTextField extends TextFieldComponent {
  readonly inputId = "trip-feedback-" + crypto.randomUUID();
}
