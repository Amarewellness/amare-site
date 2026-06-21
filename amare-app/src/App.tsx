import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { AuthCallbackPage } from "./screens/AuthCallbackPage";
import { MyClassesScreen } from "./screens/MyClassesScreen";
import { ProfileScreen } from "./screens/ProfileScreen";
import { ScheduleScreen } from "./screens/ScheduleScreen";

function TabLink({ to, children }: { to: string; children: string }) {
  return (
    <NavLink to={to} className={({ isActive }) => (isActive ? "active" : undefined)}>
      {children}
    </NavLink>
  );
}

function AppLayout() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>AMARÉ</h1>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<ScheduleScreen />} />
          <Route path="/my-classes" element={<MyClassesScreen />} />
          <Route path="/profile" element={<ProfileScreen />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <nav className="app-tabs" aria-label="Main">
        <TabLink to="/">Schedule</TabLink>
        <TabLink to="/my-classes">My Classes</TabLink>
        <TabLink to="/profile">Profile</TabLink>
      </nav>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route path="/*" element={<AppLayout />} />
    </Routes>
  );
}
