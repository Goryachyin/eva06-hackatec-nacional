import { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { signStaffJwt } from "../lib/crypto";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(4),
});

export async function authRoutes(app: FastifyInstance) {
  app.post(
    "/api/auth/login",
    {
      schema: {
        tags: ["Autenticación RBAC"],
        summary: "Inicia sesión como Asesor (Call Center) o Administrador y devuelve JWT",
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", examples: ["asesor@saluddigna.demo"] },
            password: { type: "string", examples: ["Asesor2026!"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = loginSchema.parse(request.body);

      const user = await prisma.staffUser.findUnique({
        where: { email: email.trim().toLowerCase() },
      });

      if (!user || !user.active) {
        return reply.status(401).send({
          error: "INVALID_CREDENTIALS",
          message: "Credenciales inválidas.",
        });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return reply.status(401).send({
          error: "INVALID_CREDENTIALS",
          message: "Credenciales inválidas.",
        });
      }

      const token = signStaffJwt({
        sub: user.id,
        email: user.email,
        role: user.role,
        fullName: user.fullName,
      });

      return {
        token,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          fullName: user.fullName,
        },
      };
    }
  );
}
