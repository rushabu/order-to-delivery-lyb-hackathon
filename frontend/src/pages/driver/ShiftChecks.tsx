import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, CheckCircle, IdentificationCard, Microphone, UploadSimple, Warning } from "@phosphor-icons/react";
import { useDriverChecks, usePassCheck } from "../../api/ops";
import { Button } from "../../components/ui";
import { checkLicenceText } from "../../lib/licence";
import { DEMO_MODE } from "../../lib/env";
import { Column } from "./DriverTrip";

/*
  Start-of-shift checks, before the trip screen: 1) the driving licence, scanned with the device camera
  (or a photo of it) and read in this browser; 2) a live voice check, reading a random phrase aloud.
  Privacy: the licence image and its text, and the microphone audio, never leave the device and are
  discarded straight after the check. The API stores only "passed" and the time.
*/
export function ShiftChecks() {
  const checks = useDriverChecks();
  const licenceDone = !!checks.data?.licence_at;
  return (
    <Column>
      <header>
        <p className="text-meta font-semibold text-muted">Before you drive</p>
        <h1 className="mt-1 text-[1.75rem] font-[750] leading-tight tracking-[-0.02em]">Two quick checks</h1>
        <p className="mt-2 text-body text-ink-2">Valid for 12 hours. Nothing from your licence or your voice is saved or sent: only that the check passed.</p>
      </header>
      <ol className="space-y-5">
        <Step n={1} title="Scan your driving licence" done={licenceDone} active={!licenceDone}>
          {!licenceDone && <LicenceScan />}
        </Step>
        <Step n={2} title="Say the phrase on screen" done={!!checks.data?.voice_at} active={licenceDone && !checks.data?.voice_at}>
          {licenceDone && !checks.data?.voice_at && <VoiceCheck />}
        </Step>
      </ol>
    </Column>
  );
}

function Step({ n, title, done, active, children }: { n: number; title: string; done: boolean; active: boolean; children?: React.ReactNode }) {
  return (
    <li className={`border-l-4 pl-4 ${done ? "border-low" : active ? "border-accent" : "border-line"}`}>
      <p className={`flex items-center gap-2 text-lead font-semibold ${done ? "text-low" : active ? "text-ink" : "text-muted"}`}>
        {done ? <CheckCircle size={20} weight="fill" aria-hidden /> : <span className="tnum">{n}.</span>}
        {title}
        {done && <span className="sr-only">, done</span>}
      </p>
      {children && <div className="mt-3">{children}</div>}
    </li>
  );
}

/* ---------------- 1. Licence ---------------- */

type ScanState = { k: "idle" } | { k: "camera" } | { k: "reading"; progress: number } | { k: "failed"; why: string };

