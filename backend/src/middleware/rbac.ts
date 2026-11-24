import { FastifyReply, FastifyRequest } from "fastify";
import { StaffRole } from "@prisma/client";
import {
  PatientTokenPayload,
  StaffTokenPayload,
  verifyPatientJwt,
  verifyStaffJwt,
} from "../lib/crypto";

declare module "fastify" {
  interface FastifyRequest {
    staffUser?: StaffTokenPayload;
    patientUser?: PatientTokenPayload;
  }
}

export async function requirePatientAuth(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  const queryToken = (request.query as Record<string, string | undefined>)?.token;

  let token: string | undefined;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  } else if (queryToken) {
    token = queryToken.trim();
  }

  if (!token) {
    return reply.status(401).send({
      error: "UNAUTHORIZED",
      message: "Inicia sesión para consultar tu cuenta de paciente.",
    });
  }

  try {
    request.patientUser = verifyPatientJwt(token);
  } catch {
    return reply.status(401).send({
      error: "INVALID_TOKEN",
      message: "Tu sesión expiró. Por favor inicia sesión nuevamente.",
    });
  }
}

export function requireStaffRole(allowedRoles: StaffRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    const queryToken = (request.query as Record<string, string | undefined>)?.token;

    let token: string | undefined;
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    } else if (queryToken) {
      token = queryToken.trim();
    }

    if (!token) {
      return reply.status(401).send({
        error: "UNAUTHORIZED",
        message: "Token JWT requerido para acceder a este recurso.",
      });
    }

    try {
      const decoded = verifyStaffJwt(token);
      if (!allowedRoles.includes(decoded.role)) {
        return reply.status(403).send({
          error: "FORBIDDEN",
          message: `Acceso denegado. Se requiere rol: ${allowedRoles.join(" o ")}.`,
        });
      }
      request.staffUser = decoded;
    } catch {
      return reply.status(401).send({
        error: "INVALID_TOKEN",
        message: "Token JWT inválido o expirado.",
      });
    }
  };
}
