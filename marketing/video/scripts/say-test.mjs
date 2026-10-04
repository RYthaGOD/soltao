import fs from "node:fs"; import path from "node:path";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
const voice = process.argv[2] || "en-US-AndrewMultilingualNeural";
const tests = {
  'B1-bittensor-as-written': 'Stake on Bittensor.',
  'B2-bit-tensor': 'Stake on bit tensor.',
  'B3-bit-tenser': 'Stake on bit tenser.',
  'B4-bitt-ensor-hyphen': 'Stake on Bit-Tensor.',
  'T1-TAO-as-written': 'Stake your TAO.',
  'T2-tao': 'Stake your tao.',
  'T3-tau': 'Stake your tau.',
  'T4-tow': 'Stake your tow.',
  'T5-taow': 'Stake your taow.',
  'T6-t-ow': 'Stake your t-ow.',
};
const dir = "public/audio/say-test"; fs.mkdirSync(dir, { recursive: true });
for (const [k, t] of Object.entries(tests)) {
  const tts = new MsEdgeTTS(); await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const { audioFilePath } = await tts.toFile(dir, t); fs.renameSync(audioFilePath, path.join(dir, k + ".mp3")); tts.close();
}
console.log(fs.readdirSync(dir).join("\n"));
