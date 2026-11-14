import { provideA2UI, provideMarkdownRenderer } from "@a2ui/angular";
import {
  type ApplicationConfig,
  Injector,
  inject,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from "@angular/core";

import { TripSession } from "./trip-session";
import { createTripCatalog } from "./trip-catalog";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideA2UI(() => {
      const injector = inject(Injector);
      return {
        catalogs: [createTripCatalog()],
        useUniversalComponents: false,
        actionHandler: (action) => injector.get(TripSession).act(action),
      };
    }),
    provideMarkdownRenderer(async (text) =>
      text.replace(
        /[&<>"']/g,
        (character) =>
          ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
      ),
    ),
  ],
};
