import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { saveCurrent } from "./persistence/db";
import { App } from "./ui/App";
import { clearTrace } from "./ui/actions";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { installGlobalErrorHandlers } from "./ui/globalErrors";
import { store } from "./ui/store";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
installGlobalErrorHandlers();
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary
      root
      region="Dry Run"
      recover={{ label: "Clear the trace and continue", run: clearTrace }}
      // whatever failed, the user's code must survive it
      onError={() => saveCurrent(store.get().ws)}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
