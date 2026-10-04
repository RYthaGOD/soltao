import React from "react";
import { AbsoluteFill, Audio, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig, OffthreadVideo } from "remotion";
import { C, FPS, mono, sans } from "./theme";

export type Scene = {
  id: string;
  title: string;
  say: string;
  sub?: string;
  points?: string[];
  stat?: string;
  statSub?: string;
  image?: string; // file in public/, e.g. "footage/step1.png"
  portrait?: string; // square photo in public/, shown in place of the logo
  video?: string; // file in public/, e.g. "footage/run.mp4"
  videoStart?: number; // seconds into the clip
};

const PAD = 0.7; // seconds of breathing room after each line of narration
export const sceneFrames = (dur: number) => Math.ceil((dur + PAD) * FPS);

const ease = (frame: number, delay = 0) => spring({ frame: frame - delay, fps: FPS, config: { damping: 200 } });

/** Sentence captions, timed in proportion to each sentence's length. */
const Captions: React.FC<{ text: string; frames: number }> = ({ text, frames }) => {
  const frame = useCurrentFrame();
  const parts = text.match(/[^.?!]+[.?!]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const speech = frames - PAD * FPS;
  let t = 0;
  let current = parts[0];
  for (const p of parts) {
    const len = (p.length / total) * speech;
    if (frame >= t) current = p;
    t += len;
  }
  return (
    <div style={{ position: "absolute", left: 160, right: 160, bottom: 70, display: "flex", justifyContent: "center" }}>
      <div style={{ background: "rgba(0,0,0,0.62)", color: C.ink, fontFamily: sans, fontSize: 34, lineHeight: 1.35, padding: "14px 26px", borderRadius: 12, textAlign: "center" }}>
        {current
          .replace(/soltao dot x y z/g, "soltao.xyz")
          .replace(/a quarter of one percent/g, "0.25%")
          .replace(/point oh oh three five/g, "0.0035")
          .replace(/zero point two five percent/g, "0.25%")
          .replace(/zero point zero zero three five/g, "0.0035")
          .replace(/zero point zero zero three/g, "0.003")
          .replace(/twenty nine out of twenty nine/g, "29 out of 29")
          .replace(/two percent/g, "2%")
          .replace(/twelve word/g, "12-word")
          .replace(/moneybag fin/g, "@moneybag_fin")}
      </div>
    </div>
  );
};

const Backdrop: React.FC = () => {
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 90) * 40;
  return (
    <AbsoluteFill style={{ background: C.ground }}>
      <div style={{ position: "absolute", width: 1400, height: 1400, left: 900 + drift, top: -600, borderRadius: "50%", background: "radial-gradient(circle, rgba(44,202,181,0.13), rgba(44,202,181,0) 60%)" }} />
      <div style={{ position: "absolute", width: 1100, height: 1100, left: -400, top: 500 - drift, borderRadius: "50%", background: "radial-gradient(circle, rgba(219,134,81,0.10), rgba(219,134,81,0) 60%)" }} />
    </AbsoluteFill>
  );
};

