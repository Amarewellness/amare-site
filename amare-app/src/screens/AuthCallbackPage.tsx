import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function AuthCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { completeOAuth } = useAuth();
  const [msg, setMsg] = useState("Signing you in…");
  const exchangeStarted = useRef(false);

  useEffect(() => {
    const err = params.get("error");
    if (err) {
      setMsg(`Sign-in failed: ${err}`);
      return;
    }
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      setMsg("Missing authorization code.");
      return;
    }

    const dedupeKey = `amare_oauth_exchange:${state}`;
    if (exchangeStarted.current || sessionStorage.getItem(dedupeKey)) {
      return;
    }
    exchangeStarted.current = true;
    sessionStorage.setItem(dedupeKey, "1");

    completeOAuth(code, state)
      .then(() => {
        sessionStorage.removeItem(dedupeKey);
        navigate("/", { replace: true });
      })
      .catch((e) => {
        sessionStorage.removeItem(dedupeKey);
        setMsg(e instanceof Error ? e.message : "Sign-in failed");
      });
  }, [params, completeOAuth, navigate]);

  return (
    <div className="gate">
      <p>{msg}</p>
    </div>
  );
}
