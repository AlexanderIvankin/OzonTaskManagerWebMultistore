import { useEffect } from "react";
import { useDispatch } from "react-redux";
import { AppDispatch } from "./store";
import { restoreSession } from "./store/authSlice";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Login } from "./pages/Login/Login";
import { Register } from "./pages/Register/Register";
import { VerifyEmail } from "./pages/VerifyEmail/VerifyEmail";
import { ResetPassword } from "./pages/ResetPassword/ResetPassword";
import { Profile } from "./pages/Profile/Profile";
import { Orders } from "./pages/Orders/Orders";
import { Notifications } from "./pages/Notifications/Notifications";
import { AdminPanel } from "./pages/Admin/AdminPanel";
import { Users } from "./pages/Admin/Users";
import { Warehouses } from "./pages/Admin/Warehouses";
import { OrdersManagement } from "./pages/Admin/OrdersManagement";
import { ActiveOrders } from "./pages/Admin/ActiveOrders";
import { CompletedOrders } from "./pages/Admin/CompletedOrders";
import { Materials } from "./pages/Admin/Materials";
import { Models } from "./pages/Admin/Models";
import { EarningsManagement } from "./pages/Admin/EarningsManagement";
import { StaffStats } from "./pages/Admin/StaffStats";
import { ExportData } from "./pages/Admin/ExportData";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Layout } from "./components/Layout/Layout";

function App() {
  const dispatch = useDispatch<AppDispatch>();

  useEffect(() => {
    dispatch(restoreSession());
  }, [dispatch]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/reset-password" element={<ResetPassword />} />

        {/* Защищённые маршруты с Layout */}
        <Route element={<ProtectedRoute />}>
          <Route element={<Layout />}>
            <Route path="/profile" element={<Profile />} />
            <Route
              path="/orders"
              element={
                <ProtectedRoute
                  allowedRoles={["employee", "moderator", "admin", "god"]}
                >
                  <Orders />
                </ProtectedRoute>
              }
            />
            {/* Оповещения доступны всем ролям (личные); журнал действий и
                ошибки сервера отображаются внутри страницы только персоналу */}
            <Route path="/notifications" element={<Notifications />} />

            {/* Админка: каждая вкладка — самостоятельный маршрут.
                Навигация выполняется через Layout, вложенный роутер-хаб
                с дублирующими вкладками не используется */}
            <Route element={<ProtectedRoute allowedRoles={["admin", "moderator", "god"]} />}>
              <Route path="/admin" element={<AdminPanel />} />
              <Route path="/admin/users" element={<Users />} />
              <Route path="/admin/warehouses" element={<Warehouses />} />
              <Route path="/admin/orders" element={<OrdersManagement />} />
              <Route path="/admin/active-orders" element={<ActiveOrders />} />
              <Route
                path="/admin/completed-orders"
                element={<CompletedOrders />}
              />
              <Route path="/admin/materials" element={<Materials />} />
              <Route path="/admin/models" element={<Models />} />
              <Route path="/admin/earnings" element={<EarningsManagement />} />
              <Route path="/admin/stats" element={<StaffStats />} />
              <Route path="/admin/export" element={<ExportData />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/profile" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
