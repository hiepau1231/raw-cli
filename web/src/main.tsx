import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { initializeToken } from "./api.js";
import { DataProvider } from "./data/provider.js";
import { Router } from "./router.js";
import { initializeStyleNonce } from "./style-nonce.js";
// Bundled, OFL-licensed fonts (docs/dashboard.md): the same type on every system, no platform font.
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles.css";
initializeToken();
initializeStyleNonce();
createRoot(document.getElementById("root")!).render(
  <DataProvider>
    <Router>
      <App />
    </Router>
  </DataProvider>,
);