const Header: React.FC<{ index: number; count: number; label: string }> = ({ index, count, label }) => (
  <div style={{ position: "absolute", left: 128, right: 128, top: 64, display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: mono, fontSize: 24, color: C.ink2 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <Img src={staticFile("logo.png")} style={{ width: 44, height: 44, borderRadius: 10 }} />
      <span>soltao · {label}</span>
    </div>
    <span>{String(index).padStart(2, "0")} / {String(count).padStart(2, "0")}</span>
  </div>
);

const Body: React.FC<{ s: Scene }> = ({ s }) => {
  const frame = useCurrentFrame();
  const t = ease(frame);
  const titleStyle: React.CSSProperties = { fontFamily: sans, fontWeight: 800, color: C.ink, letterSpacing: -2, opacity: t, transform: `translateY(${(1 - t) * 30}px)` };

  if (s.stat) {
    const n = ease(frame, 12);
    return (
      <AbsoluteFill style={{ padding: "200px 128px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 28 }}>
        <h1 style={{ ...titleStyle, fontSize: 76, margin: 0 }}>{s.title}</h1>
        <div style={{ fontFamily: sans, fontWeight: 800, fontSize: 240, color: C.teal, opacity: n, transform: `scale(${0.9 + n * 0.1})`, transformOrigin: "left center" }}>{s.stat}</div>
        <p style={{ fontFamily: sans, fontSize: 44, color: C.ink2, margin: 0, opacity: ease(frame, 24) }}>{s.statSub}</p>
      </AbsoluteFill>
    );
  }

  if (s.video || s.image) {
    const m = ease(frame, 8);
    return (
      <AbsoluteFill style={{ padding: "150px 128px 210px", display: "flex", flexDirection: "column", gap: 28 }}>
        <h1 style={{ ...titleStyle, fontSize: 64, margin: 0 }}>{s.title}</h1>
        <div style={{ flex: 1, borderRadius: 20, overflow: "hidden", border: `2px solid ${C.line}`, background: C.panel, opacity: m, transform: `translateY(${(1 - m) * 40}px)`, display: "flex", justifyContent: "center" }}>
          {s.video ? (
            <OffthreadVideo src={staticFile(s.video)} startFrom={Math.round((s.videoStart ?? 0) * FPS)} muted style={{ height: "100%", objectFit: "contain" }} />
          ) : (
            <Img src={staticFile(s.image!)} style={{ height: "100%", objectFit: "contain" }} />
          )}
        </div>
      </AbsoluteFill>
    );
  }

  if (!s.points) {
    const l = ease(frame, 6);
    return (
      <AbsoluteFill style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 36 }}>
        <Img src={staticFile(s.portrait ?? "logo.png")} style={{ width: 280, height: 280, borderRadius: 36, objectFit: "cover", opacity: l, transform: `scale(${0.85 + l * 0.15})`, boxShadow: s.portrait ? "0 0 0 3px rgba(44,202,181,0.45)" : undefined }} />
        <h1 style={{ ...titleStyle, fontSize: 110, margin: 0, textAlign: "center" }}>{s.title}</h1>
        {s.sub && <p style={{ fontFamily: sans, fontSize: 44, color: C.teal, margin: 0, opacity: ease(frame, 18) }}>{s.sub}</p>}
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ padding: "210px 128px 200px", display: "flex", flexDirection: "column", gap: 56 }}>
      <h1 style={{ ...titleStyle, fontSize: 84, margin: 0 }}>{s.title}</h1>
      <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
        {s.points.map((raw, i) => {
          const a = ease(frame, 20 + i * 40);
          const bad = raw.startsWith("!");
          const p = bad ? raw.slice(1) : raw;
          const tone = bad ? C.copper : C.teal;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 28, opacity: a, transform: `translateX(${(1 - a) * 40}px)` }}>
              <div style={{ width: 52, height: 52, borderRadius: 14, background: bad ? "rgba(219,134,81,0.14)" : "rgba(44,202,181,0.14)", border: `2px solid ${tone}`, display: "grid", placeItems: "center", color: tone, fontFamily: mono, fontWeight: 700, fontSize: 26 }}>{bad ? "✕" : "✓"}</div>
              <span style={{ fontFamily: sans, fontSize: 48, color: C.ink, fontWeight: 600 }}>{p}</span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

export const Narrated: React.FC<{ scenes: Scene[]; durations: Record<string, number>; name: string; label: string }> = ({ scenes, durations, name, label }) => {
  const { durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();
  let from = 0;
  return (
    <AbsoluteFill style={{ background: C.ground }}>
      <Backdrop />
      {scenes.map((s, i) => {
        const len = sceneFrames(durations[s.id] ?? 5);
        const start = from;
        from += len;
        return (
          <Sequence key={s.id} from={start} durationInFrames={len} premountFor={FPS}>
            <SceneFade len={len}>
              <Header index={i + 1} count={scenes.length} label={label} />
              <Body s={s} />
              <Captions text={s.say} frames={len} />
            </SceneFade>
            <Audio src={staticFile(`audio/${name}/${s.id}.mp3`)} />
          </Sequence>
        );
      })}
      <div style={{ position: "absolute", left: 0, bottom: 0, height: 6, width: `${(frame / durationInFrames) * 100}%`, background: C.teal }} />
    </AbsoluteFill>
  );
};

const SceneFade: React.FC<{ len: number; children: React.ReactNode }> = ({ len, children }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, 10, len - 10, len], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

export const totalFrames = (scenes: Scene[], durations: Record<string, number>) => scenes.reduce((s, x) => s + sceneFrames(durations[x.id] ?? 5), 0);
