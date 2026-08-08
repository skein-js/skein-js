import { StrictMode } from "react";
import * as ReactDOM from "react-dom/client";

import { ThemeProvider } from "@/lib/theme";

import App from "./app/app";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

root.render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
