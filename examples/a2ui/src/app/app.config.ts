import { provideA2UI, provideMarkdownRenderer } from "@a2ui/angular";
import {
  inject,
  Injector,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
  type ApplicationConfig,
} from "@angular/core";

import { createUiCatalog } from "./native-catalog";
import { UiSession } from "./ui-session";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideA2UI(() => {
      const injector = inject(Injector);
      return {
        catalogs: [createUiCatalog()],
        useUniversalComponents: false,
        actionHandler: (action) => injector.get(UiSession).act(action),
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
