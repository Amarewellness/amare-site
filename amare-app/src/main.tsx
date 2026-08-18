import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { PushController } from "./push/PushController";
import { bootstrapPushArrival } from "./push/push-arrival";
import App from "./App";
import "./styles/app.css";
import "./styles/schedule.css";
import "./styles/home.css";
import "./styles/purchase.css";

bootstrapPushArrival();

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
