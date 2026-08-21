import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { PushController } from "./push/PushController";
import { bootstrapPushArrival } from "./push/push-arrival";
import App from "./App";
import { applySafeAreaInsets } from "./lib/safe-area";
import "./styles/app.css";
import "./styles/schedule.css";
import "./styles/home.css";
import "./styles/purchase.css";
import "./styles/first-visit.css";
import "./styles/contact.css";

bootstrapPushArrival();
applySafeAreaInsets();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <PushController>
          <App />
        </PushController>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
