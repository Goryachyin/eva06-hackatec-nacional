import React, { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
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
    <div className="max-w-md mx-auto px-4 sm:px-6 py-16 bg-[#FFFFFF] text-[#1F2933]">
      <header className="pb-6 border-b border-[#E4E7EB] space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
          Portal de pacientes
        </p>
        <h1 className="text-3xl font-bold text-[#1F2933]">Inicia sesión en tu cuenta</h1>
        <p className="text-sm text-[#52606D]">
          Accede a tus citas, estudios solicitados y folios de confirmación.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="pt-8 space-y-6">
        {error && (
          <p className="border-l-2 border-[#B42318] pl-4 py-1 text-sm text-[#B42318]">{error}</p>
        )}

        <div>
          <label
            htmlFor="patient-identifier"
            className="block text-xs font-semibold text-[#1F2933] mb-1.5"
          >
            Correo electrónico, teléfono o CURP
          </label>
          <input
            id="patient-identifier"
            type="text"
            required
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="ejemplo@correo.com o 10 dígitos"
            className="w-full h-11 border border-[#E4E7EB] px-3.5 text-sm text-[#1F2933] placeholder:text-[#52606D] focus:border-[#00875A]"
          />
        </div>

        <div>
          <label
            htmlFor="patient-password"
            className="block text-xs font-semibold text-[#1F2933] mb-1.5"
          >
            Contraseña
          </label>
          <input
            id="patient-password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="w-full h-11 border border-[#E4E7EB] px-3.5 text-sm text-[#1F2933] placeholder:text-[#52606D] focus:border-[#00875A]"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full h-12 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] text-sm font-semibold transition-colors disabled:opacity-50"
        >
          {loading ? "Verificando..." : "Entrar a mi cuenta"}
        </button>

        <p className="pt-6 border-t border-[#E4E7EB] text-sm text-[#52606D]">
          ¿Aún no tienes cuenta?{" "}
          <Link to="/registro" className="font-semibold text-[#00875A] hover:underline">
            Crear cuenta nueva
          </Link>
        </p>
      </form>
    </div>
  );
};