function LicenceScan() {
  const pass = usePassCheck();
  const [state, setState] = useState<ScanState>({ k: "idle" });
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const stopCamera = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  useEffect(() => stopCamera, []);

  async function openCamera() {
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      setState({ k: "camera" });
      requestAnimationFrame(() => {
        if (video.current && stream.current) {
          video.current.srcObject = stream.current;
          void video.current.play();
        }
      });
    } catch {
      setState({ k: "failed", why: "The camera could not be opened. Allow camera access, or use a photo of the licence instead." });
    }
  }

  /** Reads the image in this browser, then throws it away. */
  async function read(source: CanvasImageSource, w: number, h: number) {
    setState({ k: "reading", progress: 0 });
    const canvas = document.createElement("canvas");
    const g = canvas.getContext("2d")!;
    const scale = Math.min(2, 1800 / Math.max(w, h)); // OCR reads best at about 1800 px on the long side
    /** Draws the photo, optionally turned a quarter and with a filter. */
    const draw = (turn: boolean, filter: string) => {
      const [cw, ch] = [Math.round(w * scale), Math.round(h * scale)];
      canvas.width = turn ? ch : cw;
      canvas.height = turn ? cw : ch;
      g.filter = filter;
      if (turn) {
        g.translate(ch, 0);
        g.rotate(Math.PI / 2);
      }
      g.drawImage(source, 0, 0, cw, ch);
      g.setTransform(1, 0, 0, 1, 0, 0);
    };
    // Each try reads the photo differently; the first that passes wins. Sideways only for upright photos.
    const tries: { turn: boolean; filter: string; psm: string }[] = [
      { turn: false, filter: "none", psm: "3" },
      { turn: false, filter: "grayscale(1) contrast(1.6)", psm: "11" },
      ...(h > w ? [{ turn: true, filter: "grayscale(1) contrast(1.6)", psm: "11" }] : []),
    ];
    try {
      const { createWorker } = await import("tesseract.js");
      let step = 0;
      const worker = await createWorker("eng", 1, {
        logger: (m) => m.status === "recognizing text" && setState({ k: "reading", progress: (step + m.progress) / tries.length }),
      });
      let result = checkLicenceText("");
      try {
        for (const t of tries) {
          draw(t.turn, t.filter);
          await worker.setParameters({ tessedit_pageseg_mode: t.psm as never });
          const r = checkLicenceText((await worker.recognize(canvas)).data.text);
          result = r.ok || (r.title && !result.title) ? r : result;
          if (r.ok) break;
          step++;
        }
      } finally {
        await worker.terminate();
      }
      if (result.ok) {
        await pass.mutateAsync("LICENCE");
        setState({ k: "idle" });
      } else {
        setState({
          k: "failed",
          why: result.title
            ? "This looks like a licence, but the number and dates could not be read. Hold it flat, fill the frame, avoid glare, and try again."
            : "This does not look like a driving licence. Use the front of your licence, with the words 'Driving Licence' in view.",
        });
      }
    } catch {
      setState({ k: "failed", why: "The licence could not be read on this device. Check your connection (the text reader downloads once) and try again." });
    } finally {
      g.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = canvas.height = 0;
    }
  }

  function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const frame = document.createElement("canvas");
    frame.width = v.videoWidth;
    frame.height = v.videoHeight;
    frame.getContext("2d")!.drawImage(v, 0, 0);
    stopCamera();
    void read(frame, frame.width, frame.height).finally(() => {
      frame.width = frame.height = 0;
    });
  }

  async function fromFile(f: File | undefined) {
    if (fileInput.current) fileInput.current.value = "";
    if (!f) return;
    const bmp = await createImageBitmap(f).catch(() => null);
    if (!bmp) return setState({ k: "failed", why: "That file is not a photo this device can open. Use a JPEG or PNG." });
    await read(bmp, bmp.width, bmp.height);
    bmp.close();
  }

  if (state.k === "camera") {
    return (
      <div className="space-y-3">
        <div className="relative overflow-hidden rounded-lg bg-road">
          <video ref={video} playsInline muted className="block aspect-[4/3] w-full object-cover" aria-label="Camera preview" />
          {/* Card-shaped guide: fill it with the front of the licence */}
          <div aria-hidden className="pointer-events-none absolute inset-[12%_7%] rounded-[10px] border-2 border-dashed border-accent" />
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Button variant="primary" size="lg" onClick={capture}>
            <Camera size={20} weight="bold" aria-hidden /> Capture
          </Button>
          <Button size="lg" onClick={() => { stopCamera(); setState({ k: "idle" }); }}>
            Cancel
          </Button>
        </div>
        <p className="text-meta text-muted">Fill the dashed frame with the front of the licence. Avoid glare.</p>
      </div>
    );
  }
  if (state.k === "reading") {
    return (
      <div role="status" className="space-y-2">
        <p className="flex items-center gap-2 text-body font-medium">
          <IdentificationCard size={18} weight="bold" aria-hidden /> Reading the licence on this device…
        </p>
        <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
          <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${Math.round(state.progress * 100)}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {state.k === "failed" && (
        <p role="alert" className="flex gap-2 border-l-4 border-high bg-high-soft px-3 py-2.5 text-body text-high">
          <Warning size={18} weight="bold" aria-hidden className="mt-0.5 shrink-0" /> {state.why}
        </p>
      )}
      <Button variant="primary" size="xl" onClick={openCamera} disabled={pass.isPending}>
        <Camera size={22} weight="bold" aria-hidden /> Scan with camera
      </Button>
      <Button size="lg" className="w-full" onClick={() => fileInput.current?.click()} disabled={pass.isPending}>
        <UploadSimple size={18} weight="bold" aria-hidden /> Use a photo instead
      </Button>
      <input ref={fileInput} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void fromFile(e.target.files?.[0])} />
    </div>
  );
}

/* ---------------- 2. Voice ---------------- */

const WORDS = ["amber", "river", "harbour", "pepper", "tiger", "mango", "silver", "copper", "lotus", "falcon", "orange", "garden", "rocket", "window", "pencil", "monsoon"];
interface SR {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}
const w = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : {};
const SpeechRec = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => SR) | undefined;

function pickPhrase() {
  const a = WORDS[Math.floor(Math.random() * WORDS.length)];
  let b = a;
  while (b === a) b = WORDS[Math.floor(Math.random() * WORDS.length)];
  return { words: [a, b], text: `Ready to drive, ${a} ${b}` };
}

type VoiceState = { k: "idle" } | { k: "listening"; level: number; heard: string } | { k: "failed"; why: string };

