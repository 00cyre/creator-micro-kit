//  cm-bridge — stdio <-> raw HID transport for Work Louder Creator Micro 2.
//
//  Node's hidapi bindings open macOS HID devices exclusively by default, and the
//  keypad enumerates as a keyboard, so that open is refused with
//  kIOReturnNotPrivileged unless the host app holds Input Monitoring. Opening
//  through IOKit non-exclusively works without it, which is why the transport
//  lives here instead of in JavaScript.
//
//  stdin  — one JSON-RPC request object per line
//  stdout — one JSON object per line:
//             {"type":"ready","product":...,"vendorId":...,"productId":...}
//             {"type":"rpc","data":{...}}      a reply to a request
//             {"type":"notify","data":{...}}   an unsolicited device event
//             {"type":"log","data":"..."}      firmware debug output
//             {"type":"error","message":"..."}

import Foundation
import IOKit
import IOKit.hid

let workLouderVendorId = 0x303A
let reportId: UInt8 = 0x06
let channelDebug: UInt8 = 1
let channelRpc: UInt8 = 2
let maxPayload = 61

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

final class Bridge {
    private var manager: IOHIDManager?
    private var device: IOHIDDevice?
    private let reportBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 64)
    private var channels: [UInt8: [UInt8]] = [channelDebug: [], channelRpc: []]

    func open(productId: Int?) -> Bool {
        let mgr = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        manager = mgr
        var criteria: [String: Any] = [kIOHIDVendorIDKey: workLouderVendorId]
        if let productId { criteria[kIOHIDProductIDKey] = productId }
        IOHIDManagerSetDeviceMatching(mgr, criteria as CFDictionary)
        IOHIDManagerScheduleWithRunLoop(mgr, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)

        guard IOHIDManagerOpen(mgr, IOOptionBits(kIOHIDOptionsTypeNone)) == kIOReturnSuccess else {
            emit(["type": "error", "message": "IOHIDManagerOpen failed"])
            return false
        }
        CFRunLoopRunInMode(.defaultMode, 0.4, false)

        guard let devices = IOHIDManagerCopyDevices(mgr) as? Set<IOHIDDevice>, let found = devices.first else {
            emit(["type": "error", "message": "no Work Louder device found"])
            return false
        }
        let result = IOHIDDeviceOpen(found, IOOptionBits(kIOHIDOptionsTypeNone))
        guard result == kIOReturnSuccess else {
            emit(["type": "error", "message": "IOHIDDeviceOpen failed (0x\(String(format: "%X", result)))"])
            return false
        }
        device = found
        // Exit when the device goes away so the host process sees a clean
        // close and can re-spawn the bridge once the device returns. Without
        // this, an unplug leaves a silently dead handle.
        IOHIDManagerRegisterDeviceRemovalCallback(mgr, { context, _, _, removed in
            let bridge = Unmanaged<Bridge>.fromOpaque(context!).takeUnretainedValue()
            if bridge.device == nil || bridge.device === removed {
                emit(["type": "error", "message": "device removed"])
                exit(3)
            }
        }, Unmanaged.passUnretained(self).toOpaque())
        IOHIDDeviceScheduleWithRunLoop(found, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
        IOHIDDeviceRegisterInputReportCallback(found, reportBuffer, 64, { context, _, _, _, _, report, length in
            Unmanaged<Bridge>.fromOpaque(context!).takeUnretainedValue().receive(report, length)
        }, Unmanaged.passUnretained(self).toOpaque())

        func property(_ key: String) -> Any? { IOHIDDeviceGetProperty(found, key as CFString) }
        emit([
            "type": "ready",
            "product": (property(kIOHIDProductKey) as? String) ?? "unknown",
            "vendorId": (property(kIOHIDVendorIDKey) as? Int) ?? 0,
            "productId": (property(kIOHIDProductIDKey) as? Int) ?? 0,
        ])
        return true
    }

    /// Splits a message across 64-byte reports: report id, channel, payload
    /// length, then up to 61 bytes of UTF-8. Framed with CRLF so a partial
    /// write can never merge into the next message on the device's parser.
    func send(_ message: String) {
        guard let device else { return }
        let bytes = Array(("\r\n" + message + "\r\n").utf8)
        var offset = 0
        while offset < bytes.count {
            let count = min(maxPayload, bytes.count - offset)
            var packet = [UInt8](repeating: 0, count: 64)
            packet[0] = reportId
            packet[1] = channelRpc
            packet[2] = UInt8(count)
            for i in 0..<count { packet[3 + i] = bytes[offset + i] }
            let result = IOHIDDeviceSetReport(device, kIOHIDReportTypeOutput, CFIndex(reportId), packet, packet.count)
            if result != kIOReturnSuccess {
                emit(["type": "error", "message": "SetReport failed (0x\(String(format: "%X", result)))"])
                return
            }
            offset += count
        }
    }

    private func receive(_ report: UnsafeMutablePointer<UInt8>, _ length: CFIndex) {
        guard length >= 3 else { return }
        let channel = report[1]
        let count = Int(report[2])
        guard count > 0, 3 + count <= length else { return }
        channels[channel, default: []].append(contentsOf: UnsafeBufferPointer(start: report + 3, count: count))

        while let index = channels[channel]!.firstIndex(where: { $0 == 0x0A || $0 == 0x0D }) {
            let line = String(decoding: channels[channel]![0..<index], as: UTF8.self)
                .trimmingCharacters(in: .whitespaces)
            channels[channel]!.removeFirst(index + 1)
            guard !line.isEmpty else { continue }
            if channel == channelDebug {
                emit(["type": "log", "data": line])
            } else if let data = line.data(using: .utf8),
                      let object = try? JSONSerialization.jsonObject(with: data) {
                // Requests carry an id; unsolicited events use the short {"m","p"} envelope.
                let isNotify = (object as? [String: Any])?["m"] != nil
                emit(["type": isNotify ? "notify" : "rpc", "data": object])
            }
        }
    }
}

let requestedProductId = CommandLine.arguments.dropFirst().first.flatMap { Int($0) }
let bridge = Bridge()
guard bridge.open(productId: requestedProductId) else { exit(2) }

// Reading stdin on a background thread keeps the HID run loop on the main thread.
Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { continue }
        if trimmed == "\"quit\"" { exit(0) }
        bridge.send(trimmed)
    }
    exit(0)
}
CFRunLoopRun()
