// vw-audio: full-duplex PCM16 mono 24 kHz audio for the Voice Wayfinder bridge.
//
// Frames are 1 byte type, 4 byte little-endian payload length, payload.
// stdin (bridge -> helper):
//   'A' u32 seq + PCM16 samples to play   'F' flush playback now (barge-in)   'Q' quit
// stdout (helper -> bridge):
//   'A' PCM16 mic samples   'P' u32 seq of the last buffer played back   'E' JSON event
//
// --voice-processing turns on macOS voice processing (echo cancellation), so
// the mic does not hear Claude's own voice through the speakers.

import AVFoundation
import Foundation

let sampleRate = 24_000.0
let voiceProcessing = CommandLine.arguments.contains("--voice-processing")

signal(SIGPIPE, SIG_IGN)

let outQueue = DispatchQueue(label: "vw-audio.out")

func writeAll(_ data: Data) {
  data.withUnsafeBytes { raw in
    guard var p = raw.baseAddress else { return }
    var left = raw.count
    while left > 0 {
      let n = write(1, p, left)
      if n <= 0 { exit(0) }  // bridge went away
      p += n
      left -= n
    }
  }
}

func send(_ type: Character, _ payload: Data) {
  var frame = Data([type.asciiValue!])
  var len = UInt32(payload.count).littleEndian
  frame.append(Data(bytes: &len, count: 4))
  frame.append(payload)
  outQueue.async { writeAll(frame) }
}

func event(_ fields: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: fields) { send("E", data) }
}

// MARK: microphone permission

let permission = DispatchSemaphore(value: 0)
var micAllowed = false
AVCaptureDevice.requestAccess(for: .audio) { granted in
  micAllowed = granted
  permission.signal()
}
permission.wait()
if !micAllowed {
  event(["type": "error", "code": "mic-denied",
         "message": "Microphone access denied. Allow it for the app that runs Claude Code in System Settings > Privacy & Security > Microphone."])
  outQueue.sync {}
  exit(2)
}

// MARK: engine

let engine = AVAudioEngine()
let input = engine.inputNode
// Voice processing works on the engine's I/O pair: both ends must exist first.
_ = engine.outputNode
_ = engine.mainMixerNode
var voiceProcessingOn = false

if voiceProcessing {
  do {
    try input.setVoiceProcessingEnabled(true)
    voiceProcessingOn = true
    if #available(macOS 14.0, *) {
      input.voiceProcessingOtherAudioDuckingConfiguration =
        AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
    }
  } catch {
    event(["type": "warning", "message": "voice processing unavailable, use headphones: \(error.localizedDescription)"])
  }
}

let player = AVAudioPlayerNode()
let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!
engine.attach(player)
engine.connect(player, to: engine.mainMixerNode, format: playFormat)

let inFormat = input.outputFormat(forBus: 0)
let monoIn = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inFormat.sampleRate, channels: 1, interleaved: false)!
let wireFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true)!
guard let micConverter = AVAudioConverter(from: monoIn, to: wireFormat) else {
  event(["type": "error", "code": "converter", "message": "cannot convert \(inFormat) to 24 kHz PCM16"])
  outQueue.sync {}
  exit(1)
}

// Starting the engine (and turning voice processing on) clicks: keep the mic
// closed for a moment so the click never reaches voice activity detection.
var micOpenAt = Date.distantFuture
let micSettle: TimeInterval = 0.6

input.installTap(onBus: 0, bufferSize: 2048, format: inFormat) { buffer, _ in
  if Date() < micOpenAt { return }
  let frames = buffer.frameLength
  guard frames > 0, let src = buffer.floatChannelData?[0] else { return }
  // Voice processing can hand over several channels; the first is the processed mic.
  guard let mono = AVAudioPCMBuffer(pcmFormat: monoIn, frameCapacity: frames) else { return }
  mono.frameLength = frames
  mono.floatChannelData![0].update(from: src, count: Int(frames))
  let capacity = AVAudioFrameCount(Double(frames) * sampleRate / inFormat.sampleRate) + 32
  guard let out = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return }
  var fed = false
  var error: NSError?
  micConverter.convert(to: out, error: &error) { _, status in
    if fed {
      status.pointee = .noDataNow
      return nil
    }
    fed = true
    status.pointee = .haveData
    return mono
  }
  if out.frameLength > 0, let samples = out.int16ChannelData?[0] {
    send("A", Data(bytes: samples, count: Int(out.frameLength) * 2))
  }
}

