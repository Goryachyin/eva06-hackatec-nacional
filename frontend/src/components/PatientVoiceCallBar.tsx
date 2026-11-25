import React, { useEffect, useRef, useState } from "react";
import {
  api,
  getApiBaseUrl,
  getOrCreateWebSessionId,
  getPatientToken,
  getStoredPatient,
} from "../lib/api";
import { formatCallDuration, getIceServers } from "../lib/webrtcCall";

interface PatientVoiceCallBarProps {
  caseId?: string;
  phone?: string;
  patientName?: string;
  onCallCaseLinked?: (caseId: string) => void;
}

type CallUiState = "idle" | "calling" | "connected" | "ended";

export const PatientVoiceCallBar: React.FC<PatientVoiceCallBarProps> = ({
  caseId,
  phone,
  patientName,
  onCallCaseLinked,
}) => {
  const [callState, setCallState] = useState<CallUiState>("idle");
  const [callId, setCallId] = useState<string | null>(null);
  const [advisorName, setAdvisorName] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const activeCallIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (callState !== "connected") return;
    const timer = window.setInterval(() => {
      setSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [callState]);

  const teardownMedia = () => {
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
    pendingIceRef.current = [];
  };

  useEffect(() => {
    return () => {
      if (activeCallIdRef.current) {
        api.endVoiceCall(activeCallIdRef.current, "ended").catch(() => {});
      }
      teardownMedia();
    };
  }, []);

  const handleStartCall = async () => {
    setError(null);
    setStatusMessage(null);
    setSeconds(0);
    setMuted(false);

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Tu navegador no soporta audio en tiempo real (WebRTC).");
      return;
    }

    try {
      setCallState("calling");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      localStreamRef.current = stream;

      const pc = new RTCPeerConnection({ iceServers: getIceServers() });
      pcRef.current = pc;

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      pc.ontrack = (evt) => {
        if (remoteAudioRef.current && evt.streams[0]) {
          remoteAudioRef.current.srcObject = evt.streams[0];
          remoteAudioRef.current.play().catch(() => {});
        }
      };

      const queuedOutboundIce: RTCIceCandidateInit[] = [];
      pc.onicecandidate = (evt) => {
        if (!evt.candidate) return;
        const json = evt.candidate.toJSON();
        if (activeCallIdRef.current) {
          api.sendVoiceIceCandidate(activeCallIdRef.current, "patient", json).catch(() => {});
        } else {
          queuedOutboundIce.push(json);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const stored = getStoredPatient();
      const effectiveName =
        patientName ||
        [stored?.nombres, stored?.apellido_paterno].filter(Boolean).join(" ") ||
        undefined;
      const effectivePhone = phone || stored?.telefono || undefined;

      const res = await api.startVoiceCall(
        {
          offerSdp: { type: offer.type, sdp: offer.sdp },
          caseId,
          webSessionId: getOrCreateWebSessionId(),
          phone: effectivePhone,
          patientName: effectiveName,
        },
        getPatientToken()
      );

      activeCallIdRef.current = res.callId;
      setCallId(res.callId);
      if (res.caseId && onCallCaseLinked) {
        onCallCaseLinked(res.caseId);
      }

      for (const ice of queuedOutboundIce) {
        api.sendVoiceIceCandidate(res.callId, "patient", ice).catch(() => {});
      }

      const sse = new EventSource(
        `${getApiBaseUrl()}/api/voice/stream/patient/${encodeURIComponent(res.callId)}`
      );
      sseRef.current = sse;

      sse.addEventListener("call_answered", async (evt) => {
        try {
          const data = JSON.parse((evt as MessageEvent).data) as {
            answerSdp: RTCSessionDescriptionInit;
            advisorName?: string;
          };
          if (pcRef.current && data.answerSdp) {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(data.answerSdp));
            for (const c of pendingIceRef.current) {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
            }
            pendingIceRef.current = [];
          }
          setAdvisorName(data.advisorName || "Asesor Salud Digna");
          setCallState("connected");
        } catch {
          setError("No se pudo establecer el audio con el asesor.");
        }
      });

      sse.addEventListener("ice_candidate", async (evt) => {
        try {
          const data = JSON.parse((evt as MessageEvent).data) as {
            candidate?: RTCIceCandidateInit;
          };
          if (!data.candidate || !pcRef.current) return;
          if (pcRef.current.remoteDescription) {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
          } else {
            pendingIceRef.current.push(data.candidate);
          }
        } catch {
          // Ignorar candidato inválido
        }
      });

      sse.addEventListener("call_ended", () => {
        activeCallIdRef.current = null;
        teardownMedia();
        setCallState("ended");
        setStatusMessage("La llamada finalizó. El resumen de tu atención quedará en tu historial.");
      });

      sse.addEventListener("call_rejected", () => {
        activeCallIdRef.current = null;
        teardownMedia();
        setCallState("ended");
        setStatusMessage("El asesor no pudo atender en este momento. Puedes intentar de nuevo o continuar por WhatsApp.");
      });
    } catch (err) {
      activeCallIdRef.current = null;
      teardownMedia();
      setCallState("idle");
      setError(
        err instanceof Error
          ? err.message
          : "No se pudo acceder al micrófono o iniciar la llamada."
      );
    }
  };

  const handleToggleMute = () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const nextMuted = !muted;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setMuted(nextMuted);
  };

  const handleHangUp = async () => {
    const cid = activeCallIdRef.current || callId;
    activeCallIdRef.current = null;
    if (cid) {
      await api.endVoiceCall(cid, "ended").catch(() => {});
    }
    teardownMedia();
    setCallState("ended");
    setStatusMessage("Llamada finalizada. El asesor guardará el resumen en tu expediente.");
  };

  return (
    <section className="border-t border-b border-[#E4E7EB] py-4 space-y-3 bg-[#FFFFFF]">
      <audio ref={remoteAudioRef} autoPlay playsInline />

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
            Atención por voz en tiempo real (WebRTC)
          </p>
          {callState === "idle" && (
            <p className="text-xs text-[#52606D] mt-0.5">
              ¿Tienes dudas o prefieres agendar por voz? Habla en vivo con un asesor sin perder tu
              avance actual.
            </p>
          )}
          {callState === "calling" && (
            <p className="text-sm font-semibold text-[#1F2933] mt-0.5">
              Llamando al Call Center de Salud Digna... esperando que un asesor conteste.
            </p>
          )}
          {callState === "connected" && (
            <p className="text-sm font-semibold text-[#00875A] mt-0.5">
              En llamada con {advisorName || "Asesor"} · {formatCallDuration(seconds)}
              {muted ? " · Micrófono silenciado" : ""}
            </p>
          )}
          {callState === "ended" && statusMessage && (
            <p className="text-xs text-[#52606D] mt-0.5">{statusMessage}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          {(callState === "idle" || callState === "ended") && (
            <button
              type="button"
              onClick={handleStartCall}
              className="h-10 px-4 border border-[#00875A] bg-[#FFFFFF] text-xs font-semibold text-[#00875A] hover:bg-[#00875A] hover:text-[#FFFFFF] transition-colors"
            >
              {callState === "ended" ? "Llamar nuevamente" : "Llamar a un asesor"}
            </button>
          )}

          {callState === "connected" && (
            <button
              type="button"
              onClick={handleToggleMute}
              className={`h-10 px-4 border text-xs font-semibold transition-colors ${
                muted
                  ? "border-[#1F2933] bg-[#1F2933] text-[#FFFFFF]"
                  : "border-[#E4E7EB] bg-[#FFFFFF] text-[#1F2933] hover:border-[#1F2933]"
              }`}
            >
              {muted ? "Activar micrófono" : "Silenciar"}
            </button>
          )}

          {(callState === "calling" || callState === "connected") && (
            <button
              type="button"
              onClick={handleHangUp}
              className="h-10 px-4 border border-[#B42318] bg-[#FFFFFF] text-xs font-semibold text-[#B42318] hover:bg-[#B42318] hover:text-[#FFFFFF] transition-colors"
            >
              Colgar llamada
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="border-l-2 border-[#B42318] pl-3 text-xs text-[#B42318]">{error}</p>
      )}
    </section>
  );
};
