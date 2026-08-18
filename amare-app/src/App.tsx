import type { ReactNode } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { MemberSummaryProvider } from "./hooks/useMemberSummary";
import { AuthCallbackPage } from "./screens/AuthCallbackPage";
import { HomeScreen } from "./screens/HomeScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { MyClassesScreen } from "./screens/MyClassesScreen";
import { ProfileScreen } from "./screens/ProfileScreen";
import { PurchaseScreen } from "./screens/PurchaseScreen";
import { ScheduleScreen } from "./screens/ScheduleScreen";

function IconHome() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 4.2 4 10.5V20h5.2v-6.2h5.6V20H20v-9.5L12 4.2Z"
      />
    </svg>
  );
}

function IconSchedule() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M7 3.5h2v2h6v-2h2v2h3v15H4v-15h3v-2Zm11 6H6v9h12v-9Z"
      />
    </svg>
  );
}

function IconClasses() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6 5h12v3.2H6V5Zm0 5.4h12V20H6V10.4Zm2 2v5.6h8v-5.6H8Z"
      />
    </svg>
  );
}

function IconProfile() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 4.5a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2ZM5.2 19.6c.7-3.2 3.4-5 6.8-5s6.1 1.8 6.8 5H5.2Z"
      />
    </svg>
  );
}

function TabLink({
  to,
  label,
  icon,
}: {
  to: string;
  label: string;
  icon: ReactNode;
}) {
  return (
    <NavLink to={to} end={to === "/"} className={({ isActive }) => (isActive ? "active" : undefined)}>
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}

function AppLayout() {
  return (
    <MemberSummaryProvider>
      <div className="app-shell">
        <main className="app-main">
          <Routes>
            <Route path="/" element={<HomeScreen />} />
            <Route path="/schedule" element={<ScheduleScreen />} />
            <Route path="/my-classes" element={<MyClassesScreen />} />
            <Route path="/purchase" element={<PurchaseScreen />} />
            <Route path="/profile" element={<ProfileScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <nav className="app-tabs" aria-label="Main">
          <TabLink to="/" label="Home" icon={<IconHome />} />
          <TabLink to="/schedule" label="Schedule" icon={<IconSchedule />} />
          <TabLink to="/my-classes" label="Classes" icon={<IconClasses />} />
          <TabLink to="/profile" label="Profile" icon={<IconProfile />} />
        </nav>
      </div>
    </MemberSummaryProvider>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route
        path="/login"
        element={
          <div className="app-shell">
            <header className="app-header">
              <h1>AMARÉ</h1>
            </header>
            <main className="app-main app-main--auth">
              <LoginScreen />
            </main>
          </div>
        }
      />
      <Route path="/*" element={<AppLayout />} />
    </Routes>
  );
}
