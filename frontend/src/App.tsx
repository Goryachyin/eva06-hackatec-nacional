import React from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { LabLayout } from "./components/layouts/LabLayout";
import { PublicLayout } from "./components/layouts/PublicLayout";
import { AdminDashboard } from "./pages/AdminDashboard";
import { CallCenterPage } from "./pages/CallCenterPage";
import { HomePage } from "./pages/HomePage";
import { LabHomePage } from "./pages/LabHomePage";
import { LaboratorioPage } from "./pages/LaboratorioPage";
import { Otp2faPage } from "./pages/Otp2faPage";
import { PatientAccountPage } from "./pages/PatientAccountPage";
import { PatientLoginPage } from "./pages/PatientLoginPage";
import { PatientRegisterPage } from "./pages/PatientRegisterPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { WhatsAppSimPage } from "./pages/WhatsAppSimPage";

const PublicShell: React.FC = () => (
  <PublicLayout>
    <Outlet />
  </PublicLayout>
);

const LabShell: React.FC = () => (
  <LabLayout>
    <Outlet />
  </LabLayout>
);

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <Routes>
        {/* 1. PORTAL PÚBLICO DE PACIENTES (100% limpio para producción) */}
        <Route element={<PublicShell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<PatientLoginPage />} />
          <Route path="/registro" element={<PatientRegisterPage />} />
          <Route path="/mi-cuenta" element={<PatientAccountPage />} />
          <Route path="/laboratorio" element={<LaboratorioPage />} />
          <Route path="/web" element={<LaboratorioPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
        </Route>

        {/* 2. BACK-OFFICE ADMINISTRADOR (Layout completamente aislado) */}
        <Route path="/admin" element={<AdminDashboard />} />

        {/* 3. ESTACIÓN CALL CENTER (Layout completamente aislado) */}
        <Route path="/call-center" element={<CallCenterPage />} />

        {/* 4. LABORATORIO DE PRUEBAS Y SIMULADORES (Layout aislado QA) */}
        <Route element={<LabShell />}>
          <Route path="/lab" element={<LabHomePage />} />
          <Route path="/lab/whatsapp" element={<WhatsAppSimPage />} />
          <Route path="/lab/otp-2fa" element={<Otp2faPage />} />
          {/* Alias compatibles con la documentación */}
          <Route path="/whatsapp" element={<WhatsAppSimPage />} />
          <Route path="/whatsapp-sim" element={<WhatsAppSimPage />} />
          <Route path="/otp-2fa" element={<Otp2faPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
};

export default App;