/**
  Live voice check. Where the browser can transcribe speech, the two random words must be heard.
  Elsewhere it falls back to detecting a sustained voice on the microphone while the phrase is shown.
  Either way the phrase changes every attempt, so a recording cannot simply be replayed.
*/
function VoiceCheck() {
  const pass = usePassCheck();
  const [phrase, setPhrase] = useState(pickPhrase);
  const [state, setState] = useState<VoiceState>({ k: "idle" });
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);
  const method = useMemo(() => (SpeechRec ? "words" : "voice"), []);

  async function start() {
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return setState({ k: "failed", why: "The microphone could not be opened. Allow microphone access and try again." });
    }
    // Level meter, and the fallback check: how long a voice stays above the room's noise.
    const audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    audio.createMediaStreamSource(mic).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let voicedMs = 0;
    let last = performance.now();
    let raf = 0;
    let rec: SR | null = null;
    let done = false;
    const timer = setTimeout(
      () => finish(false, method === "words" ? "The two words were not heard clearly. Try again, a little closer to the device." : "No clear voice was heard. Read the phrase aloud, close to the device."),
      9000,
    );
    cleanup.current = () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      try {
        rec?.stop();
      } catch {
        /* already stopped */
      }
      mic.getTracks().forEach((t) => t.stop());
      void audio.close();
    };
    function finish(ok: boolean, why = "") {
      if (done) return;
      done = true;
      cleanup.current();
      if (ok) void pass.mutateAsync("VOICE");
      else {
        setState({ k: "failed", why });
        setPhrase(pickPhrase());
      }
    }
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const x of buf) sum += x * x;
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (rms > 0.03) voicedMs += now - last;
      last = now;
      setState((s) => (s.k === "listening" ? { ...s, level: Math.min(1, rms * 12) } : s));
      if (!rec && voicedMs > 1500) return finish(true);
      raf = requestAnimationFrame(tick);
    };
    setState({ k: "listening", level: 0, heard: "" });
    raf = requestAnimationFrame(tick);

    if (SpeechRec) {
      rec = new SpeechRec();
      rec.lang = "en-IN";
      rec.interimResults = true;
      rec.maxAlternatives = 3;
      rec.onresult = (e) => {
        const heard = Array.from(e.results)
          .map((r) => Array.from(r).map((a) => a.transcript).join(" "))
          .join(" ")
          .toLowerCase();
        setState((s) => (s.k === "listening" ? { ...s, heard } : s));
        if (phrase.words.every((word) => heard.includes(word))) finish(true);
      };
      rec.onerror = (e) => {
        // Speech service blocked or offline: fall back to the voice-level check.
        if (["not-allowed", "service-not-allowed", "network"].includes(e.error)) rec = null;
      };
      try {
        rec.start();
      } catch {
        rec = null;
      }
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-body text-ink-2">Tap start, then read this aloud:</p>
      <p className="wide border-y-2 border-ink py-3 text-center text-[1.5rem] font-[800] leading-tight tracking-[-0.02em]" aria-live="polite">
        “{phrase.text}”
      </p>
      {state.k === "listening" ? (
        <div role="status" className="space-y-2">
          <p className="flex items-center gap-2 text-body font-medium">
            <Microphone size={18} weight="fill" aria-hidden className="text-high" /> Listening…
          </p>
          <div aria-hidden className="flex h-8 items-end gap-1">
            {Array.from({ length: 16 }, (_, i) => (
              <span key={i} className="w-full rounded-sm bg-accent transition-[height] duration-75" style={{ height: `${Math.max(8, Math.min(100, state.level * 100 * (0.6 + 0.4 * Math.abs(Math.sin(i * 1.7)))))}%` }} />
            ))}
          </div>
          {state.heard && <p className="text-meta text-muted">Heard: {state.heard}</p>}
        </div>
      ) : (
        <>
          {state.k === "failed" && (
            <p role="alert" className="flex gap-2 border-l-4 border-high bg-high-soft px-3 py-2.5 text-body text-high">
              <Warning size={18} weight="bold" aria-hidden className="mt-0.5 shrink-0" /> {state.why} A new phrase is shown.
            </p>
          )}
          <Button variant="primary" size="xl" onClick={start} disabled={pass.isPending}>
            <Microphone size={22} weight="bold" aria-hidden /> {pass.isPending ? "Saving…" : "Start voice check"}
          </Button>
          <p className="text-meta text-muted">
            {method === "words" ? `The words "${phrase.words[0]}" and "${phrase.words[1]}" must be heard.` : "This browser cannot transcribe speech, so it checks that a live voice reads for a moment."} Audio is not recorded.
          </p>
          {/* Demo only: lets a presentation continue if the microphone fails. Not shown outside demo mode. */}
          {DEMO_MODE && (
            <button type="button" onClick={() => void pass.mutateAsync("VOICE")} disabled={pass.isPending} className="self-start text-body font-semibold text-accent-ink underline underline-offset-4 hover:no-underline disabled:opacity-50">
              Skip voice check (demo)
            </button>
          )}
        </>
      )}
    </div>
  );
}
