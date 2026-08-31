import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import App from "./app/App.tsx";
import { ErrorBoundary } from "./app/components/shared/ErrorBoundary.tsx";
import "./styles/index.css";

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
    <Toaster position="top-center" richColors toastOptions={{ style: { fontSize: 13 } }} />
  </ErrorBoundary>
);