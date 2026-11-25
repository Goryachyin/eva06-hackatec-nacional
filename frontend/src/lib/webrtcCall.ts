/**
 * Utilidades WebRTC y mezclador de audio bidireccional (Asesor + Paciente)
 * para llamadas en tiempo real y transcripción posterior con OpenAI.
 */

export function getIceServers(): RTCIceServer[] {
  const custom = import.meta.env.VITE_WEBRTC_ICE_SERVERS as string | undefined;
  if (custom) {
    try {
      const parsed = JSON.parse(custom) as RTCIceServer[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // Fallback a STUN público
    }
  }
  return [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];
}

export function formatCallDuration(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const clean = result.includes(",") ? result.split(",").pop() || "" : result;
      resolve(clean);
    };
    reader.onerror = () => reject(new Error("No se pudo leer el archivo de audio."));
    reader.readAsDataURL(blob);
  });
}

function pickSupportedRecorderMime(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const mime of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return "";
}

/**
 * Mezcla en una sola pista de audio el micrófono local (asesor) y la pista remota (paciente)
 * usando Web Audio API, grabando la conversación completa con MediaRecorder.
 */
export class DualTrackAudioRecorder {
  private audioCtx: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private connectedTrackIds = new Set<string>();
  private startedAt = 0;
  private mimeType = "audio/webm";

  start(localStream: MediaStream, remoteStream?: MediaStream | null): void {
    const AudioCtxCtor =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioCtx = new AudioCtxCtor();
    this.destination = this.audioCtx.createMediaStreamDestination();
    this.chunks = [];
    this.connectedTrackIds.clear();
    this.startedAt = Date.now();

    this.addStream(localStream);
    if (remoteStream) {
      this.addStream(remoteStream);
    }

    const chosenMime = pickSupportedRecorderMime();
    this.mimeType = chosenMime || "audio/webm";
    this.recorder = chosenMime
      ? new MediaRecorder(this.destination.stream, { mimeType: chosenMime })
      : new MediaRecorder(this.destination.stream);

    this.recorder.ondataavailable = (evt) => {
      if (evt.data && evt.data.size > 0) {
        this.chunks.push(evt.data);
      }
    };
    this.recorder.start(1000);
  }

  addStream(stream: MediaStream): void {
    if (!this.audioCtx || !this.destination) return;
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    const newTracks = audioTracks.filter((t) => !this.connectedTrackIds.has(t.id));
    if (newTracks.length === 0) return;
    for (const t of newTracks) this.connectedTrackIds.add(t.id);

    const subStream = new MediaStream(newTracks);
    const source = this.audioCtx.createMediaStreamSource(subStream);
    source.connect(this.destination);
  }

  async stop(): Promise<{
    audioBase64: string;
    mimeType: string;
    durationSeconds: number;
  } | null> {
    const rec = this.recorder;
    if (!rec) {
      this.cleanup();
      return null;
    }

    const durationSeconds = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));

    const blob = await new Promise<Blob>((resolve) => {
      rec.onstop = () => {
        resolve(new Blob(this.chunks, { type: this.mimeType }));
      };
      if (rec.state !== "inactive") {
        rec.stop();
      } else {
        resolve(new Blob(this.chunks, { type: this.mimeType }));
      }
    });

    this.cleanup();

    if (blob.size < 100) return null;
    const audioBase64 = await blobToBase64(blob);
    return {
      audioBase64,
      mimeType: this.mimeType,
      durationSeconds,
    };
  }

  private cleanup(): void {
    this.recorder = null;
    this.destination = null;
    this.connectedTrackIds.clear();
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }
}
