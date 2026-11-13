import { Navigate, Route, Routes } from "react-router";
import { RequireRole } from "./components/AppShell";
import { homeFor, useSession } from "./auth/session";
import { DEMO_MODE } from "./lib/env";
import { Login } from "./pages/Login";
import { Landing } from "./pages/Landing";
import { AttentionQueue } from "./pages/coordinator/AttentionQueue";
import { ShipmentDetailPage } from "./pages/coordinator/ShipmentDetail";
import { Dashboard } from "./pages/coordinator/Dashboard";
import { Ledger } from "./pages/coordinator/Ledger";
import { DemoControls } from "./pages/coordinator/DemoControls";
import { DriverTrip } from "./pages/driver/DriverTrip";
import { DriverReport } from "./pages/driver/DriverReport";
import { MyDeliveries } from "./pages/customer/MyDeliveries";
import { DeliveryDetail } from "./pages/customer/DeliveryDetail";
import { NewOrder } from "./pages/coordinator/NewOrder";

/* Routes are exactly DESIGN.md 7.1. Hiding a route here is a convenience; the API enforces access. */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/coordinator" element={<RequireRole role="COORDINATOR" />}>
        <Route index element={<AttentionQueue />} />
        <Route path="shipments/:id" element={<ShipmentDetailPage />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="ledger" element={<Ledger />} />
        <Route path="orders/new" element={<NewOrder />} />
        {DEMO_MODE && <Route path="demo" element={<DemoControls />} />}
      </Route>
      <Route path="/driver" element={<RequireRole role="DRIVER" />}>
        <Route index element={<DriverTrip />} />
        <Route path="report" element={<DriverReport />} />
      </Route>
      <Route path="/customer" element={<RequireRole role="CUSTOMER" />}>
        <Route index element={<MyDeliveries />} />
        <Route path="shipments/:id" element={<DeliveryDetail />} />
        <Route path="orders/new" element={<NewOrder />} />
      </Route>
      <Route path="*" element={<Home />} />
    </Routes>
  );
}

function Home() {
  const session = useSession();
  return <Navigate to={session ? homeFor(session.user.role) : "/login"} replace />;
}
