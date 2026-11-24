import React, { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AlertCircle, ArrowRight, Lock, LogIn, User } from "lucide-react";
import { api, savePatientSession } from "../lib/api";

export const PatientLoginPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const nextPath = searchParams.get("next") || "/mi-cuenta";

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim() || !password) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.loginPatientAccount(identifier.trim(), password);
      savePatientSession(res);
      navigate(nextPath);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "No se pudo iniciar sesión. Verifica tus credenciales."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto px-4 py-12 sm:py-16">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-[#005A2B] to-[#00843D] px-6 py-6 text-white">
          <div className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider bg-white/15 px-2.5 py-1 rounded-full mb-2.5">
            <LogIn className="w-3.5 h-3.5" />
            Portal de Pacientes
          </div>
          <h1 className="text-2xl font-extrabold">Inicia sesión en tu cuenta</h1>
          <p className="text-emerald-100 text-sm mt-1">
            Accede a tus citas, estudios solicitados y folios de confirmación.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label
              htmlFor="patient-identifier"
              className="block text-sm font-semibold text-slate-700 mb-1.5"
            >
              Correo electrónico, teléfono o CURP
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                id="patient-identifier"
                type="text"
                required
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="ejemplo@correo.com o 10 dígitos"
                className="w-full h-11 rounded-lg border border-slate-300 pl-10 pr-3.5 text-sm focus:outline-none focus:border-[#00843D] focus:ring-2 focus:ring-[#00843D]/20"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="patient-password"
              className="block text-sm font-semibold text-slate-700 mb-1.5"
            >
              Contraseña
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                id="patient-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full h-11 rounded-lg border border-slate-300 pl-10 pr-3.5 text-sm focus:outline-none focus:border-[#00843D] focus:ring-2 focus:ring-[#00843D]/20"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full h-11 bg-[#00843D] hover:bg-[#006E32] text-white font-bold rounded-lg text-sm transition shadow-sm flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {loading ? "Verificando..." : "Entrar a mi cuenta"}
            {!loading && <ArrowRight className="w-4 h-4" />}
          </button>

          <div className="pt-3 border-t border-slate-100 text-center text-sm text-slate-600">
            ¿Aún no tienes cuenta?{" "}
            <Link to="/registro" className="font-bold text-[#00843D] hover:underline">
              Crear cuenta nueva
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
};
