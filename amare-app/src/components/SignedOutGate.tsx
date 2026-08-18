import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";

type Props = {
  title: string;
  lede: string;
  children?: ReactNode;
};

export function SignedOutGate({ title, lede, children }: Props) {
  const { signIn } = useAuth();
  return (
    <div className="signed-out-gate">
      <h1 className="signed-out-gate__title">{title}</h1>
      <p className="signed-out-gate__lede">{lede}</p>
      <button type="button" className="btn" onClick={signIn}>
        Sign in
      </button>
      {children}
    </div>
  );
}
