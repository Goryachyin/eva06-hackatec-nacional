import { FastifyInstance } from "fastify";
import { listActiveOtpOutbox } from "../core/identityService";

export async function otp2faRoutes(app: FastifyInstance) {
  app.get(
    "/api/otp-2fa/inbox",
    {
      schema: {
        tags: ["Seguridad Step-Up OTP (Consola 2FA)"],
        summary:
          "Bandeja externa independiente (simula SMS/Correo) con los códigos OTP activos en Redis y su TTL restante",
      },
    },
    async () => {
      const items = await listActiveOtpOutbox();
      return {
        count: items.length,
        items,
      };
    }
  );
}
