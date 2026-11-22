import AVFoundation
import Capacitor
import Foundation

/// Captures the microphone natively for dictation and voice mode.
///
/// In this app WKWebView's getUserMedia → Web Audio path delivered no audio:
/// the microphone indicator was lit, yet the capture worklet never produced a
/// chunk, so record mode sat at 0:00 (device reports 1.2.233 and 1.2.370),
/// while Mobile Safari on the same phone worked with the same web code. The
/// web capture therefore asks this plugin first on iOS, through the host
/// primitive installed by `apps/mobile/src/nativeAudioCapture.ts`.
///
/// The plugin converts the hardware input to 16-bit little-endian mono PCM at
/// the requested rate and emits fixed-size base64 chunks to the page. Native
/// code keeps nothing and sends nothing anywhere else.
@objc(PolythAudioCapturePlugin)
final class PolythAudioCapturePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "PolythAudioCapturePlugin"
    let jsName = "PolythAudioCapture"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
    ]

    private enum CaptureError: LocalizedError {
        case format
        case noInput

        var errorDescription: String? {
            switch self {
            case .format: return "The microphone format cannot be converted"
            case .noInput: return "No microphone input is available"
            }
        }
    }

    /// Every piece of capture state below is touched only on this queue.
    private let queue = DispatchQueue(label: "com.polyth.mobile.audio-capture", qos: .userInitiated)
    private var engine: AVAudioEngine?
    private var outputFormat: AVAudioFormat?
    private var pending = Data()
    private var chunkBytes = 1_280
    /// Bumped whenever a capture ends, so a late tap or notification of an
    /// earlier capture is dropped instead of feeding the next one.
    private var captureId = 0
    private var paused = false
    private var observers: [NSObjectProtocol] = []

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    private func trusted(_ call: CAPPluginCall) -> Bool {
        let url = webView?.url
        let bundled = url?.scheme?.lowercased() == "capacitor" && url?.host?.lowercased() == "localhost"
        guard bundled || PolythLinkPlugin.ownsCurrentProxy(url) else {
            call.reject("forbidden", "forbidden")
            return false
        }
        return true
    }

    @objc func start(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        let rate = Double(call.getInt("sampleRate") ?? 16_000)
        let chunkMs = max(20, min(100, call.getInt("chunkMs") ?? 40))
        guard rate >= 8_000, rate <= 48_000 else {
            call.reject("Unsupported sample rate", "invalid_argument")
            return
        }
        Self.requestRecordPermission { [weak self] granted in
            guard let self else { return }
            guard granted else {
                call.reject("Microphone permission was denied", "mic_denied")
                return
            }
            self.queue.async {
                do {
                    try self.begin(rate: rate, chunkMs: chunkMs)
                    call.resolve(["sampleRate": Int(rate), "channels": 1])
                } catch {
                    self.end()
                    call.reject(error.localizedDescription, "audio_unavailable")
                }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        queue.async {
            self.end()
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        queue.async {
            self.paused = true
            self.engine?.pause()
            call.resolve()
        }
    }

    @objc func resume(_ call: CAPPluginCall) {
        queue.async {
            guard self.paused else {
                call.resolve()
                return
            }
            self.paused = false
            if let engine = self.engine, !engine.isRunning {
                do {
                    try engine.start()
                } catch {
                    self.recover(capture: self.captureId)
                }
            }
            call.resolve()
        }
    }

    private static func requestRecordPermission(_ done: @escaping (Bool) -> Void) {
        let session = AVAudioSession.sharedInstance()
        switch session.recordPermission {
        case .granted: done(true)
        case .denied: done(false)
        default: session.requestRecordPermission { granted in done(granted) }
        }
    }

    // MARK: - Capture lifecycle (queue only)

    private func begin(rate: Double, chunkMs: Int) throws {
        end()
        guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true) else {
            throw CaptureError.format
        }
        outputFormat = format
        chunkBytes = max(1, Int((rate * Double(chunkMs) / 1_000).rounded())) * 2
        pending.removeAll(keepingCapacity: true)
        paused = false
        // Mix with whatever else plays (music, the page's own replies) and
        // keep playback on the speaker or AirPods rather than the earpiece.
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetoothA2DP])
        try session.setActive(true)
        try startEngine()
    }

    private func startEngine() throws {
        guard let output = outputFormat else { throw CaptureError.format }
        let next = AVAudioEngine()
        let input = next.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { throw CaptureError.noInput }
        guard let converter = AVAudioConverter(from: inputFormat, to: output) else { throw CaptureError.format }
        let id = captureId
        // The converter belongs to this tap alone and runs on the audio
        // thread; only the converted bytes cross to the capture queue.
        input.installTap(onBus: 0, bufferSize: 4_096, format: inputFormat) { [weak self] buffer, _ in
            guard let pcm = PolythAudioCapturePlugin.convert(buffer, with: converter, to: output) else { return }
            self?.queue.async { self?.append(pcm, capture: id) }
        }
        engine = next
        observe(next, capture: id)
        next.prepare()
        try next.start()
    }

    private func stopEngine() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
    }

    /// Ends the current capture. The audio session stays in its category:
    /// deactivating it here would cut the page's own playback (a voice-mode
    /// reply that starts the moment listening ends).
    private func end() {
        stopEngine()
        captureId += 1
        pending.removeAll()
        paused = false
    }

    /// An interruption, a route or configuration change, or a media-services
    /// reset leaves the engine stopped or invalid. Start a fresh engine on
    /// the current input; if that fails, tell the page the microphone is gone.
    /// A paused capture keeps its engine; `resume` restarts it and comes back
    /// here only if that fails.
    private func recover(capture id: Int) {
        guard id == captureId, engine != nil, !paused else { return }
        stopEngine()
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            try startEngine()
        } catch {
            end()
            notifyListeners("audioEnded", data: ["reason": "interrupted"])
        }
    }

    private func observe(_ engine: AVAudioEngine, capture id: Int) {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
            self?.queue.async { self?.recover(capture: id) }
        })
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.queue.async { self?.recover(capture: id) }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { [weak self] _ in
            self?.queue.async { self?.recover(capture: id) }
        })
    }

    private func append(_ pcm: Data, capture id: Int) {
        guard id == captureId, engine != nil, !paused else { return }
        // A navigation clears the page's listeners; never keep a microphone
        // open for a page that is gone.
        guard hasListeners("audioChunk") else {
            end()
            return
        }
        pending.append(pcm)
        while pending.count >= chunkBytes {
            let chunk = pending.prefix(chunkBytes)
            pending.removeFirst(chunkBytes)
            notifyListeners("audioChunk", data: ["data": chunk.base64EncodedString()])
        }
    }

    private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat) -> Data? {
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, out.frameLength > 0, let channel = out.int16ChannelData else { return nil }
        return Data(bytes: channel[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)
    }
}
