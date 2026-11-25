import React, { useEffect, useRef, useState } from "react";
import { api, getApiBaseUrl } from "../lib/api";
import { formatDateTime } from "../lib/constants";
import {
  blobToBase64,
  DualTrackAudioRecorder,
  formatCallDuration,
  getIceServers,
} from "../lib/webrtcCall";
import { CallCenterCaseItem, CallSummaryRecord, IncomingVoiceCall } from "../types/api";

interface AdvisorVoicePanelProps {
  token: string;
  selectedCase: CallCenterCaseItem | null;
  onSelectCaseById: (caseId: string) => void;
  onCaseUpdated: () => Promise<void>;
}

const SENTIMENT_LABEL: Record<CallSummaryRecord["sentiment"], string> = {
  positivo: "Positivo",
  neutral: "Neutral",
  preocupado: "Preocupado",
  urgente: "Urgente",
};

export const AdvisorVoicePanel: React.FC<AdvisorVoicePanelProps> = ({
  token,
  selectedCase,
  onSelectCaseById,
  onCaseUpdated,
}) => {
  const [incomingCalls, setIncomingCalls] = useState<IncomingVoiceCall[]>([]);
  const [activeCall, setActiveCall] = useState<IncomingVoiceCall | null>(null);
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [processingAi, setProcessingAi] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  // Respaldo opcional para pruebas sin micrófono (subir audio o pegar transcripción)
  const [showManualTools, setShowManualTools] = useState(false);
  const [manualTranscript, setManualTranscript] = useState("");
  const [autoApplyEntities, setAutoApplyEntities] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const recorderRef = useRef<DualTrackAudioRecorder | null>(null);
  const pendingIceByCallRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const activeCallRef = useRef<IncomingVoiceCall | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  useEffect(() => {
    if (!activeCall) return;
    const timer = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [activeCall]);

  const cleanupPeerMedia = () => {
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
  };

  const finalizeAndSummarizeActiveCall = async (callToClose: IncomingVoiceCall, notifyRemote: boolean) => {
    setActiveCall(null);
    activeCallRef.current = null;

    if (notifyRemote) {
      api.endVoiceCall(callToClose.callId, "ended").catch(() => {});
    }

    let recorded: { audioBase64: string; mimeType: string; durationSeconds: number } | null = null;
    if (recorderRef.current) {
      try {
        recorded = await recorderRef.current.stop();
      } catch {
        recorded = null;
      }
      recorderRef.current = null;
    }

    cleanupPeerMedia();
    setMuted(false);

    if (!recorded) {
      setVoiceNotice("Llamada finalizada (no se capturó audio suficiente para transcripción).");
      return;
    }

    setProcessingAi(true);
    setVoiceError(null);
    setVoiceNotice("Procesando audio de la llamada con OpenAI (transcripción y resumen)...");

    try {
      await api.processCallSummary(token, callToClose.caseId, {
        callId: callToClose.callId,
        source: "webrtc_call",
        audioBase64: recorded.audioBase64,
        mimeType: recorded.mimeType,
        durationSeconds: recorded.durationSeconds,
        applyExtractedEntities: autoApplyEntities,
      });
      setVoiceNotice(
        "Resumen IA generado e integrado al contexto omnicanal (Call Center, Bot WhatsApp y Mi Cuenta)."
      );
      await onCaseUpdated();
    } catch (err) {
      setVoiceError(
        err instanceof Error
          ? err.message
          : "No se pudo procesar el resumen IA de la llamada."
      );
    } finally {
      setProcessingAi(false);
    }
  };

  // Stream SSE de señalización WebRTC para asesores
  useEffect(() => {
    if (!token) return;
    const es = new EventSource(
      `${getApiBaseUrl()}/api/voice/stream/advisor?token=${encodeURIComponent(token)}`
    );

    es.addEventListener("incoming_call", (evt) => {
      try {
        const call = JSON.parse((evt as MessageEvent).data) as IncomingVoiceCall;
        setIncomingCalls((prev) => {
          if (prev.some((c) => c.callId === call.callId)) return prev;
          return [call, ...prev];
        });
        onCaseUpdated();
      } catch {
        // Ignorar
      }
    });

    es.addEventListener("ice_candidate", async (evt) => {
      try {
        const data = JSON.parse((evt as MessageEvent).data) as {
          callId: string;
          candidate?: RTCIceCandidateInit;
        };
        if (!data.candidate) return;
        if (activeCallRef.current?.callId === data.callId && pcRef.current?.remoteDescription) {
          await pcRef.current
            .addIceCandidate(new RTCIceCandidate(data.candidate))
            .catch(() => {});
        } else {
          const list = pendingIceByCallRef.current.get(data.callId) || [];
          list.push(data.candidate);
          pendingIceByCallRef.current.set(data.callId, list);
        }
      } catch {
        // Ignorar
      }
    });

    es.addEventListener("call_ended", (evt) => {
      try {
        const data = JSON.parse((evt as MessageEvent).data) as { callId: string };
        setIncomingCalls((prev) => prev.filter((c) => c.callId !== data.callId));
        if (activeCallRef.current?.callId === data.callId) {
          void finalizeAndSummarizeActiveCall(activeCallRef.current, false);
        }
      } catch {
        // Ignorar
      }
    });

    es.addEventListener("call_rejected", (evt) => {
      try {
        const data = JSON.parse((evt as MessageEvent).data) as { callId: string };
        setIncomingCalls((prev) => prev.filter((c) => c.callId !== data.callId));
      } catch {
        // Ignorar
      }
    });

    return () => {
      es.close();
    };
  }, [token]);

  useEffect(() => {
    return () => {
      cleanupPeerMedia();
    };
  }, []);

  const handleAnswerCall = async (call: IncomingVoiceCall) => {
    setVoiceError(null);
    setVoiceNotice(null);
    setSeconds(0);
    setMuted(false);

    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceError("Tu navegador no soporta audio WebRTC.");
      return;
    }

    try {
      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      localStreamRef.current = localStream;

      const pc = new RTCPeerConnection({ iceServers: getIceServers() });
      pcRef.current = pc;

      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

      // Iniciar mezclador dual para grabar voz del asesor + voz del paciente
      const recorder = new DualTrackAudioRecorder();
      recorder.start(localStream, null);
      recorderRef.current = recorder;

      pc.ontrack = (evt) => {
        const remoteStream = evt.streams[0];
        if (!remoteStream) return;
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;
          remoteAudioRef.current.play().catch(() => {});
        }
        recorderRef.current?.addStream(remoteStream);
      };

      pc.onicecandidate = (evt) => {
        if (!evt.candidate) return;
        api.sendVoiceIceCandidate(call.callId, "advisor", evt.candidate.toJSON()).catch(() => {});
      };

      await pc.setRemoteDescription(new RTCSessionDescription(call.offerSdp));

      const pending = pendingIceByCallRef.current.get(call.callId) || [];
      for (const c of pending) {
        await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
      }
      pendingIceByCallRef.current.delete(call.callId);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      await api.answerVoiceCall(token, call.callId, {
        type: answer.type,
        sdp: answer.sdp,
      });

      setIncomingCalls((prev) => prev.filter((c) => c.callId !== call.callId));
      setActiveCall(call);
      onSelectCaseById(call.caseId);
      await onCaseUpdated();
    } catch (err) {
      cleanupPeerMedia();
      if (recorderRef.current) {
        await recorderRef.current.stop().catch(() => {});
        recorderRef.current = null;
      }
      setVoiceError(
        err instanceof Error ? err.message : "No fue posible contestar la llamada WebRTC."
      );
    }
  };

  const handleRejectCall = async (call: IncomingVoiceCall) => {
    setIncomingCalls((prev) => prev.filter((c) => c.callId !== call.callId));
    await api.endVoiceCall(call.callId, "rejected").catch(() => {});
  };

  const handleToggleMute = () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const nextMuted = !muted;
    stream.getAudioTracks().forEach((t) => {
      t.enabled = !nextMuted;
    });
    setMuted(nextMuted);
  };

  const handleUploadAudioFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedCase) return;
    setProcessingAi(true);
    setVoiceError(null);
    setVoiceNotice("Transcribiendo y resumiendo archivo de audio con OpenAI...");
    try {
      const audioBase64 = await blobToBase64(file);
      await api.processCallSummary(token, selectedCase.id, {
        source: "audio_upload",
        audioBase64,
        mimeType: file.type || "audio/webm",
        applyExtractedEntities: autoApplyEntities,
      });
      setVoiceNotice("Audio procesado y resumen integrado al contexto omnicanal.");
      await onCaseUpdated();
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : "Error al procesar el archivo de audio.");
    } finally {
      setProcessingAi(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleProcessManualTranscript = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCase || !manualTranscript.trim()) return;
    setProcessingAi(true);
    setVoiceError(null);
    setVoiceNotice("Generando resumen estructurado con OpenAI...");
    try {
      await api.processCallSummary(token, selectedCase.id, {
        source: "transcript_text",
        transcriptText: manualTranscript.trim(),
        applyExtractedEntities: autoApplyEntities,
      });
      setManualTranscript("");
      setVoiceNotice("Resumen IA generado e integrado al contexto omnicanal.");
      await onCaseUpdated();
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : "Error al resumir la transcripción.");
    } finally {
      setProcessingAi(false);
    }
  };

  const handleApplyEntities = async (summaryId: string) => {
    if (!selectedCase) return;
    setApplyingId(summaryId);
    setVoiceError(null);
    try {
      await api.applyCallSummaryEntities(token, selectedCase.id, summaryId);
      setVoiceNotice("Datos detectados en la llamada aplicados al expediente.");
      await onCaseUpdated();
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : "No se pudieron aplicar las entidades.");
    } finally {
      setApplyingId(null);
    }
  };

  const callSummaries = selectedCase?.contextJson.call_summaries ?? [];

  return (
    <section className="space-y-6">
      <audio ref={remoteAudioRef} autoPlay playsInline />

      {/* 1. Llamadas WebRTC entrantes (Screen-Pop) */}
      {incomingCalls.length > 0 && (
        <ul className="border-t border-b border-[#00875A] divide-y divide-[#E4E7EB] bg-[#F7F8F9]">
          {incomingCalls.map((call) => (
            <li
              key={call.callId}
              className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-[#00875A]">
                  Llamada WebRTC entrante · Screen-Pop
                </p>
                <strong className="block text-base font-bold text-[#1F2933] mt-0.5">
                  {call.patientName}
                  {call.patientPhone ? ` · ${call.patientPhone}` : ""}
                </strong>
                <p className="text-xs text-[#52606D] mt-0.5">
                  {call.studyName || "Consulta general"}
                  {call.clinicName ? ` · ${call.clinicName}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  disabled={Boolean(activeCall)}
                  onClick={() => handleAnswerCall(call)}
                  className="h-10 px-5 bg-[#00875A] hover:bg-[#006B47] text-[#FFFFFF] text-xs font-semibold transition-colors disabled:opacity-50"
                >
                  Contestar llamada
                </button>
                <button
                  type="button"
                  onClick={() => handleRejectCall(call)}
                  className="h-10 px-4 border border-[#B42318] bg-[#FFFFFF] text-[#B42318] hover:bg-[#B42318] hover:text-[#FFFFFF] text-xs font-semibold transition-colors"
                >
                  Rechazar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 2. Barra de llamada WebRTC activa */}
      {activeCall && (
        <div className="border-l-2 border-[#00875A] border-t border-b border-r border-[#E4E7EB] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-[#F7F8F9]">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-[#00875A]">
              Llamada WebRTC activa · Grabando ambas pistas para resumen IA
            </p>
            <strong className="block text-base font-bold text-[#1F2933] mt-0.5">
              {activeCall.patientName} · {formatCallDuration(seconds)}
              {muted ? " · Silenciado" : ""}
            </strong>
          </div>
          <div className="flex flex-wrap items-center gap-3 shrink-0">
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
            <button
              type="button"
              onClick={() => finalizeAndSummarizeActiveCall(activeCall, true)}
              className="h-10 px-5 border border-[#B42318] bg-[#B42318] text-[#FFFFFF] text-xs font-semibold hover:opacity-90 transition-opacity"
            >
              Colgar y resumir con IA
            </button>
          </div>
        </div>
      )}

      {voiceNotice && (
        <p className="border-l-2 border-[#00875A] pl-4 py-1 text-xs font-medium text-[#00875A]">
          {voiceNotice}
        </p>
      )}

      {voiceError && (
        <p className="border-l-2 border-[#B42318] pl-4 py-1 text-xs text-[#B42318]">{voiceError}</p>
      )}

      {/* 3. Historial de resúmenes IA de llamadas del expediente seleccionado + herramientas de respaldo */}
      {selectedCase && (
        <div className="pt-4 border-t border-[#E4E7EB] space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-[#1F2933]">
                Resúmenes IA de llamadas ({callSummaries.length})
              </h3>
              <p className="text-xs text-[#52606D]">
                Cada llamada WebRTC se transcribe y resume con OpenAI y queda disponible para
                Call Center, Bot de WhatsApp y Mi Cuenta.
              </p>
            </div>
            <div className="flex items-center gap-4">
              <label className="inline-flex items-center gap-2 text-xs text-[#52606D] cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoApplyEntities}
                  onChange={(e) => setAutoApplyEntities(e.target.checked)}
                  className="w-3.5 h-3.5 accent-[#00875A]"
                />
                Auto-aplicar estudio/clínica detectados
              </label>
              <button
                type="button"
                onClick={() => setShowManualTools((prev) => !prev)}
                className="text-xs font-semibold text-[#00875A] hover:underline"
              >
                {showManualTools ? "Ocultar respaldo" : "Subir audio / texto"}
              </button>
            </div>
          </div>

          {showManualTools && (
            <div className="border-t border-b border-[#E4E7EB] py-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-[#52606D]">
                  Respaldo si pruebas sin micrófono: sube una grabación (`.webm`, `.mp3`, `.wav`,
                  `.m4a`) o pega una transcripción.
                </p>
                <label className="px-3.5 py-2 border border-[#00875A] text-xs font-semibold text-[#00875A] hover:bg-[#00875A] hover:text-[#FFFFFF] cursor-pointer transition-colors">
                  Subir archivo de audio
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="audio/*"
                    disabled={processingAi}
                    onChange={handleUploadAudioFile}
                    className="hidden"
                  />
                </label>
              </div>

              <form onSubmit={handleProcessManualTranscript} className="space-y-3">
                <label
                  htmlFor="cc-manual-transcript"
                  className="block text-xs font-semibold text-[#1F2933]"
                >
                  Transcripción de llamada (prueba o respaldo)
                </label>
                <textarea
                  id="cc-manual-transcript"
                  rows={3}
                  value={manualTranscript}
                  onChange={(e) => setManualTranscript(e.target.value)}
                  placeholder="Ej. Paciente llama para confirmar Química Sanguínea en clínica Culiacán Centro mañana a las 08:30, pagando en línea con 10% de descuento..."
                  className="w-full border border-[#E4E7EB] p-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                />
                <button
                  type="submit"
                  disabled={processingAi || !manualTranscript.trim()}
                  className="h-9 px-4 border border-[#00875A] bg-[#00875A] text-[#FFFFFF] text-xs font-semibold hover:bg-[#006B47] transition-colors disabled:opacity-50"
                >
                  {processingAi ? "Procesando con OpenAI..." : "Procesar resumen con IA"}
                </button>
              </form>
            </div>
          )}

          {callSummaries.length > 0 && (
            <ul className="divide-y divide-[#E4E7EB] border-t border-b border-[#E4E7EB]">
              {callSummaries.map((cs) => {
                const hasEntities = Boolean(
                  cs.extractedEntities.studyCode ||
                    cs.extractedEntities.clinicId ||
                    cs.extractedEntities.preferredDate ||
                    cs.extractedEntities.preferredTime ||
                    cs.extractedEntities.paymentMethod
                );
                return (
                  <li key={cs.id} className="py-4 space-y-3 text-xs">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-semibold text-[#1F2933]">
                        Atendida por {cs.advisorName}
                        {cs.durationSeconds ? ` · ${formatCallDuration(cs.durationSeconds)}` : ""} ·{" "}
                        <strong className="text-[#00875A]">
                          Sentimiento: {SENTIMENT_LABEL[cs.sentiment]}
                        </strong>
                      </p>
                      <time dateTime={cs.createdAt} className="font-mono text-[11px] text-[#52606D]">
                        {formatDateTime(cs.createdAt)} · {cs.aiProcessed ? "OpenAI" : "Respaldo"}
                      </time>
                    </div>

                    <p className="text-sm text-[#1F2933] leading-relaxed">{cs.summary}</p>

                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                      {cs.agreements.length > 0 && (
                        <div>
                          <dt className="font-semibold text-[#00875A]">Acuerdos</dt>
                          <dd className="mt-1">
                            <ul className="list-disc pl-4 space-y-0.5 text-[#52606D]">
                              {cs.agreements.map((a, i) => (
                                <li key={i}>{a}</li>
                              ))}
                            </ul>
                          </dd>
                        </div>
                      )}
                      {cs.pendingActions.length > 0 && (
                        <div>
                          <dt className="font-semibold text-[#1F2933]">Pendientes</dt>
                          <dd className="mt-1">
                            <ul className="list-disc pl-4 space-y-0.5 text-[#52606D]">
                              {cs.pendingActions.map((p, i) => (
                                <li key={i}>{p}</li>
                              ))}
                            </ul>
                          </dd>
                        </div>
                      )}
                    </dl>

                    {hasEntities && selectedCase.currentState !== "CITA_CONFIRMADA" && (
                      <div className="pt-2 flex flex-wrap items-center justify-between gap-3 border-t border-[#E4E7EB]">
                        <p className="text-[#52606D]">
                          Entidades detectadas:{" "}
                          <strong className="text-[#1F2933]">
                            {[
                              cs.extractedEntities.studyCode,
                              cs.extractedEntities.clinicId,
                              cs.extractedEntities.preferredDate,
                              cs.extractedEntities.preferredTime,
                              cs.extractedEntities.paymentMethod,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </strong>
                        </p>
                        <button
                          type="button"
                          disabled={applyingId === cs.id}
                          onClick={() => handleApplyEntities(cs.id)}
                          className="px-3 py-1.5 border border-[#00875A] text-xs font-semibold text-[#00875A] hover:bg-[#00875A] hover:text-[#FFFFFF] transition-colors disabled:opacity-50"
                        >
                          {applyingId === cs.id
                            ? "Aplicando..."
                            : "Aplicar datos al trámite"}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};
