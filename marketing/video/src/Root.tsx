import React from "react";
import { Composition } from "remotion";
import { Live, liveFrames, LiveScene } from "./Live";
import { Walk, walkFrames, WalkScene } from "./Walk";
import live from "../scripts/live.json";
import liveDur from "./live-durations.json";
import { Narrated, Scene, totalFrames } from "./Narrated";
import { FPS } from "./theme";
import security from "../scripts/security.json";
import securityDur from "./security-durations.json";

import demo from "../scripts/demo.json";
import demoDur from "./demo-durations.json";
import pitch from "../scripts/pitch.json";
import pitchDur from "./pitch-durations.json";
import tech from "../scripts/tech.json";
import techDur from "./tech-durations.json";
import walk from "../scripts/walk.json";
import walkDur from "./walk-durations.json";

const secScenes = security as Scene[];
const demoScenes = demo as Scene[];
const pitchScenes = pitch as Scene[];
const techScenes = tech as Scene[];
const liveScenes = live as LiveScene[];
const walkScenes = walk as WalkScene[];

export const Root: React.FC = () => (
  <>
    <Composition
      id="Security"
      component={Narrated}
      durationInFrames={totalFrames(secScenes, securityDur)}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{ scenes: secScenes, durations: securityDur as Record<string, number>, name: "security", label: "security" }}
    />
    <Composition
      id="Demo"
      component={Narrated}
      durationInFrames={totalFrames(demoScenes, demoDur)}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{ scenes: demoScenes, durations: demoDur as Record<string, number>, name: "demo", label: "demo" }}
    />
    <Composition
      id="Pitch"
      component={Narrated}
      durationInFrames={totalFrames(pitchScenes, pitchDur)}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{ scenes: pitchScenes, durations: pitchDur as Record<string, number>, name: "pitch", label: "pitch" }}
    />
    <Composition
      id="Live"
      component={Live}
      durationInFrames={liveFrames}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{ scenes: liveScenes, durations: liveDur as Record<string, number> }}
    />
    <Composition
      id="Walk"
      component={Walk}
      durationInFrames={walkFrames}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{ scenes: walkScenes, durations: walkDur as Record<string, number> }}
    />
    <Composition
      id="Tech"
      component={Narrated}
      durationInFrames={totalFrames(techScenes, techDur)}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{ scenes: techScenes, durations: techDur as Record<string, number>, name: "tech", label: "how it works" }}
    />
  </>
);
