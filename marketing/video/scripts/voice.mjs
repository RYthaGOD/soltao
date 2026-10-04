// Narration with Microsoft's neural voices (the ones Edge's Read Aloud uses): one MP3 per scene,
// plus durations so the video times itself to the narration.
//   node scripts/voice.mjs security [en-US-AndrewMultilingualNeural]
//   node scripts/voice.mjs samples           short sample of several voices, in public/audio/samples
import fs from "node:fs";
import path from "node:path";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { parseFile } from "music-metadata";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..");
const [name = "security", voice = "en-US-AndrewMultilingualNeural"] = process.argv.slice(2);

// How words are *spoken*. Captions keep the written spelling from the script.
// Fill in from the test clips in public/audio/say-test (node scripts/say-test.mjs).
const SAY = [
  [/soltao/gi, "Sole tao"],
  [/Bittensor/g, "bit tensor"],
  [/TAO/g, "tau"],
  [/btcli/g, "B T C L I"],
  [/OFT/g, "O F T"],
  [/\bMIT\b/g, "M.I.T."],
];
const spoken = (t) => SAY.reduce((s, [re, to]) => s.replace(re, to), t);

async function speak(rawText, voiceName, file) {
  const text = spoken(rawText);
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const { audioFilePath } = await tts.toFile(dir, text, { rate: "-4%" });
  fs.renameSync(audioFilePath, file);
  tts.close();
  return (await parseFile(file)).format.duration;
}

if (name === "samples") {
  const line = "soltao lets you stake the TAO in your Solana wallet on Bittensor. Your keys never leave your browser.";
  for (const v of ["en-US-AndrewMultilingualNeural", "en-US-BrianMultilingualNeural", "en-US-AvaMultilingualNeural", "en-US-EmmaMultilingualNeural", "en-GB-RyanNeural", "en-GB-SoniaNeural", "en-AU-WilliamMultilingualNeural"]) {
    await speak(line, v, path.join(root, "public/audio/samples", `${v}.mp3`));
    console.log("sample", v);
  }
  process.exit(0);
}

const scenes = JSON.parse(fs.readFileSync(path.join(root, "scripts", `${name}.json`), "utf8"));
const durations = {};
for (const s of scenes) {
  durations[s.id] = Math.round((await speak(s.say, voice, path.join(root, "public/audio", name, `${s.id}.mp3`))) * 1000) / 1000;
  console.log(s.id, durations[s.id]);
}
fs.writeFileSync(path.join(root, "src", `${name}-durations.json`), JSON.stringify(durations, null, 1));
console.log(`voice ${voice}, ${scenes.length} scenes, ${Object.values(durations).reduce((a, b) => a + b, 0).toFixed(1)} s of speech`);
