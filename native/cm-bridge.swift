//  cm-bridge — stdio <-> raw HID transport for Work Louder Creator Micro 2.
//
//  Node's hidapi bindings open macOS HID devices exclusively by default, and the
//  keypad enumerates as a keyboard, so that open is refused with
//  kIOReturnNotPrivileged unless the host app holds Input Monitoring. Opening
//  through IOKit non-exclusively works without it, which is why the transport
//  lives here instead of in JavaScript.
//
//  Usage:
//    cm-bridge [--product-id N] [--serial S] [--list]
//
//  stdin  — one JSON-RPC request object per line, or "quit" to exit cleanly
//  stdout — one JSON object per line:
//             {"type":"ready","product":...,"vendorId":...,"productId":...,
//              "transport":...,"serialNumber":...,"locationId":...}
//             {"type":"rpc","data":{...}}      a reply to a request
//             {"type":"notify","data":{...}}   an unsolicited device event
//             {"type":"log","data":"..."}      firmware debug output
//             {"type":"error","message":"..."}
//             {"type":"devices","data":[...]}  --list only

import Foundation
import IOKit
import IOKit.hid

let workLouderVendorId = 0x303A
/// The JSON-RPC server lives on the vendor-defined collection, usage page 0xFF00.
let vendorUsagePage = 0xFF00
let reportId: UInt8 = 0x06
let channelDebug: UInt8 = 1
let channelRpc: UInt8 = 2
/// 64-byte report: id, channel, length, then payload.
let maxPayload = 61

// Exit codes, mirrored in src/device.js.
let exitNoDevice: Int32 = 2
let exitDeviceRemoved: Int32 = 3
let exitOpenFailed: Int32 = 4

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func intProperty(_ device: IOHIDDevice, _ key: String) -> Int? {
    IOHIDDeviceGetProperty(device, key as CFString) as? Int
}

func stringProperty(_ device: IOHIDDevice, _ key: String) -> String? {
    IOHIDDeviceGetProperty(device, key as CFString) as? String
}

/// True when the device exposes the vendor-defined collection the RPC server
/// lives on. Over USB the keypad publishes several HID devices — keyboard,
/// consumer control, vendor — and only the last one answers. Over Bluetooth it
/// publishes a single device carrying every collection, including this one.
func hasVendorCollection(_ device: IOHIDDevice) -> Bool {
    guard let pairs = IOHIDDeviceGetProperty(device, kIOHIDDeviceUsagePairsKey as CFString)
            as? [[String: Any]] else {
        return intProperty(device, kIOHIDPrimaryUsagePageKey) == vendorUsagePage
    }
    return pairs.contains { ($0[kIOHIDDeviceUsagePageKey] as? Int) == vendorUsagePage }
}

func describe(_ device: IOHIDDevice) -> [String: Any] {
    [
        "product": stringProperty(device, kIOHIDProductKey) ?? "unknown",
        "manufacturer": stringProperty(device, kIOHIDManufacturerKey) ?? "unknown",
        "vendorId": intProperty(device, kIOHIDVendorIDKey) ?? 0,
        "productId": intProperty(device, kIOHIDProductIDKey) ?? 0,
        "transport": stringProperty(device, kIOHIDTransportKey) ?? "unknown",
        "serialNumber": stringProperty(device, kIOHIDSerialNumberKey) ?? "",
        "locationId": intProperty(device, kIOHIDLocationIDKey) ?? 0,
        "primaryUsagePage": intProperty(device, kIOHIDPrimaryUsagePageKey) ?? 0,
        "hasVendorCollection": hasVendorCollection(device),
    ]
}

/// Deterministic preference order, so repeated runs pick the same interface:
/// the vendor collection first (nothing else answers RPC), then a wired link
/// over a wireless one, then the lowest location id as a stable tiebreak.
func preferred(_ a: IOHIDDevice, over b: IOHIDDevice) -> Bool {
    let vendorA = hasVendorCollection(a), vendorB = hasVendorCollection(b)
    if vendorA != vendorB { return vendorA }
    let wiredA = (stringProperty(a, kIOHIDTransportKey) ?? "").uppercased() == "USB"
    let wiredB = (stringProperty(b, kIOHIDTransportKey) ?? "").uppercased() == "USB"
    if wiredA != wiredB { return wiredA }
    return (intProperty(a, kIOHIDLocationIDKey) ?? 0) < (intProperty(b, kIOHIDLocationIDKey) ?? 0)
}

