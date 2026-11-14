import { injectBasicCatalogStyles } from "@a2ui/web_core/v1_0";
import { bootstrapApplication } from "@angular/platform-browser";

import { App } from "./app/app";
import { appConfig } from "./app/app.config";

injectBasicCatalogStyles();
bootstrapApplication(App, appConfig).catch((err) => console.error(err));
