import { BASIC_COMPONENTS, BasicCatalog, createComponentImplementation } from "@a2ui/angular";
import {
  ButtonComponent,
  CardComponent,
  ColumnComponent,
  DividerComponent,
  RowComponent,
  TextComponent,
} from "@a2ui/angular/v0_9";

import { TripTextField } from "./trip-text-field";

function basicApi(name: string) {
  const component = BASIC_COMPONENTS.find((candidate) => candidate.name === name);
  if (!component) throw new Error("The pinned Basic Catalog is missing " + name);
  return component;
}

/** 0.14 defaults v1 to universal elements. Reuse its exported native widgets with v1 schemas. */
export function createTripCatalog() {
  return new BasicCatalog({
    components: {
      text: createComponentImplementation(basicApi("Text"), TextComponent),
      column: createComponentImplementation(basicApi("Column"), ColumnComponent),
      row: createComponentImplementation(basicApi("Row"), RowComponent),
      card: createComponentImplementation(basicApi("Card"), CardComponent),
      button: createComponentImplementation(basicApi("Button"), ButtonComponent),
      textField: createComponentImplementation(basicApi("TextField"), TripTextField),
      divider: createComponentImplementation(basicApi("Divider"), DividerComponent),
    },
  });
}