final class Bridge {
    private var manager: IOHIDManager?
    private var device: IOHIDDevice?
    private let reportBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 64)
    private var channels: [UInt8: [UInt8]] = [channelDebug: [], channelRpc: []]

    /// Enumerates every Work Louder HID device, optionally narrowed by product
    /// id or serial number. The manager stays scheduled on the current run loop.
    private func discover(productId: Int?, serial: String?) -> [IOHIDDevice] {
        let mgr = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        manager = mgr
        IOHIDManagerSetDeviceMatching(mgr, [kIOHIDVendorIDKey: workLouderVendorId] as CFDictionary)
        IOHIDManagerScheduleWithRunLoop(mgr, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
        guard IOHIDManagerOpen(mgr, IOOptionBits(kIOHIDOptionsTypeNone)) == kIOReturnSuccess else {
            emit(["type": "error", "message": "IOHIDManagerOpen failed"])
            return []
        }
        // Matching is asynchronous; give the manager a moment to populate.
        CFRunLoopRunInMode(.defaultMode, 0.4, false)
        let all = (IOHIDManagerCopyDevices(mgr) as? Set<IOHIDDevice>).map(Array.init) ?? []
        return all.filter { device in
            if let productId, intProperty(device, kIOHIDProductIDKey) != productId { return false }
            if let serial, stringProperty(device, kIOHIDSerialNumberKey) != serial { return false }
            return true
        }
    }

    func list(productId: Int?, serial: String?) {
        emit(["type": "devices", "data": discover(productId: productId, serial: serial).map(describe)])
    }

    func open(productId: Int?, serial: String?) -> Bool {
        let candidates = discover(productId: productId, serial: serial)
        guard let found = candidates.sorted(by: preferred).first else {
            emit(["type": "error", "message": "no Work Louder device found", "code": exitNoDevice])
            return false
        }
        // Every collection of a device shares one report pipe, so a device
        // without the vendor collection cannot answer RPC. Say so rather than
        // opening it and timing out on the first request.
        guard hasVendorCollection(found) else {
            let name = stringProperty(found, kIOHIDProductKey) ?? "device"
            emit([
                "type": "error",
                "code": exitNoDevice,
                "message": "\(name) does not expose the vendor HID collection (usage page 0xFF00); "
                    + "it cannot answer RPC. Reconnect the keypad or pass a different product id.",
            ])
            return false
        }

        let result = IOHIDDeviceOpen(found, IOOptionBits(kIOHIDOptionsTypeNone))
        guard result == kIOReturnSuccess else {
            emit([
                "type": "error",
                "code": exitOpenFailed,
                "message": "IOHIDDeviceOpen failed (0x\(String(format: "%X", result)))",
            ])
            return false
        }
        device = found
        // Exit when the device goes away so the host process sees a clean
        // close and can re-spawn the bridge once the device returns. Without
        // this, an unplug leaves a silently dead handle.
        IOHIDManagerRegisterDeviceRemovalCallback(manager!, { context, _, _, removed in
            let bridge = Unmanaged<Bridge>.fromOpaque(context!).takeUnretainedValue()
            if bridge.device == nil || bridge.device === removed {
                emit(["type": "error", "message": "device removed", "code": exitDeviceRemoved])
                exit(exitDeviceRemoved)
            }
        }, Unmanaged.passUnretained(self).toOpaque())
        IOHIDDeviceScheduleWithRunLoop(found, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
        IOHIDDeviceRegisterInputReportCallback(found, reportBuffer, 64, { context, _, _, _, _, report, length in
            Unmanaged<Bridge>.fromOpaque(context!).takeUnretainedValue().receive(report, length)
        }, Unmanaged.passUnretained(self).toOpaque())

        var ready = describe(found)
        ready["type"] = "ready"
        if candidates.count > 1 {
            ready["alternates"] = candidates.filter { $0 !== found }.map(describe)
        }
        emit(ready)
        return true
    }

    /// Splits a message across 64-byte reports: report id, channel, payload
    /// length, then up to 61 bytes of UTF-8. Framed with CRLF so a partial
    /// write can never merge into the next message on the device's parser.
    ///
    /// Runs on the main run loop — the same thread as the input callback — so
    /// `device` is only ever touched from one thread.
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

var requestedProductId: Int?
var requestedSerial: String?
var listOnly = false
var arguments = Array(CommandLine.arguments.dropFirst())
while let argument = arguments.first {
    arguments.removeFirst()
    switch argument {
    case "--list": listOnly = true
    case "--product-id": requestedProductId = arguments.first.flatMap { Int($0) }; arguments.removeFirst()
    case "--serial": requestedSerial = arguments.first; arguments.removeFirst()
    // Accept a bare product id for compatibility with earlier releases.
    default: requestedProductId = Int(argument) ?? requestedProductId
    }
}

let bridge = Bridge()
if listOnly {
    bridge.list(productId: requestedProductId, serial: requestedSerial)
    exit(0)
}
guard bridge.open(productId: requestedProductId, serial: requestedSerial) else { exit(exitNoDevice) }

// Reading stdin on a background thread keeps the HID run loop on the main
// thread; sends hop back to it so the device handle stays single-threaded.
Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { continue }
        if trimmed == "\"quit\"" || trimmed == "quit" { exit(0) }
        DispatchQueue.main.async { bridge.send(trimmed) }
    }
    // stdin closed: the host is gone. Let queued sends drain, then exit.
    DispatchQueue.main.async { exit(0) }
}
CFRunLoopRun()
