import React from "react";
import { AbsoluteFill, Audio, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import { C, FPS, sans } from "./theme";
import marks from "./walk-marks.json";
import durations from "./walk-durations.json";

export type WalkScene = { id: string; say: string };

const caption = (s: string) =>
  s
    .replace(/soltao dot x y z/g, "soltao.xyz")
    .replace(/a quarter of one percent/g, "0.25%")
    .replace(/point oh oh three five/g, "0.0035")
    .replace(/step three/g, "step 3")
    .replace(/seven and thirty day/g, "7-day and 30-day");

/** One sentence at a time, held through the end of the scene. */
const Captions: React.FC<{ text: string; frames: number }> = ({ text, frames }) => {
  const frame = useCurrentFrame();
  const parts = text.match(/[^.?!]+[.?!]?/g)?.map((p) => p.trim()).filter(Boolean) ?? [text];
  const total = parts.reduce((s, p) => s + p.length, 0) || 1;
  let t = 0;
  let current = parts[0];
  for (const p of parts) {
    const len = (p.length / total) * frames;
    if (frame >= t) current = p;
    t += len;
  }
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "36px 140px 20px", background: "linear-gradient(to top, rgba(11,11,12,0.94) 0%, rgba(11,11,12,0.78) 70%, rgba(11,11,12,0) 100%)", display: "flex", justifyContent: "center" }}>
      <div style={{ color: C.ink, fontFamily: sans, fontSize: 28, lineHeight: 1.3, fontWeight: 600, textAlign: "center", maxWidth: 1180, textShadow: "0 1px 2px rgba(0,0,0,0.65)" }}>
        {caption(current)}
      </div>
    </div>
  );
};

type Marks = { end: number; scenes: { id: string; at: number }[]; cursor?: { t: number; x: number; y: number }[] };

const cursorAt = (time: number, pts: { t: number; x: number; y: number }[]) => {
  if (!pts.length) return null;
  let prev = pts[0];
  for (const p of pts) {
    if (p.t > time) {
      const u = Math.min(1, Math.max(0, (time - prev.t) / Math.min(0.22, Math.max(0.001, p.t - prev.t))));
      const e = 1 - (1 - u) ** 3;
      return { x: prev.x + (p.x - prev.x) * e, y: prev.y + (p.y - prev.y) * e };
    }
    prev = p;
  }
  return { x: prev.x, y: prev.y };
};

export const Walk: React.FC<{ scenes: WalkScene[]; durations: Record<string, number> }> = ({ scenes, durations: dur }) => {
  const m = marks as Marks;
  const frame = useCurrentFrame();
  const dot = cursorAt(frame / FPS, m.cursor ?? []);
  return (
    <AbsoluteFill style={{ background: C.ground }}>
      <OffthreadVideo src={staticFile("footage/demo-walk.mp4")} muted style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      {dot && (
        <div style={{ position: "absolute", left: dot.x, top: dot.y, width: 22, height: 22, marginLeft: -11, marginTop: -11, borderRadius: "50%", border: "2px solid #f1efec", boxShadow: "0 0 0 5px rgba(219,134,81,0.45)", pointerEvents: "none" }} />
      )}
      {scenes.map((s, i) => {
        const at = m.scenes.find((x) => x.id === s.id)?.at ?? 0;
        const next = m.scenes[i + 1]?.at ?? m.end;
        const span = Math.max(1, Math.round((next - at) * FPS));
        const speech = Math.max(1, Math.ceil((dur[s.id] ?? 4) * FPS));
        return (
          <Sequence key={s.id} from={Math.round(at * FPS)} durationInFrames={span}>
            <Captions text={s.say} frames={speech} />
            <Sequence durationInFrames={speech}>
              <Audio src={staticFile(`audio/walk/${s.id}.mp3`)} />
            </Sequence>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

export const walkFrames = Math.ceil((marks as Marks).end * FPS);
