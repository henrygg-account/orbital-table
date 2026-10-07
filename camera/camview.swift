// Live preview of the overhead USB camera at full frame rate.
// ffmpeg can't pick the camera's MJPEG modes on macOS (it falls back to the 5 fps
// uncompressed ones), so this selects the format directly through AVFoundation.
//
// Build: swiftc -O camview.swift -o camview
// Run:   ./camview [width height fps]      default 1920 1080 25
//        ./camview --list                  print every format the camera offers

import AVFoundation
import AppKit

func fourcc(_ f: AVCaptureDevice.Format) -> String {
    let c = CMFormatDescriptionGetMediaSubType(f.formatDescription)
    let s = [24, 16, 8, 0].map { Character(UnicodeScalar(UInt8((c >> $0) & 0xff))) }
    return String(s)
}
func dims(_ f: AVCaptureDevice.Format) -> CMVideoDimensions { CMVideoFormatDescriptionGetDimensions(f.formatDescription) }
func maxFps(_ f: AVCaptureDevice.Format) -> Double { f.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0 }

let args = CommandLine.arguments.dropFirst()
let discovery = AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: .video, position: .unspecified)
let camName = ProcessInfo.processInfo.environment["CAM"] ?? "Arducam"   // CAM=iPhone ./camview for the phone
guard let device = discovery.devices.first(where: { $0.localizedName.contains(camName) }) ?? discovery.devices.first(where: { $0.localizedName.contains("iPhone") }) ?? discovery.devices.first else {
    print("No external camera found."); exit(1)
}
print("Camera: \(device.localizedName)")
let status = AVCaptureDevice.authorizationStatus(for: .video)
print("Camera permission: \(["not asked", "restricted", "denied", "granted"][status.rawValue])")
if status == .notDetermined {
    let sem = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .video) { ok in print(ok ? "Permission granted" : "Permission denied"); sem.signal() }
    sem.wait()
}

if args.first == "--list" {
    for f in device.formats {
        let d = dims(f)
        print(String(format: "  %4dx%-4d  %@  %@ fps", d.width, d.height, fourcc(f),
                     f.videoSupportedFrameRateRanges.map { String(format: "%.0f", $0.maxFrameRate) }.joined(separator: ",")))
    }
    exit(0)
}

let want = args.compactMap { Int($0) }
let W = Int32(want.count > 0 ? want[0] : 1920), H = Int32(want.count > 1 ? want[1] : 1080)
let FPS = Double(want.count > 2 ? want[2] : 25)

// Among formats of the requested size, take the one with the highest frame rate (the MJPEG one).
let candidates = device.formats.filter { dims($0).width == W && dims($0).height == H }
guard let format = candidates.max(by: { maxFps($0) < maxFps($1) }) else {
    print("Camera has no \(W)x\(H) mode. Run with --list to see what it offers."); exit(1)
}
let fps = min(FPS, maxFps(format))
print("Using \(W)x\(H) \(fourcc(format)) at \(Int(fps)) fps")

let session = AVCaptureSession()
guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
    print("Couldn't open the camera. Check System Settings → Privacy & Security → Camera."); exit(1)
}
session.addInput(input)

// Frame counter, shown in the window title
final class Counter: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    var frames = 0
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        frames += 1
    }
}
let counter = Counter()
let output = AVCaptureVideoDataOutput()
output.alwaysDiscardsLateVideoFrames = true
output.setSampleBufferDelegate(counter, queue: DispatchQueue(label: "frames"))
if session.canAddOutput(output) { session.addOutput(output) }

func lockFormat() {
    do {
        try device.lockForConfiguration()
        device.activeFormat = format
        // use the camera's own duration for the matching range (it reports e.g. 30.00003 fps and rejects an exact 1/30)
        let dur = format.videoSupportedFrameRateRanges.first(where: { abs($0.maxFrameRate - fps) < 0.5 })?.minFrameDuration ?? CMTime(value: 1, timescale: CMTimeScale(fps))
        device.activeVideoMinFrameDuration = dur
        device.activeVideoMaxFrameDuration = dur
        device.unlockForConfiguration()
    } catch { print("Couldn't configure the camera: \(error)") }
}
lockFormat()

// Window
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let scale: CGFloat = 1280.0 / CGFloat(W)
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: CGFloat(H) * scale),
                      styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
window.center()
window.title = "Overhead camera"
let view = NSView(frame: window.contentView!.bounds)
view.wantsLayer = true
let preview = AVCaptureVideoPreviewLayer(session: session)
preview.videoGravity = .resizeAspect
preview.frame = view.bounds
preview.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
view.layer = CALayer()
view.layer?.backgroundColor = NSColor.black.cgColor
view.layer?.addSublayer(preview)
view.autoresizingMask = [.width, .height]
window.contentView = view
window.makeKeyAndOrderFront(nil)

final class Delegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let delegate = Delegate()
app.delegate = delegate

NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: .main) { n in
    print("Session error: \(n.userInfo?[AVCaptureSessionErrorKey] ?? "unknown")")
}
session.startRunning()
lockFormat()
print("Session running: \(session.isRunning), active format: \(fourcc(device.activeFormat)) \(dims(device.activeFormat).width)x\(dims(device.activeFormat).height)") // some UVC cameras reset the format when the session starts

var last = Date()
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
    let now = Date(), n = counter.frames
    counter.frames = 0
    let rate = Double(n) / now.timeIntervalSince(last)
    last = now
    window.title = String(format: "Overhead camera — %dx%d %@ — %.1f fps", W, H, fourcc(device.activeFormat), rate)
    print(String(format: "%.1f fps", rate))
    fflush(stdout)
}
app.activate(ignoringOtherApps: true)
app.run()
