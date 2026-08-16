const fs = require("node:fs");
const path = require("node:path");

const LINUX_VIDEO_ENCODER_MODES = ["compatibility", "hardware"];
const DEFAULT_LINUX_VIDEO_ENCODER_MODE = "compatibility";
const VIDEO_ENCODER_MODE_FILE = "video-encoder-mode";

const HEVC_FEATURES = [
  "PlatformHEVCEncoderSupport",
  "WebRtcAllowH265Send",
  "WebRtcAllowH265Receive",
];

function normalizeLinuxVideoEncoderMode(value) {
  return LINUX_VIDEO_ENCODER_MODES.includes(value)
    ? value
    : DEFAULT_LINUX_VIDEO_ENCODER_MODE;
}

function mergeFeatureSwitch(current, required) {
  const features = (current ?? "")
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
  for (const feature of required) {
    if (!features.includes(feature)) features.push(feature);
  }
  return features.join(",");
}

function linuxVideoEncoderModePath(userDataPath) {
  return path.join(userDataPath, VIDEO_ENCODER_MODE_FILE);
}

function readLinuxVideoEncoderMode({ platform = process.platform, userDataPath, fsImpl = fs } = {}) {
  if (platform !== "linux" || !userDataPath) return null;
  try {
    return normalizeLinuxVideoEncoderMode(
      fsImpl.readFileSync(linuxVideoEncoderModePath(userDataPath), "utf8").trim(),
    );
  } catch {
    return DEFAULT_LINUX_VIDEO_ENCODER_MODE;
  }
}

function writeLinuxVideoEncoderMode(
  value,
  { platform = process.platform, userDataPath, fsImpl = fs } = {},
) {
  if (platform !== "linux" || !userDataPath) return false;
  const mode = normalizeLinuxVideoEncoderMode(value);
  fsImpl.mkdirSync(userDataPath, { recursive: true });
  fsImpl.writeFileSync(linuxVideoEncoderModePath(userDataPath), `${mode}\n`, { mode: 0o600 });
  return true;
}

/**
 * Configure Chromium before its GPU process starts.
 *
 * Mesa's accelerated H.264 encoder can emit keyframes without the SPS/PPS data
 * required after LiveKit E2EE transforms the frame. The former packetization-
 * mode 0 workaround selected OpenH264, but mode 0 cannot fragment the single
 * large encrypted NAL and silently drops keyframes. Compatibility mode instead
 * selects software WebRTC encoders globally and keeps H.264 packetization mode
 * 1, which survives encrypted 1080p loopback end to end.
 *
 * Hardware mode remains opt-in for people who prefer an accelerated VP8/VP9
 * path. HEVC gates are enabled in either mode, but Chromium will only advertise
 * H.265 when the Electron binary and platform encoder factory truly support it.
 */
function configureLinuxVideoEncoding({
  platform = process.platform,
  commandLine,
  mode = DEFAULT_LINUX_VIDEO_ENCODER_MODE,
} = {}) {
  if (platform !== "linux" || !commandLine) return false;
  const normalized = normalizeLinuxVideoEncoderMode(mode);
  const required = normalized === "hardware"
    ? ["AcceleratedVideoEncoder", ...HEVC_FEATURES]
    : HEVC_FEATURES;
  const features = mergeFeatureSwitch(commandLine.getSwitchValue("enable-features"), required);
  commandLine.appendSwitch("enable-features", features);
  if (normalized === "compatibility") {
    commandLine.appendSwitch("disable-webrtc-hw-encoding");
    commandLine.appendSwitch("disable-accelerated-video-encode");
  }
  return true;
}

module.exports = {
  DEFAULT_LINUX_VIDEO_ENCODER_MODE,
  HEVC_FEATURES,
  LINUX_VIDEO_ENCODER_MODES,
  configureLinuxVideoEncoding,
  mergeFeatureSwitch,
  normalizeLinuxVideoEncoderMode,
  readLinuxVideoEncoderMode,
  writeLinuxVideoEncoderMode,
};