// MARK: playback

let playLock = NSLock()
var generation = 0
var pending = 0

func play(seq: UInt32, pcm: Data) {
  let count = pcm.count / 2
  guard count > 0, let buffer = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(count)) else { return }
  buffer.frameLength = AVAudioFrameCount(count)
  let dst = buffer.floatChannelData![0]
  pcm.withUnsafeBytes { raw in
    let src = raw.bindMemory(to: Int16.self)
    for i in 0..<count { dst[i] = Float(Int16(littleEndian: src[i])) / 32768 }
  }
  playLock.lock()
  pending += 1
  let gen = generation
  playLock.unlock()
  player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in
    playLock.lock()
    defer { playLock.unlock() }
    guard gen == generation else { return }
    pending -= 1
    var s = seq.littleEndian
    send("P", Data(bytes: &s, count: 4))
  }
  if !player.isPlaying { player.play() }
}

func flush() {
  playLock.lock()
  generation += 1
  pending = 0
  playLock.unlock()
  player.stop()
  event(["type": "flushed"])
}

// Turning voice processing on reconfigures the engine once right after start:
// restart in place. A later change (headphones in or out) invalidates the
// formats above: exit and let the bridge start a fresh helper.
var readyAt = Date.distantFuture
NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { _ in
  if Date().timeIntervalSince(readyAt) < 1.5 || readyAt == .distantFuture {
    if !engine.isRunning {
      // The reconfigure drops the playback chain; without this nothing plays.
      engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil)
      engine.connect(player, to: engine.mainMixerNode, format: playFormat)
      try? engine.start()
    }
    if engine.isRunning {
      micOpenAt = Date().addingTimeInterval(micSettle)
      player.play()
      return
    }
  }
  event(["type": "device-changed"])
  outQueue.sync {}
  exit(3)
}

do {
  try engine.start()
} catch {
  if voiceProcessingOn {
    // Some device setups refuse voice processing: carry on without it, and say so.
    event(["type": "warning", "message": "Echo cancellation could not start (\(error.localizedDescription)); use headphones so barge-in does not hear Claude."])
    outQueue.sync {}
    exit(4)
  }
  event(["type": "error", "code": "engine", "message": "audio engine failed to start: \(error.localizedDescription)"])
  outQueue.sync {}
  exit(1)
}
player.play()
readyAt = Date()
micOpenAt = readyAt.addingTimeInterval(micSettle)
event(["type": "ready", "inputRate": inFormat.sampleRate, "inputChannels": inFormat.channelCount, "voiceProcessing": voiceProcessingOn])

// MARK: stdin

Thread {
  var buffer = Data()
  let stdin = FileHandle.standardInput
  while true {
    let chunk = stdin.availableData
    if chunk.isEmpty { exit(0) }
    buffer.append(chunk)
    while buffer.count >= 5 {
      let type = buffer[buffer.startIndex]
      let len = buffer.subdata(in: buffer.startIndex + 1 ..< buffer.startIndex + 5)
        .withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))) }
      guard buffer.count >= 5 + len else { break }
      let payload = buffer.subdata(in: buffer.startIndex + 5 ..< buffer.startIndex + 5 + len)
      buffer.removeSubrange(buffer.startIndex ..< buffer.startIndex + 5 + len)
      switch Character(UnicodeScalar(type)) {
      case "A" where payload.count >= 4:
        let seq = payload.prefix(4).withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) }
        play(seq: seq, pcm: payload.subdata(in: payload.startIndex + 4 ..< payload.endIndex))
      case "F":
        flush()
      case "Q":
        engine.stop()
        outQueue.sync {}
        exit(0)
      default:
        break
      }
    }
  }
}.start()

dispatchMain()
