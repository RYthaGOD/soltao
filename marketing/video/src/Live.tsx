import React from "react";
import { AbsoluteFill, Audio, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import { C, FPS, sans } from "./theme";

export type LiveScene = { id: string; at: number; say: string };

const VIDEO_SECONDS = 63.228;

/** Sentence captions, timed across this scene's narration. */
const Captions: React.FC<{ text: string; frames: number }> = ({ text, frames }) => {
  const frame = useCurrentFrame();
  const parts = text.match(/[^.?!]+[.?!]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const total = parts.reduce((s, p) => s + p.length, 0) || 1;
  let t = 0;
  let current = parts[0];
  for (const p of parts) {
    const len = (p.length / total) * frames;
    if (frame >= t) current = p;
    t += len;
  }
  const shown = current
    .replace(/soltao dot x y z/g, "soltao.xyz")
    .replace(/a quarter of one percent/g, "0.25%")
    .replace(/point oh oh three five/g, "0.0035");
  return (
    <div style={{ position: "absolute", left: 80, right: 420, bottom: 36, display: "flex", justifyContent: "center" }}>
      <div style={{ background: "rgba(0,0,0,0.72)", color: C.ink, fontFamily: sans, fontSize: 32, lineHeight: 1.35, fontWeight: 600, padding: "12px 22px", borderRadius: 12, textAlign: "center" }}>
        {shown}
      </div>
    </div>
  );
};

export const Live: React.FC<{ scenes: LiveScene[]; durations: Record<string, number> }> = ({ scenes, durations }) => (
  <AbsoluteFill style={{ background: "#0b0b0c" }}>
    <OffthreadVideo
      src={staticFile("footage/run.mp4")}
      muted
      style={{ width: "100%", height: "100%", objectFit: "contain" }}
    />
    {scenes.map((s) => {
      const frames = Math.ceil((durations[s.id] ?? 4) * FPS);
      const from = Math.round(s.at * FPS);
      return (
        <Sequence key={s.id} from={from} durationInFrames={frames}>
          <Captions text={s.say} frames={frames} />
          <Audio src={staticFile(`audio/live/${s.id}.mp3`)} />
        </Sequence>
      );
    })}
  </AbsoluteFill>
);

export const liveFrames = Math.ceil(VIDEO_SECONDS * FPS);
