import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { canAccessRoute, type AppRoute } from "../lib/authorization";

export default function RoleRoute({ route, children }: { route: AppRoute; children: JSX.Element }) {
  const { user } = useAuth();

  if (!canAccessRoute(route, user?.role)) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}
