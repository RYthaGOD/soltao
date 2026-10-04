import { loadFont } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

export const { fontFamily: sans } = loadFont("normal", { weights: ["400", "600", "800"], subsets: ["latin"] });
export const { fontFamily: mono } = loadMono("normal", { weights: ["500", "700"], subsets: ["latin"] });

// The submission packet's palette: warm near-black, teal for trust, copper for emphasis.
export const C = {
  ground: "#0b0b0c",
  panel: "#131315",
  line: "rgba(255,255,255,0.10)",
  ink: "#f1efec",
  ink2: "#b0ada9",
  teal: "#2ccab5",
  copper: "#db8651",
  amber: "#eec04c",
};
export const FPS = 30;
