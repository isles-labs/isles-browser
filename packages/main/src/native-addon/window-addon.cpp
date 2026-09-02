#include <napi.h>
#include <algorithm>
#include <cstring>
#include <iostream>
#include <sstream>

#ifdef __APPLE__
#import <Foundation/Foundation.h>
#import <Cocoa/Cocoa.h>
#import <CoreFoundation/CoreFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Security/Security.h>
#include <CommonCrypto/CommonDigest.h>
#include <iomanip>
#include <mutex>
#include <vector>
#endif

#ifdef _WIN32
#include <windows.h>
#include <propkey.h>
#include <propvarutil.h>
#include <shobjidl.h>
#include <cstring>
#include <unordered_map>
#include <vector>
#include <string>
#endif

// Error logging macro
#define LOG_ERROR(msg) \
    do { \
        std::cerr << "Error: " << msg << " (line: " << __LINE__ << ")" << std::endl; \
    } while (0)

#ifdef _WIN32
    #define CHECK_WINDOW_OPERATION(op, msg) \
        do { \
            if (!(op)) { \
                LOG_ERROR(msg << " (LastError: " << GetLastError() << ")"); \
            } \
        } while (0)
#endif

// Platform specific window info structure
#ifdef _WIN32
struct WindowInfo {
    HWND hwnd;
    bool isExtension;
    int width;
    int height;
};

struct WindowIdentityIconHandles {
    HICON largeIcon = nullptr;
    HICON smallIcon = nullptr;
};

static std::unordered_map<HWND, WindowIdentityIconHandles> g_windowIdentityIcons;
#elif __APPLE__
struct WindowInfo {
    AXUIElementRef window;
    pid_t pid;
    bool isExtension;
    int width;
    int height;
};

namespace {
constexpr const char* kSharedOsCryptService = "com.yunsen-power.browser.os-crypt";
constexpr const char* kSharedOsCryptAccount = "shared-v1";

std::mutex g_sharedOsCryptMutex;
std::vector<uint8_t> g_sharedOsCryptSecret;
std::string g_sharedOsCryptSource;

struct KeychainReadResult {
    OSStatus status = errSecItemNotFound;
    std::vector<uint8_t> value;
};

CFMutableDictionaryRef CreateGenericPasswordQuery(const char* service, const char* account) {
    CFMutableDictionaryRef query = CFDictionaryCreateMutable(
        kCFAllocatorDefault,
        0,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks);
    CFStringRef serviceValue = CFStringCreateWithCString(kCFAllocatorDefault, service, kCFStringEncodingUTF8);
    CFStringRef accountValue = CFStringCreateWithCString(kCFAllocatorDefault, account, kCFStringEncodingUTF8);
    CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(query, kSecAttrService, serviceValue);
    CFDictionarySetValue(query, kSecAttrAccount, accountValue);
    CFRelease(serviceValue);
    CFRelease(accountValue);
    return query;
}

KeychainReadResult ReadGenericPassword(const char* service, const char* account) {
    KeychainReadResult result;
    CFMutableDictionaryRef query = CreateGenericPasswordQuery(service, account);
    CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
    CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);

    CFTypeRef data = nullptr;
    result.status = SecItemCopyMatching(query, &data);
    CFRelease(query);
    if (result.status == errSecSuccess && data && CFGetTypeID(data) == CFDataGetTypeID()) {
        CFDataRef passwordData = static_cast<CFDataRef>(data);
        const CFIndex length = CFDataGetLength(passwordData);
        const UInt8* bytes = CFDataGetBytePtr(passwordData);
        if (length > 0 && bytes) {
            result.value.assign(bytes, bytes + length);
        }
    }
    if (data) CFRelease(data);
    return result;
}

OSStatus AddGenericPassword(const char* service, const char* account, const std::vector<uint8_t>& value) {
    CFMutableDictionaryRef query = CreateGenericPasswordQuery(service, account);
    CFDataRef passwordData = CFDataCreate(kCFAllocatorDefault, value.data(), value.size());
    CFDictionarySetValue(query, kSecValueData, passwordData);
    const OSStatus status = SecItemAdd(query, nullptr);
    CFRelease(passwordData);
    CFRelease(query);
    return status;
}

std::vector<uint8_t> GenerateChromiumCompatiblePassword() {
    uint8_t randomBytes[16] = {0};
    if (SecRandomCopyBytes(kSecRandomDefault, sizeof(randomBytes), randomBytes) != errSecSuccess) {
        return {};
    }
    NSData* data = [NSData dataWithBytes:randomBytes length:sizeof(randomBytes)];
    NSString* encoded = [data base64EncodedStringWithOptions:0];
    const char* utf8 = [encoded UTF8String];
    if (!utf8) return {};
    return std::vector<uint8_t>(utf8, utf8 + strlen(utf8));
}

std::string SecretKeyId(const std::vector<uint8_t>& value) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH] = {0};
    CC_SHA256(value.data(), static_cast<CC_LONG>(value.size()), digest);
    std::ostringstream stream;
    stream << std::hex << std::setfill('0');
    for (size_t index = 0; index < 6; ++index) {
        stream << std::setw(2) << static_cast<unsigned int>(digest[index]);
    }
    return stream.str();
}

bool IsKeychainAccessError(OSStatus status) {
    return status != errSecSuccess && status != errSecItemNotFound;
}

void ClearSharedOsCryptSecret(void*) {
    std::lock_guard<std::mutex> lock(g_sharedOsCryptMutex);
    std::fill(g_sharedOsCryptSecret.begin(), g_sharedOsCryptSecret.end(), 0);
    g_sharedOsCryptSecret.clear();
    g_sharedOsCryptSource.clear();
}
}  // namespace
#endif

// Monitor info structure (for multi-monitor support)
#ifdef _WIN32
struct MonitorInfo {
    HMONITOR handle;
    RECT rect;
    bool isPrimary;
};
#elif __APPLE__
struct MonitorInfo {
    CGDirectDisplayID id;
    CGRect bounds;
    bool isPrimary;
};
#else
// Dummy struct for Linux (not supported but allows compilation)
struct MonitorInfo {
    int id;
    bool isPrimary;
    int x, y, width, height;
};
#endif

// Forward declaration of GetMonitors function
std::vector<MonitorInfo> GetMonitors();

class WindowManager : public Napi::ObjectWrap<WindowManager> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
#ifdef __APPLE__
        napi_add_env_cleanup_hook(env, ClearSharedOsCryptSecret, nullptr);
#endif
        Napi::Function func = DefineClass(env, "WindowManager", {
            InstanceMethod("arrangeWindows", &WindowManager::ArrangeWindows),
            InstanceMethod("sendMouseEvent", &WindowManager::SendMouseEvent),
            InstanceMethod("sendMouseEventWithPopupMatching", &WindowManager::SendMouseEventWithPopupMatching),
            InstanceMethod("sendKeyboardEvent", &WindowManager::SendKeyboardEvent),
            InstanceMethod("sendWheelEvent", &WindowManager::SendWheelEvent),
            InstanceMethod("getWindowBounds", &WindowManager::GetWindowBounds),
            InstanceMethod("getAllWindows", &WindowManager::GetAllWindows),
            InstanceMethod("getMonitors", &WindowManager::GetMonitorsJS),
            InstanceMethod("isProcessWindowActive", &WindowManager::IsProcessWindowActive),
            InstanceMethod("setWindowIdentityIcon", &WindowManager::SetWindowIdentityIcon),
            InstanceMethod("setWindowIdentityTitle", &WindowManager::SetWindowIdentityTitle),
            InstanceMethod("getOrCreateMacOsCryptSecret", &WindowManager::GetOrCreateMacOsCryptSecret)
        });

        Napi::FunctionReference* constructor = new Napi::FunctionReference();
        *constructor = Napi::Persistent(func);
        env.SetInstanceData(constructor);

        exports.Set("WindowManager", func);
        return exports;
    }

    WindowManager(const Napi::CallbackInfo& info) : Napi::ObjectWrap<WindowManager>(info) {}

private:
#ifdef _WIN32
struct WindowDebugInfo {
    std::string title;
    std::string className;
    LONG style;
    bool visible;
    bool minimized;
    RECT rect;
};

    bool ArrangeWindow(HWND hwnd, int x, int y, int width, int height, bool preserveSize = false) {
        if (!hwnd) return false;
        
        if (IsIconic(hwnd) || IsZoomed(hwnd)) {
            ShowWindow(hwnd, SW_RESTORE);
        }
        SetForegroundWindow(hwnd);
        
        SetLastError(0);
        LONG style = GetWindowLong(hwnd, GWL_STYLE);
        if (style == 0 && GetLastError() != 0) {
            LOG_ERROR("Failed to get window style");
            return false;
        }
        
        style &= ~(WS_MAXIMIZE | WS_MINIMIZE);
        SetLastError(0);
        LONG prevStyle = SetWindowLong(hwnd, GWL_STYLE, style);
        if (prevStyle == 0 && GetLastError() != 0) {
            LOG_ERROR("Failed to set window style");
            return false;
        }
        
        UINT flags = SWP_SHOWWINDOW | SWP_FRAMECHANGED;
        if (preserveSize) {
            flags |= SWP_NOSIZE;
        }
        
        if (!SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, flags)) {
            LOG_ERROR("Failed to set window position");
            return false;
        }
        
        if (!SetWindowPos(hwnd, HWND_NOTOPMOST, x, y, width, height, flags)) {
            LOG_ERROR("Failed to reset window z-order");
            return false;
        }

        // Verify move actually took effect. Some Chromium windows can ignore a single SetWindowPos.
        RECT finalRect = {0, 0, 0, 0};
        if (GetWindowRect(hwnd, &finalRect)) {
            int finalWidth = finalRect.right - finalRect.left;
            int finalHeight = finalRect.bottom - finalRect.top;
            bool posMismatch = (finalRect.left != x) || (finalRect.top != y);
            bool sizeMismatch = !preserveSize && ((finalWidth != width) || (finalHeight != height));
            if (posMismatch || sizeMismatch) {
                // Fallback retry path.
                if (!MoveWindow(hwnd, x, y, width, height, TRUE)) {
                    LOG_ERROR("MoveWindow retry failed after SetWindowPos mismatch");
                    return false;
                }
                RECT retryRect = {0, 0, 0, 0};
                if (GetWindowRect(hwnd, &retryRect)) {
                    int retryWidth = retryRect.right - retryRect.left;
                    int retryHeight = retryRect.bottom - retryRect.top;
                    bool retryPosMismatch = (retryRect.left != x) || (retryRect.top != y);
                    bool retrySizeMismatch = !preserveSize && ((retryWidth != width) || (retryHeight != height));
                    if (retryPosMismatch || retrySizeMismatch) {
                        LOG_ERROR("Window position/size unchanged after MoveWindow retry");
                        return false;
                    }
                }
            }
        }
        
        return true;
    }

    bool IsMainBrowserWindow(HWND hwnd, LONG style, const RECT& rect, const char* className) {
        if (!hwnd) return false;
        if (style & WS_CHILD) return false;
        if (!(style & WS_OVERLAPPEDWINDOW)) return false;
        if (style & WS_POPUP) return false;
        if (!className || strstr(className, "Chrome_WidgetWin") == nullptr) return false;

        const int width = rect.right - rect.left;
        const int height = rect.bottom - rect.top;
        // Filter out tiny tool/utility windows
        if (width < 240 || height < 180) return false;

        return true;
    }

    bool IsExtensionWindow(HWND hwnd, LONG style, const RECT& rect, const char* className) {
        return !IsMainBrowserWindow(hwnd, style, rect, className);
    }

    std::vector<WindowDebugInfo> CollectWindowsByPidDebugInfo(DWORD processId) {
        std::vector<WindowDebugInfo> infos;
        HWND hwnd = nullptr;
        while ((hwnd = FindWindowEx(nullptr, hwnd, nullptr, nullptr)) != nullptr) {
            DWORD pid = 0;
            GetWindowThreadProcessId(hwnd, &pid);
            if (pid != processId) continue;

            WindowDebugInfo info;
            char className[256] = {0};
            char title[512] = {0};
            GetClassNameA(hwnd, className, sizeof(className));
            GetWindowTextA(hwnd, title, sizeof(title));
            info.className = className;
            info.title = title;
            info.style = GetWindowLong(hwnd, GWL_STYLE);
            info.visible = IsWindowVisible(hwnd) != 0;
            info.minimized = IsIconic(hwnd) != 0;
            RECT rect = {0, 0, 0, 0};
            GetWindowRect(hwnd, &rect);
            info.rect = rect;
            infos.push_back(info);
        }
        return infos;
    }

    void LogWindowsByPidDebugInfo(DWORD processId, const char* reason) {
        auto infos = CollectWindowsByPidDebugInfo(processId);
        std::ostringstream oss;
        oss << "[WindowDebug][Win32] pid=" << processId << " reason=" << (reason ? reason : "<unknown>")
            << " windowCount=" << infos.size();
        for (size_t i = 0; i < infos.size(); i++) {
            const auto& w = infos[i];
            int width = w.rect.right - w.rect.left;
            int height = w.rect.bottom - w.rect.top;
            oss << " | #" << i
                << " title=" << (w.title.empty() ? "<empty>" : w.title)
                << " class=" << (w.className.empty() ? "<empty>" : w.className)
                << " style=0x" << std::hex << static_cast<unsigned long>(w.style) << std::dec
                << " rect=(" << w.rect.left << "," << w.rect.top << "," << w.rect.right << "," << w.rect.bottom << ")"
                << " size=" << width << "x" << height
                << " visible=" << (w.visible ? 1 : 0)
                << " minimized=" << (w.minimized ? 1 : 0);
        }
        std::cerr << oss.str() << std::endl;
    }

    std::vector<WindowInfo> FindWindowsByPid(DWORD processId) {
        std::vector<WindowInfo> windows;
        HWND hwnd = nullptr;

        while ((hwnd = FindWindowEx(nullptr, hwnd, nullptr, nullptr)) != nullptr) {
            DWORD pid = 0;
            GetWindowThreadProcessId(hwnd, &pid);

            if (pid == processId && IsWindowVisible(hwnd)) {
                char className[256] = {0};
                GetClassNameA(hwnd, className, sizeof(className));

                char title[256] = {0};
                GetWindowTextA(hwnd, title, sizeof(title));

                RECT rect = {0, 0, 0, 0};
                if (IsIconic(hwnd)) {
                    WINDOWPLACEMENT wp;
                    wp.length = sizeof(wp);
                    if (GetWindowPlacement(hwnd, &wp)) {
                        rect = wp.rcNormalPosition;
                    } else {
                        GetWindowRect(hwnd, &rect);
                    }
                } else {
                    GetWindowRect(hwnd, &rect);
                }

                LONG style = GetWindowLong(hwnd, GWL_STYLE);
                bool isMainWindow = IsMainBrowserWindow(hwnd, style, rect, className);
                bool isExtension = IsExtensionWindow(hwnd, style, rect, className);

                if (isMainWindow || isExtension) {
                    WindowInfo info;
                    info.hwnd = hwnd;
                    info.isExtension = isExtension;
                    info.width = rect.right - rect.left;
                    info.height = rect.bottom - rect.top;
                    windows.push_back(info);
                }
            }
        }
        if (windows.empty()) {
            LogWindowsByPidDebugInfo(processId, "FindWindowsByPid returned empty");
        }
        return windows;
    }

    // Find popup windows (like context menus) belonging to a process
    std::vector<HWND> FindPopupWindows(DWORD processId) {
        std::vector<HWND> popups;
        HWND hwnd = nullptr;

        while ((hwnd = FindWindowEx(nullptr, hwnd, nullptr, nullptr)) != nullptr) {
            DWORD pid = 0;
            GetWindowThreadProcessId(hwnd, &pid);

            if (pid == processId && IsWindowVisible(hwnd)) {
                LONG style = GetWindowLong(hwnd, GWL_STYLE);

                // Check if it's a popup window (WS_POPUP)
                if (style & WS_POPUP) {
                    char className[256] = {0};
                    GetClassNameA(hwnd, className, sizeof(className));

                    // Common popup window classes: #32768 (menu), Chrome_WidgetWin_1, etc.
                    if (strcmp(className, "#32768") == 0 ||
                        strstr(className, "Chrome_WidgetWin") != nullptr) {
                        popups.push_back(hwnd);
                    }
                }
            }
        }
        return popups;
    }

    // Find best matching popup window based on relative position
    HWND FindMatchingPopup(HWND masterMainWindow, HWND masterPopup,
                          HWND slaveMainWindow, const std::vector<HWND>& slavePopups) {
        if (slavePopups.empty()) {
            return nullptr;
        }

        // Get master popup position relative to master main window
        RECT masterMainRect, masterPopupRect;
        GetWindowRect(masterMainWindow, &masterMainRect);
        GetWindowRect(masterPopup, &masterPopupRect);

        int masterRelX = masterPopupRect.left - masterMainRect.left;
        int masterRelY = masterPopupRect.top - masterMainRect.top;

        // Get slave main window position
        RECT slaveMainRect;
        GetWindowRect(slaveMainWindow, &slaveMainRect);

        // Find slave popup with closest relative position
        HWND bestMatch = nullptr;
        int minDistance = INT_MAX;

        for (HWND slavePopup : slavePopups) {
            RECT slavePopupRect;
            GetWindowRect(slavePopup, &slavePopupRect);

            int slaveRelX = slavePopupRect.left - slaveMainRect.left;
            int slaveRelY = slavePopupRect.top - slaveMainRect.top;

            // Calculate Manhattan distance
            int distance = abs(masterRelX - slaveRelX) + abs(masterRelY - slaveRelY);

            if (distance < minDistance) {
                minDistance = distance;
                bestMatch = slavePopup;
            }
        }

        return bestMatch;
    }
    #elif __APPLE__
    bool CheckAccessibilityPermission() {
        @autoreleasepool {
            NSDictionary* options = @{(id)kAXTrustedCheckOptionPrompt: @YES};
            BOOL isEnabled = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
            
            if (!isEnabled) {
                NSAlert* alert = [[NSAlert alloc] init];
                [alert setMessageText:@"Accessibility Permission Required"];
                [alert setInformativeText:@"ISLES Browser needs accessibility permission to manage windows. Please enable it in System Preferences."];
                [alert addButtonWithTitle:@"Open System Preferences"];
                [alert addButtonWithTitle:@"Cancel"];
                
                if ([alert runModal] == NSAlertFirstButtonReturn) {
                    [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]];
                }
            }
            
            return isEnabled;
        }
    }

    bool ReadAXString(AXUIElementRef window, CFStringRef key, char* out, size_t outSize) {
        if (!out || outSize == 0) return false;
        out[0] = '\0';
        CFTypeRef valueRef = nullptr;
        if (AXUIElementCopyAttributeValue(window, key, &valueRef) != kAXErrorSuccess || !valueRef) {
            return false;
        }
        if (CFGetTypeID(valueRef) != CFStringGetTypeID()) {
            CFRelease(valueRef);
            return false;
        }
        bool ok = CFStringGetCString((CFStringRef)valueRef, out, outSize, kCFStringEncodingUTF8);
        CFRelease(valueRef);
        return ok;
    }

    bool IsExtensionWindow(AXUIElementRef window) {
        char subroleBuffer[256] = {0};
        if (ReadAXString(window, kAXSubroleAttribute, subroleBuffer, sizeof(subroleBuffer))) {
            return strcmp(subroleBuffer, "AXStandardWindow") != 0;
        }
        return true;
    }

    void BringWindowToFront(AXUIElementRef window) {
        // Get the window's PID
        pid_t windowPid;
        if (AXUIElementGetPid(window, &windowPid) == kAXErrorSuccess) {
            // Create a new NSRunningApplication instance
            @autoreleasepool {
                NSRunningApplication* app = [NSRunningApplication runningApplicationWithProcessIdentifier:windowPid];
                if (app) {
                    [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
                }
            }
        }

        // Raise the window
        AXUIElementPerformAction(window, kAXRaiseAction);
    }

    bool IsMainWindow(AXUIElementRef window) {
        // Main window detection should not depend on localized/product-specific title.
        // Use AXSubrole to detect standard top-level browser window.
        CFStringRef subroleRef;
        if (AXUIElementCopyAttributeValue(window, kAXSubroleAttribute, (CFTypeRef*)&subroleRef) == kAXErrorSuccess) {
            char subroleBuffer[256];
            CFStringGetCString(subroleRef, subroleBuffer, sizeof(subroleBuffer), kCFStringEncodingUTF8);
            CFRelease(subroleRef);
            return strcmp(subroleBuffer, "AXStandardWindow") == 0;
        }
        return false;
    }

    void LogWindowsForPid(pid_t pid, const char* reason) {
        std::ostringstream oss;
        oss << "[WindowDebug] PID " << pid << " " << reason;
        AXUIElementRef app = AXUIElementCreateApplication(pid);
        if (!app) {
            oss << " | app handle unavailable";
            std::cerr << oss.str() << std::endl;
            return;
        }
        CFArrayRef windowArray = nullptr;
        if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, (CFTypeRef*)&windowArray) != kAXErrorSuccess || !windowArray) {
            oss << " | AXWindows unavailable";
            CFRelease(app);
            std::cerr << oss.str() << std::endl;
            return;
        }
        CFIndex count = CFArrayGetCount(windowArray);
        oss << " | windows=" << count;
        for (CFIndex i = 0; i < count; i++) {
            AXUIElementRef window = (AXUIElementRef)CFArrayGetValueAtIndex(windowArray, i);
            char title[256] = {0};
            char role[128] = {0};
            char subrole[128] = {0};
            ReadAXString(window, kAXTitleAttribute, title, sizeof(title));
            ReadAXString(window, kAXRoleAttribute, role, sizeof(role));
            ReadAXString(window, kAXSubroleAttribute, subrole, sizeof(subrole));
            CGSize size = {0, 0};
            AXValueRef sizeRef = nullptr;
            if (AXUIElementCopyAttributeValue(window, kAXSizeAttribute, (CFTypeRef*)&sizeRef) == kAXErrorSuccess && sizeRef) {
                AXValueGetValue(sizeRef, (AXValueType)kAXValueCGSizeType, &size);
                CFRelease(sizeRef);
            }
            bool minimized = false;
            CFBooleanRef minimizedRef = nullptr;
            if (AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute, (CFTypeRef*)&minimizedRef) == kAXErrorSuccess && minimizedRef) {
                minimized = CFBooleanGetValue(minimizedRef);
                CFRelease(minimizedRef);
            }
            oss << " | #" << i
                << " title=" << (title[0] ? title : "<empty>")
                << " role=" << (role[0] ? role : "<empty>")
                << " subrole=" << (subrole[0] ? subrole : "<empty>")
                << " size=" << (int)size.width << "x" << (int)size.height
                << " minimized=" << (minimized ? "1" : "0");
        }
        CFRelease(windowArray);
        CFRelease(app);
        std::cerr << oss.str() << std::endl;
    }

    std::vector<WindowInfo> GetWindowsForPid(pid_t pid) {
        std::vector<WindowInfo> windows;
        AXUIElementRef app = AXUIElementCreateApplication(pid);
        if (!app) {
            LOG_ERROR("Failed to create AX UI Element for application");
            return windows;
        }

        CFArrayRef windowArray;
        if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, (CFTypeRef*)&windowArray) == kAXErrorSuccess) {
            CFIndex count = CFArrayGetCount(windowArray);
            int bestMainIndex = -1;
            int bestMainScore = -1;
            for (CFIndex i = 0; i < count; i++) {
                AXUIElementRef window = (AXUIElementRef)CFArrayGetValueAtIndex(windowArray, i);
                
                // Only process visible windows
                CFBooleanRef isMinimizedRef;
                bool isVisible = true;
                if (AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute, (CFTypeRef*)&isMinimizedRef) == kAXErrorSuccess) {
                    isVisible = !CFBooleanGetValue(isMinimizedRef);
                    CFRelease(isMinimizedRef);
                }

                if (isVisible) {
                    CGSize size = {0, 0};
                    AXValueRef sizeRef;
                    if (AXUIElementCopyAttributeValue(window, kAXSizeAttribute, (CFTypeRef*)&sizeRef) == kAXErrorSuccess) {
                        AXValueGetValue(sizeRef, (AXValueType)kAXValueCGSizeType, &size);
                        CFRelease(sizeRef);
                        if (size.width <= 0 || size.height <= 0) {
                            continue;
                        }

                        bool isMain = IsMainWindow(window);
                        bool isExtension = IsExtensionWindow(window);
                        WindowInfo info;
                        info.window = (AXUIElementRef)CFRetain(window);
                        info.pid = pid;
                        info.isExtension = isExtension;
                        info.width = static_cast<int>(size.width);
                        info.height = static_cast<int>(size.height);
                        windows.push_back(info);

                        int area = info.width * info.height;
                        int score = area;
                        if (isMain) score += 10000000;
                        if (!isExtension) score += 1000000;
                        if (score > bestMainScore) {
                            bestMainScore = score;
                            bestMainIndex = static_cast<int>(windows.size() - 1);
                        }
                    }
                }
            }
            if (!windows.empty() && bestMainIndex >= 0) {
                for (size_t i = 0; i < windows.size(); i++) {
                    windows[i].isExtension = static_cast<int>(i) != bestMainIndex;
                }
            }
            CFRelease(windowArray);
        }
        CFRelease(app);
        return windows;
    }

    bool ArrangeWindow(pid_t pid, float x, float y, float width, float height, bool preserveSize = false) {
        auto windows = GetWindowsForPid(pid);
        if (windows.empty()) {
            LOG_ERROR("No windows found for process");
            LogWindowsForPid(pid, "ArrangeWindow: no candidate windows");
            return false;
        }

        WindowInfo* mainWindow = nullptr;
        std::vector<WindowInfo*> extensionWindows;

        for (auto& window : windows) {
            if (!window.isExtension) {
                mainWindow = &window;
            } else {
                extensionWindows.push_back(&window);
            }
        }

        if (!mainWindow) {
            LOG_ERROR("Main window not found");
            LogWindowsForPid(pid, "ArrangeWindow: main window not detected");
            return false;
        }

        // Position and size for main window
        CGPoint position = CGPointMake(x, y);
        AXValueRef positionRef = AXValueCreate((AXValueType)kAXValueCGPointType, &position);
        if (positionRef) {
            AXUIElementSetAttributeValue(mainWindow->window, kAXPositionAttribute, positionRef);
            CFRelease(positionRef);
        }

        if (!preserveSize) {
            CGSize size = CGSizeMake(width, height);
            AXValueRef sizeRef = AXValueCreate((AXValueType)kAXValueCGSizeType, &size);
            if (sizeRef) {
                AXUIElementSetAttributeValue(mainWindow->window, kAXSizeAttribute, sizeRef);
                CFRelease(sizeRef);
            }
        }

        // Bring main window to front
        BringWindowToFront(mainWindow->window);

        // Handle extension windows
        for (auto extWindow : extensionWindows) {
            // Position extension windows at the right edge of the main window
            CGPoint extPosition = CGPointMake(x + width - extWindow->width - 10, y);
            AXValueRef extPositionRef = AXValueCreate((AXValueType)kAXValueCGPointType, &extPosition);
            if (extPositionRef) {
                AXUIElementSetAttributeValue(extWindow->window, kAXPositionAttribute, extPositionRef);
                CFRelease(extPositionRef);
            }

            // Bring extension window to front
            BringWindowToFront(extWindow->window);
        }

        // Clean up
        for (auto& window : windows) {
            if (window.window) {
                CFRelease(window.window);
            }
        }

        return true;
    }
    #endif

    #ifdef _WIN32
    std::vector<MonitorInfo> GetMonitors() {
        std::vector<MonitorInfo> monitors;
        EnumDisplayMonitors(NULL, NULL, [](HMONITOR hMonitor, HDC, LPRECT, LPARAM lParam) -> BOOL {
            auto& monitors = *reinterpret_cast<std::vector<MonitorInfo>*>(lParam);
            MONITORINFOEX monitorInfo;
            monitorInfo.cbSize = sizeof(MONITORINFOEX);
            
            if (GetMonitorInfo(hMonitor, &monitorInfo)) {
                MonitorInfo info;
                info.handle = hMonitor;
                info.rect = monitorInfo.rcWork;
                info.isPrimary = (monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0;
                monitors.push_back(info);
            }
            return TRUE;
        }, reinterpret_cast<LPARAM>(&monitors));
        
        // Sort monitors so that non-primary monitors come first
        std::sort(monitors.begin(), monitors.end(), 
            [](const MonitorInfo& a, const MonitorInfo& b) {
                return a.isPrimary < b.isPrimary;
            });
        
        return monitors;
    }
    #elif __APPLE__
    std::vector<MonitorInfo> GetMonitors() {
        std::vector<MonitorInfo> monitors;
        uint32_t displayCount;
        CGDirectDisplayID displays[32];
        
        if (CGGetActiveDisplayList(32, displays, &displayCount) == kCGErrorSuccess) {
            CGDirectDisplayID mainDisplay = CGMainDisplayID();
            
            for (uint32_t i = 0; i < displayCount; i++) {
                MonitorInfo info;
                info.id = displays[i];
                info.bounds = CGDisplayBounds(displays[i]);
                info.isPrimary = (displays[i] == mainDisplay);
                monitors.push_back(info);
            }
            
            // Sort monitors so that non-primary monitors come first
            std::sort(monitors.begin(), monitors.end(), 
                [](const MonitorInfo& a, const MonitorInfo& b) {
                    return a.isPrimary < b.isPrimary;
                });
        }
        
        return monitors;
    }
    #else
    // Linux implementation (returns empty - not supported)
    std::vector<MonitorInfo> GetMonitors() {
        return std::vector<MonitorInfo>();
    }
    #endif

    // Expose GetMonitors to JavaScript
    Napi::Value GetMonitorsJS(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        Napi::Array result = Napi::Array::New(env);

        auto monitors = GetMonitors();

        for (size_t i = 0; i < monitors.size(); i++) {
            Napi::Object monitorObj = Napi::Object::New(env);

#ifdef _WIN32
            monitorObj.Set("x", Napi::Number::New(env, monitors[i].rect.left));
            monitorObj.Set("y", Napi::Number::New(env, monitors[i].rect.top));
            monitorObj.Set("width", Napi::Number::New(env, monitors[i].rect.right - monitors[i].rect.left));
            monitorObj.Set("height", Napi::Number::New(env, monitors[i].rect.bottom - monitors[i].rect.top));
#elif __APPLE__
            monitorObj.Set("x", Napi::Number::New(env, monitors[i].bounds.origin.x));
            monitorObj.Set("y", Napi::Number::New(env, monitors[i].bounds.origin.y));
            monitorObj.Set("width", Napi::Number::New(env, monitors[i].bounds.size.width));
            monitorObj.Set("height", Napi::Number::New(env, monitors[i].bounds.size.height));
#else
            monitorObj.Set("x", Napi::Number::New(env, monitors[i].x));
            monitorObj.Set("y", Napi::Number::New(env, monitors[i].y));
            monitorObj.Set("width", Napi::Number::New(env, monitors[i].width));
            monitorObj.Set("height", Napi::Number::New(env, monitors[i].height));
#endif
            monitorObj.Set("isPrimary", Napi::Boolean::New(env, monitors[i].isPrimary));
            monitorObj.Set("index", Napi::Number::New(env, i));

            result[i] = monitorObj;
        }

        return result;
    }

    Napi::Value ArrangeWindows(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();

        if (info.Length() < 5) {
            Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
            return env.Null();
        }

        int mainPid = info[0].As<Napi::Number>().Int32Value();
        Napi::Array childPidsArray = info[1].As<Napi::Array>();
        int columns = info[2].As<Napi::Number>().Int32Value();
        Napi::Object size = info[3].As<Napi::Object>();
        int spacing = info[4].As<Napi::Number>().Int32Value();

        // Optional 6th argument: monitor index (defaults to 0)
        int monitorIndex = 0;
        if (info.Length() >= 6 && info[5].IsNumber()) {
            monitorIndex = info[5].As<Napi::Number>().Int32Value();
        }

        int width = size.Get("width").As<Napi::Number>().Int32Value();
        int height = size.Get("height").As<Napi::Number>().Int32Value();

        std::vector<int> childPids;
        for (uint32_t i = 0; i < childPidsArray.Length(); i++) {
            childPids.push_back(childPidsArray.Get(i).As<Napi::Number>().Int32Value());
        }

        // Get all available monitors
        auto monitors = GetMonitors();
        if (monitors.empty()) {
            Napi::Error::New(env, "No monitors found").ThrowAsJavaScriptException();
            return env.Null();
        }

        // Validate monitor index
        if (monitorIndex < 0 || monitorIndex >= static_cast<int>(monitors.size())) {
            Napi::Error::New(env, "Invalid monitor index").ThrowAsJavaScriptException();
            return env.Null();
        }

#ifdef _WIN32
        // Use the selected monitor
        const auto& monitor = monitors[monitorIndex];
        int screenWidth = monitor.rect.right - monitor.rect.left;
        int screenHeight = monitor.rect.bottom - monitor.rect.top;
        int screenX = monitor.rect.left;
        int screenY = monitor.rect.top;

        // Calculate total windows and rows
        int totalWindows = childPids.size() + 1;
        int rows = (totalWindows + columns - 1) / columns;

        // Calculate effective dimensions with spacing
        int availableWidth = screenWidth - (spacing * (columns + 1));
        int availableHeight = screenHeight - (spacing * (rows + 1));
        int effectiveWidth = width > 0 ? width : availableWidth / columns;
        int effectiveHeight = height > 0 ? height : availableHeight / rows;

        // Handle main window and its extensions
        auto mainWindows = FindWindowsByPid(mainPid);
        WindowInfo* mainWindow = nullptr;
        std::vector<WindowInfo*> mainExtensions;

        for (auto& win : mainWindows) {
            if (!win.isExtension) {
                mainWindow = &win;
            } else {
                mainExtensions.push_back(&win);
            }
        }

        // Fallback for cloak-style windows: if all windows were classified as extension,
        // promote the largest one to main window.
        if (!mainWindow && !mainWindows.empty()) {
            WindowInfo* largest = &mainWindows[0];
            int largestArea = largest->width * largest->height;
            for (auto& win : mainWindows) {
                int area = win.width * win.height;
                if (area > largestArea) {
                    largest = &win;
                    largestArea = area;
                }
            }
            mainWindow = largest;
            mainExtensions.clear();
            for (auto& win : mainWindows) {
                if (&win != mainWindow) {
                    mainExtensions.push_back(&win);
                }
            }
        }

        bool hasArrangeFailure = false;
        if (mainWindow) {
            int row = 0;
            int col = 0;
            int x = screenX + col * effectiveWidth + spacing;
            int y = screenY + row * effectiveHeight + spacing;
            if (!ArrangeWindow(mainWindow->hwnd, x, y, effectiveWidth - spacing * 2, effectiveHeight - spacing * 2)) {
                hasArrangeFailure = true;
            }

            for (auto ext : mainExtensions) {
                if (!ArrangeWindow(ext->hwnd,
                                x + effectiveWidth - ext->width - spacing,
                                y,
                                ext->width,
                                ext->height,
                                true)) {
                    hasArrangeFailure = true;
                }
            }
        }

        // Handle child windows
        for (size_t i = 0; i < childPids.size(); i++) {
            auto childWindows = FindWindowsByPid(childPids[i]);
            WindowInfo* childMain = nullptr;
            std::vector<WindowInfo*> childExtensions;

            for (auto& win : childWindows) {
                if (!win.isExtension) {
                    childMain = &win;
                } else {
                    childExtensions.push_back(&win);
                }
            }

            // Fallback for cloak-style windows: if all windows were classified as extension,
            // promote the largest one to child main window.
            if (!childMain && !childWindows.empty()) {
                WindowInfo* largest = &childWindows[0];
                int largestArea = largest->width * largest->height;
                for (auto& win : childWindows) {
                    int area = win.width * win.height;
                    if (area > largestArea) {
                        largest = &win;
                        largestArea = area;
                    }
                }
                childMain = largest;
                childExtensions.clear();
                for (auto& win : childWindows) {
                    if (&win != childMain) {
                        childExtensions.push_back(&win);
                    }
                }
            }

            if (childMain) {
                int row = (i + 1) / columns;
                int col = (i + 1) % columns;
                int x = screenX + (col * effectiveWidth) + (spacing * (col + 1));
                int y = screenY + (row * effectiveHeight) + (spacing * (row + 1));

                if (!ArrangeWindow(childMain->hwnd,
                                x,
                                y,
                                effectiveWidth - spacing,
                                effectiveHeight - spacing)) {
                    hasArrangeFailure = true;
                }

                // Handle extensions
                for (auto ext : childExtensions) {
                    if (!ArrangeWindow(ext->hwnd,
                                    x + effectiveWidth - ext->width - spacing,
                                    y,
                                    ext->width,
                                    ext->height,
                                    true)) {
                        hasArrangeFailure = true;
                    }
                }
            }
        }
        if (hasArrangeFailure) {
            Napi::Error::New(env, "One or more windows failed to move on Windows").ThrowAsJavaScriptException();
            return env.Null();
        }
#elif __APPLE__
        // Use the selected monitor
        const auto& monitor = monitors[monitorIndex];
        float screenWidth = monitor.bounds.size.width;
        float screenHeight = monitor.bounds.size.height;
        float screenX = monitor.bounds.origin.x;
        float screenY = monitor.bounds.origin.y;

        // Calculate total windows and rows
        int totalWindows = childPids.size() + 1;
        int rows = (totalWindows + columns - 1) / columns;

        // Calculate effective dimensions with spacing
        float availableWidth = screenWidth - (spacing * (columns + 1));
        float availableHeight = screenHeight - (spacing * (rows + 1));
        float effectiveWidth = width > 0 ? width : availableWidth / columns;
        float effectiveHeight = height > 0 ? height : availableHeight / rows;

        // Handle main window
        ArrangeWindow(mainPid, 
                     screenX + spacing, 
                     screenY + spacing, 
                     effectiveWidth - spacing * 2, 
                     effectiveHeight - spacing * 2);

        // Handle child windows
        for (size_t i = 0; i < childPids.size(); i++) {
            int row = (i + 1) / columns;
            int col = (i + 1) % columns;
            float x = screenX + (col * effectiveWidth) + (spacing * (col + 1));
            float y = screenY + (row * effectiveHeight) + (spacing * (row + 1));
            
            ArrangeWindow(childPids[i],
                         x,
                         y,
                         effectiveWidth - spacing,
                         effectiveHeight - spacing);
        }
#endif

        return env.Null();
    }

    // Get window bounds by PID
    Napi::Value GetWindowBounds(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();

        if (info.Length() < 1) {
            Napi::TypeError::New(env, "Wrong number of arguments");
        }

        int pid = info[0].As<Napi::Number>().Int32Value();
        Napi::Object result = Napi::Object::New(env);

#ifdef _WIN32
        auto windows = FindWindowsByPid(pid);
        if (!windows.empty()) {
            WindowInfo* mainWindow = nullptr;
            for (auto& win : windows) {
                if (!win.isExtension) {
                    mainWindow = &win;
                    break;
                }
            }

            // Fallback for cloak-style windows: if none is marked as main,
            // use the largest one.
            if (!mainWindow) {
                WindowInfo* largest = &windows[0];
                int largestArea = largest->width * largest->height;
                for (auto& win : windows) {
                    int area = win.width * win.height;
                    if (area > largestArea) {
                        largest = &win;
                        largestArea = area;
                    }
                }
                mainWindow = largest;
            }

            if (mainWindow) {
                RECT rect;
                if (GetWindowRect(mainWindow->hwnd, &rect)) {
                    result.Set("x", Napi::Number::New(env, rect.left));
                    result.Set("y", Napi::Number::New(env, rect.top));
                    result.Set("width", Napi::Number::New(env, rect.right - rect.left));
                    result.Set("height", Napi::Number::New(env, rect.bottom - rect.top));
                    result.Set("success", Napi::Boolean::New(env, true));
                }
            }
        }
#elif __APPLE__
        auto windows = GetWindowsForPid(pid);
        if (!windows.empty()) {
            WindowInfo* mainWindow = nullptr;
            for (auto& win : windows) {
                if (!win.isExtension) {
                    mainWindow = &win;
                    break;
                }
            }

            if (mainWindow) {
                CGPoint position;
                CGSize size;
                AXValueRef posRef, sizeRef;

                if (AXUIElementCopyAttributeValue(mainWindow->window, kAXPositionAttribute, (CFTypeRef*)&posRef) == kAXErrorSuccess) {
                    AXValueGetValue(posRef, (AXValueType)kAXValueCGPointType, &position);
                    CFRelease(posRef);

                    if (AXUIElementCopyAttributeValue(mainWindow->window, kAXSizeAttribute, (CFTypeRef*)&sizeRef) == kAXErrorSuccess) {
                        AXValueGetValue(sizeRef, (AXValueType)kAXValueCGSizeType, &size);
                        CFRelease(sizeRef);

                        result.Set("x", Napi::Number::New(env, position.x));
                        result.Set("y", Napi::Number::New(env, position.y));
                        result.Set("width", Napi::Number::New(env, size.width));
                        result.Set("height", Napi::Number::New(env, size.height));
                        result.Set("success", Napi::Boolean::New(env, true));
                    }
                }
                CFRelease(mainWindow->window);
            }
        }
#endif

        if (!result.Has("success")) {
            result.Set("success", Napi::Boolean::New(env, false));
        }

        return result;
    }

    // Get all windows for a process (including extension/popup windows)
    Napi::Value GetAllWindows(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();

        if (info.Length() < 1) {
            Napi::TypeError::New(env, "Wrong number of arguments: expected pid");
        }

        int pid = info[0].As<Napi::Number>().Int32Value();
        Napi::Array result = Napi::Array::New(env);

#ifdef _WIN32
        auto windows = FindWindowsByPid(pid);
        uint32_t index = 0;

        for (auto& win : windows) {
            RECT rect;
            if (GetWindowRect(win.hwnd, &rect)) {
                Napi::Object windowObj = Napi::Object::New(env);

                // Get window title
                char title[256] = {0};
                GetWindowTextA(win.hwnd, title, sizeof(title));

                windowObj.Set("x", Napi::Number::New(env, rect.left));
                windowObj.Set("y", Napi::Number::New(env, rect.top));
                windowObj.Set("width", Napi::Number::New(env, rect.right - rect.left));
                windowObj.Set("height", Napi::Number::New(env, rect.bottom - rect.top));
                windowObj.Set("isExtension", Napi::Boolean::New(env, win.isExtension));
                windowObj.Set("title", Napi::String::New(env, title));

                result[index++] = windowObj;
            }
        }
#elif __APPLE__
        auto windows = GetWindowsForPid(pid);
        uint32_t index = 0;

        for (auto& win : windows) {
            CGPoint position;
            CGSize size;
            AXValueRef posRef, sizeRef;

            if (AXUIElementCopyAttributeValue(win.window, kAXPositionAttribute, (CFTypeRef*)&posRef) == kAXErrorSuccess) {
                AXValueGetValue(posRef, (AXValueType)kAXValueCGPointType, &position);
                CFRelease(posRef);

                if (AXUIElementCopyAttributeValue(win.window, kAXSizeAttribute, (CFTypeRef*)&sizeRef) == kAXErrorSuccess) {
                    AXValueGetValue(sizeRef, (AXValueType)kAXValueCGSizeType, &size);
                    CFRelease(sizeRef);

                    Napi::Object windowObj = Napi::Object::New(env);

                    // Get window title
                    CFStringRef titleRef;
                    char title[256] = {0};
                    if (AXUIElementCopyAttributeValue(win.window, kAXTitleAttribute, (CFTypeRef*)&titleRef) == kAXErrorSuccess) {
                        CFStringGetCString(titleRef, title, sizeof(title), kCFStringEncodingUTF8);
                        CFRelease(titleRef);
                    }

                    windowObj.Set("x", Napi::Number::New(env, position.x));
                    windowObj.Set("y", Napi::Number::New(env, position.y));
                    windowObj.Set("width", Napi::Number::New(env, size.width));
                    windowObj.Set("height", Napi::Number::New(env, size.height));
                    windowObj.Set("isExtension", Napi::Boolean::New(env, win.isExtension));
                    windowObj.Set("title", Napi::String::New(env, title));

                    result[index++] = windowObj;
                }
            }

            CFRelease(win.window);
        }
#endif

        return result;
    }

    // Send mouse event to window
    Napi::Value SendMouseEvent(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();

        if (info.Length() < 4) {
            Napi::TypeError::New(env, "Wrong number of arguments: pid, x, y, eventType");
        }

        int pid = info[0].As<Napi::Number>().Int32Value();
        int x = info[1].As<Napi::Number>().Int32Value();
        int y = info[2].As<Napi::Number>().Int32Value();
        std::string eventType = info[3].As<Napi::String>().Utf8Value();

#ifdef _WIN32
        auto windows = FindWindowsByPid(pid);
        if (windows.empty()) {
            return Napi::Boolean::New(env, false);
        }

        WindowInfo* mainWindow = nullptr;
        for (auto& win : windows) {
            if (!win.isExtension) {
                mainWindow = &win;
                break;
            }
        }

        if (!mainWindow) {
            return Napi::Boolean::New(env, false);
        }

        // Check if click position is on an extension window first
        // Extension windows are independent windows (e.g., OKX Wallet popup)
        HWND targetWindow = mainWindow->hwnd;

        for (auto& win : windows) {
            if (win.isExtension) {
                RECT extRect;
                GetWindowRect(win.hwnd, &extRect);

                if (x >= extRect.left && x <= extRect.right &&
                    y >= extRect.top && y <= extRect.bottom) {
                    targetWindow = win.hwnd;
                    break;
                }
            }
        }

        // If not in extension window, check popup windows (menus, dropdowns, etc.)
        if (targetWindow == mainWindow->hwnd) {
            std::vector<HWND> popupWindows = FindPopupWindows(pid);

            for (HWND popup : popupWindows) {
                RECT popupRect;
                GetWindowRect(popup, &popupRect);

                if (x >= popupRect.left && x <= popupRect.right &&
                    y >= popupRect.top && y <= popupRect.bottom) {
                    targetWindow = popup;
                    break;
                }
            }
        }

        // Calculate coordinates relative to target window
        RECT rect;
        GetWindowRect(targetWindow, &rect);
        int clientX = x - rect.left;
        int clientY = y - rect.top;
        LPARAM lParam = MAKELPARAM(clientX, clientY);

        // Send event to target window (either main window or popup)
        if (eventType == "mousemove") {
            PostMessage(targetWindow, WM_MOUSEMOVE, 0, lParam);
        } else if (eventType == "mousedown") {
            PostMessage(targetWindow, WM_LBUTTONDOWN, MK_LBUTTON, lParam);
        } else if (eventType == "mouseup") {
            PostMessage(targetWindow, WM_LBUTTONUP, 0, lParam);
        } else if (eventType == "rightdown") {
            PostMessage(targetWindow, WM_RBUTTONDOWN, MK_RBUTTON, lParam);
        } else if (eventType == "rightup") {
            PostMessage(targetWindow, WM_RBUTTONUP, 0, lParam);
        } else {
            return Napi::Boolean::New(env, false);
        }

#elif __APPLE__
        CGPoint point = CGPointMake(x, y);
        CGEventType cgEventType;
        CGMouseButton button = kCGMouseButtonLeft;

        if (eventType == "mousemove") {
            cgEventType = kCGEventMouseMoved;
        } else if (eventType == "mousedown") {
            cgEventType = kCGEventLeftMouseDown;
        } else if (eventType == "mouseup") {
            cgEventType = kCGEventLeftMouseUp;
        } else if (eventType == "rightdown") {
            cgEventType = kCGEventRightMouseDown;
            button = kCGMouseButtonRight;
        } else if (eventType == "rightup") {
            cgEventType = kCGEventRightMouseUp;
            button = kCGMouseButtonRight;
        } else {
            return Napi::Boolean::New(env, false);
        }

        CGEventRef event = CGEventCreateMouseEvent(NULL, cgEventType, point, button);
        if (event) {
            // For click events (down/up), send directly to target process to avoid moving cursor
            // For mousemove, we still use global event tap as CGEventPostToPid doesn't support it well
            if (eventType == "mousemove") {
                CGEventPost(kCGHIDEventTap, event);
            } else {
                // Send to specific process - this won't move the global cursor
                CGEventPostToPid(pid, event);
            }
            CFRelease(event);
        }
#endif

        return Napi::Boolean::New(env, true);
    }

    // Send keyboard event to window
    // Now supports automatic popup window detection based on mouse position
    Napi::Value SendKeyboardEvent(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();

        if (info.Length() < 3) {
            Napi::TypeError::New(env, "Wrong number of arguments: pid, keyCode, eventType, [mouseX, mouseY]");
        }

        int pid = info[0].As<Napi::Number>().Int32Value();
        int keyCode = info[1].As<Napi::Number>().Int32Value();
        std::string eventType = info[2].As<Napi::String>().Utf8Value();

        // Optional mouse position for popup detection
        int mouseX = -1;
        int mouseY = -1;
        if (info.Length() >= 5) {
            mouseX = info[3].As<Napi::Number>().Int32Value();
            mouseY = info[4].As<Napi::Number>().Int32Value();
        }

#ifdef _WIN32
        auto windows = FindWindowsByPid(pid);
        if (windows.empty()) {
            return Napi::Boolean::New(env, false);
        }

        WindowInfo* mainWindow = nullptr;
        for (auto& win : windows) {
            if (!win.isExtension) {
                mainWindow = &win;
                break;
            }
        }

        if (!mainWindow) {
            return Napi::Boolean::New(env, false);
        }

        // Detect extension/popup windows if mouse position provided
        HWND targetWindow = mainWindow->hwnd;

        if (mouseX >= 0 && mouseY >= 0) {
            char debugMsg[512];
            sprintf_s(debugMsg, "[Keyboard] PID %d: Mouse at (%d, %d), checking windows",
                     pid, mouseX, mouseY);
            OutputDebugStringA(debugMsg);

            // First check extension windows (independent windows like OKX Wallet)
            bool foundWindow = false;
            for (auto& win : windows) {
                if (win.isExtension) {
                    RECT extRect;
                    GetWindowRect(win.hwnd, &extRect);

                    sprintf_s(debugMsg, "[Keyboard]   Checking extension window bounds [%d, %d, %d, %d]",
                             extRect.left, extRect.top, extRect.right, extRect.bottom);
                    OutputDebugStringA(debugMsg);

                    if (mouseX >= extRect.left && mouseX <= extRect.right &&
                        mouseY >= extRect.top && mouseY <= extRect.bottom) {
                        targetWindow = win.hwnd;
                        foundWindow = true;
                        sprintf_s(debugMsg, "[Keyboard]   [OK] Mouse in extension window! Routing to extension");
                        OutputDebugStringA(debugMsg);
                        break;
                    }
                }
            }

            // If not in extension window, check popup windows (menus, dropdowns, etc.)
            if (!foundWindow) {
                std::vector<HWND> popupWindows = FindPopupWindows(pid);
                sprintf_s(debugMsg, "[Keyboard]   Found %zu popup windows", popupWindows.size());
                OutputDebugStringA(debugMsg);

                for (HWND popup : popupWindows) {
                    RECT popupRect;
                    GetWindowRect(popup, &popupRect);

                    sprintf_s(debugMsg, "[Keyboard]   Checking popup bounds [%d, %d, %d, %d]",
                             popupRect.left, popupRect.top, popupRect.right, popupRect.bottom);
                    OutputDebugStringA(debugMsg);

                    if (mouseX >= popupRect.left && mouseX <= popupRect.right &&
                        mouseY >= popupRect.top && mouseY <= popupRect.bottom) {
                        targetWindow = popup;
                        foundWindow = true;
                        sprintf_s(debugMsg, "[Keyboard]   [OK] Mouse in popup! Routing to popup window");
                        OutputDebugStringA(debugMsg);
                        break;
                    }
                }
            }

            if (!foundWindow) {
                sprintf_s(debugMsg, "[Keyboard]   [X] Mouse not in any extension/popup, using main window");
                OutputDebugStringA(debugMsg);
            }
        }

        // Build lParam for extended keys
        // Bit 24: Extended-key flag (1 for extended keys like arrows, Insert, Delete, etc.)
        // Check if this is an extended key based on the VK code
        bool isExtendedKey = (
            keyCode == VK_INSERT || keyCode == VK_DELETE || keyCode == VK_HOME ||
            keyCode == VK_END || keyCode == VK_PRIOR || keyCode == VK_NEXT ||
            keyCode == VK_LEFT || keyCode == VK_UP || keyCode == VK_RIGHT || keyCode == VK_DOWN ||
            keyCode == VK_NUMLOCK || keyCode == VK_DIVIDE
        );

        LPARAM lParam = 1; // Repeat count = 1
        if (isExtendedKey) {
            lParam |= (1 << 24); // Set extended-key flag
        }

        if (eventType == "keydown") {
            PostMessage(targetWindow, WM_KEYDOWN, keyCode, lParam);
        } else if (eventType == "keyup") {
            lParam |= (1 << 30); // Previous key state (1 = key was down)
            lParam |= (1 << 31); // Transition state (1 = key is being released)
            PostMessage(targetWindow, WM_KEYUP, keyCode, lParam);
        }

#elif __APPLE__
        CGEventRef event;
        bool isKeyDown = (eventType == "keydown");

        event = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keyCode, isKeyDown);
        if (event) {
            // Send keyboard event directly to target process to avoid affecting global system
            CGEventPostToPid(pid, event);
            CFRelease(event);
        }
#endif

        return Napi::Boolean::New(env, true);
    }

    // Send keyboard event to extension window by title
    Napi::Value SendKeyboardEventToExtension(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();

        if (info.Length() < 4) {
            Napi::TypeError::New(env, "Wrong number of arguments: pid, windowTitle, keyCode, eventType");
        }

        int pid = info[0].As<Napi::Number>().Int32Value();
        std::string windowTitle = info[1].As<Napi::String>().Utf8Value();
        int keyCode = info[2].As<Napi::Number>().Int32Value();
        std::string eventType = info[3].As<Napi::String>().Utf8Value();

#ifdef _WIN32
        auto windows = FindWindowsByPid(pid);
        if (windows.empty()) {
            return Napi::Boolean::New(env, false);
        }

        // Find extension window with matching title
        WindowInfo* targetWindow = nullptr;
        for (auto& win : windows) {
            if (win.isExtension) {
                char title[256] = {0};
                GetWindowTextA(win.hwnd, title, sizeof(title));
                if (std::string(title) == windowTitle) {
                    targetWindow = &win;
                    break;
                }
            }
        }

        if (!targetWindow) {
            // Window not found, return false but don't error
            return Napi::Boolean::New(env, false);
        }

        // Build lParam for extended keys
        bool isExtendedKey = (
            keyCode == VK_INSERT || keyCode == VK_DELETE || keyCode == VK_HOME ||
            keyCode == VK_END || keyCode == VK_PRIOR || keyCode == VK_NEXT ||
            keyCode == VK_LEFT || keyCode == VK_UP || keyCode == VK_RIGHT || keyCode == VK_DOWN ||
            keyCode == VK_NUMLOCK || keyCode == VK_DIVIDE
        );

        LPARAM lParam = 1; // Repeat count = 1
        if (isExtendedKey) {
            lParam |= (1 << 24); // Set extended-key flag
        }

        if (eventType == "keydown") {
            PostMessage(targetWindow->hwnd, WM_KEYDOWN, keyCode, lParam);
        } else if (eventType == "keyup") {
            lParam |= (1 << 30); // Previous key state (1 = key was down)
            lParam |= (1 << 31); // Transition state (1 = key is being released)
            PostMessage(targetWindow->hwnd, WM_KEYUP, keyCode, lParam);
        }

#elif __APPLE__
        // For macOS, we can't easily send keyboard events to specific windows
        // Fall back to global keyboard events
        CGEventRef event;
        bool isKeyDown = (eventType == "keydown");

        event = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keyCode, isKeyDown);
        if (event) {
            CGEventPost(kCGHIDEventTap, event);
            CFRelease(event);
        }
#endif

        return Napi::Boolean::New(env, true);
    }

    // Send wheel event to window
    Napi::Value SendWheelEvent(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();

        if (info.Length() < 3) {
            Napi::TypeError::New(env, "Wrong number of arguments: pid, deltaX, deltaY, [x, y]");
        }

        int pid = info[0].As<Napi::Number>().Int32Value();
        int deltaX = info[1].As<Napi::Number>().Int32Value();
        int deltaY = info[2].As<Napi::Number>().Int32Value();

        // Optional x, y coordinates (screen coordinates)
        // If not provided, use current cursor position
        int cursorX, cursorY;
        if (info.Length() >= 5) {
            cursorX = info[3].As<Napi::Number>().Int32Value();
            cursorY = info[4].As<Napi::Number>().Int32Value();
        } else {
#ifdef _WIN32
            POINT cursorPos;
            GetCursorPos(&cursorPos);
            cursorX = cursorPos.x;
            cursorY = cursorPos.y;
#else
            cursorX = 0;
            cursorY = 0;
#endif
        }

#ifdef _WIN32
        auto windows = FindWindowsByPid(pid);
        if (windows.empty()) {
            return Napi::Boolean::New(env, false);
        }

        WindowInfo* mainWindow = nullptr;
        for (auto& win : windows) {
            if (!win.isExtension) {
                mainWindow = &win;
                break;
            }
        }

        if (!mainWindow) {
            return Napi::Boolean::New(env, false);
        }

        // Send wheel event
        // Note: deltaY is already multiplied by WHEEL_DELTA (120) in TypeScript

        // WM_MOUSEWHEEL: wParam = key state | delta, lParam = screen coords
        WPARAM wParam = MAKEWPARAM(0, deltaY);
        LPARAM lParam = MAKELPARAM(cursorX, cursorY);

        // Use SendMessage instead of PostMessage for better reliability
        SendMessage(mainWindow->hwnd, WM_MOUSEWHEEL, wParam, lParam);

#elif __APPLE__
        CGEventRef event = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2, deltaY, deltaX);
        if (event) {
            // Send scroll event directly to target process
            CGEventPostToPid(pid, event);
            CFRelease(event);
        }
#endif

        return Napi::Boolean::New(env, true);
    }

    // Check if any window from the given process is currently active (foreground)
    Napi::Value IsProcessWindowActive(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();

        if (info.Length() < 1) {
            Napi::TypeError::New(env, "Wrong number of arguments: pid");
        }

        int pid = info[0].As<Napi::Number>().Int32Value();

#ifdef _WIN32
        // Get the current foreground window
        HWND foregroundWindow = GetForegroundWindow();
        if (!foregroundWindow) {
            return Napi::Boolean::New(env, false);
        }

        // Get the process ID of the foreground window
        DWORD foregroundPid = 0;
        GetWindowThreadProcessId(foregroundWindow, &foregroundPid);

        // Check if it matches our target PID
        bool isActive = (foregroundPid == static_cast<DWORD>(pid));

        return Napi::Boolean::New(env, isActive);

#elif __APPLE__
        // Get the active application
        @autoreleasepool {
            NSRunningApplication* frontApp = [[NSWorkspace sharedWorkspace] frontmostApplication];
            if (!frontApp) {
                return Napi::Boolean::New(env, false);
            }

            pid_t frontPid = [frontApp processIdentifier];
            bool isActive = (frontPid == pid);

            return Napi::Boolean::New(env, isActive);
        }
#else
        return Napi::Boolean::New(env, false);
#endif
    }

    Napi::Value SetWindowIdentityIcon(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsString()) {
            Napi::TypeError::New(env, "Expected pid, iconPath, and appUserModelId").ThrowAsJavaScriptException();
            return env.Null();
        }

#ifdef _WIN32
        const DWORD pid = static_cast<DWORD>(info[0].As<Napi::Number>().Uint32Value());
        const std::string iconPathUtf8 = info[1].As<Napi::String>().Utf8Value();
        const std::string appUserModelIdUtf8 = info[2].As<Napi::String>().Utf8Value();

        auto toWide = [](const std::string& value) {
            if (value.empty()) return std::wstring();
            const int required = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
            std::wstring wide(required > 0 ? required : 0, L'\0');
            if (required > 1) {
                MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, wide.data(), required);
            }
            if (!wide.empty()) wide.pop_back();
            return wide;
        };

        const std::wstring iconPath = toWide(iconPathUtf8);
        const std::wstring appUserModelId = toWide(appUserModelIdUtf8);
        if (iconPath.empty() || appUserModelId.empty()) {
            return Napi::Boolean::New(env, false);
        }

        const HRESULT comResult = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        const bool shouldUninitializeCom = SUCCEEDED(comResult);
        bool applied = false;
        auto windows = FindWindowsByPid(pid);
        for (const auto& window : windows) {
            if (window.isExtension || !window.hwnd) continue;

            HICON largeIcon = static_cast<HICON>(LoadImageW(
                nullptr,
                iconPath.c_str(),
                IMAGE_ICON,
                GetSystemMetrics(SM_CXICON),
                GetSystemMetrics(SM_CYICON),
                LR_LOADFROMFILE));
            HICON smallIcon = static_cast<HICON>(LoadImageW(
                nullptr,
                iconPath.c_str(),
                IMAGE_ICON,
                GetSystemMetrics(SM_CXSMICON),
                GetSystemMetrics(SM_CYSMICON),
                LR_LOADFROMFILE));

            if (!largeIcon || !smallIcon) {
                if (largeIcon) DestroyIcon(largeIcon);
                if (smallIcon) DestroyIcon(smallIcon);
                LOG_ERROR("Failed to load window identity icon");
                continue;
            }

            auto previous = g_windowIdentityIcons.find(window.hwnd);
            if (previous != g_windowIdentityIcons.end()) {
                if (previous->second.largeIcon) DestroyIcon(previous->second.largeIcon);
                if (previous->second.smallIcon) DestroyIcon(previous->second.smallIcon);
            }
            g_windowIdentityIcons[window.hwnd] = {largeIcon, smallIcon};

            SendMessageW(window.hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(largeIcon));
            SendMessageW(window.hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(smallIcon));

            IPropertyStore* propertyStore = nullptr;
            if (SUCCEEDED(SHGetPropertyStoreForWindow(window.hwnd, IID_PPV_ARGS(&propertyStore))) && propertyStore) {
                PROPVARIANT value;
                PropVariantInit(&value);
                if (SUCCEEDED(InitPropVariantFromString(appUserModelId.c_str(), &value))) {
                    propertyStore->SetValue(PKEY_AppUserModel_ID, value);
                    propertyStore->Commit();
                }
                PropVariantClear(&value);
                propertyStore->Release();
            }

            InvalidateRect(window.hwnd, nullptr, TRUE);
            applied = true;
        }
        if (shouldUninitializeCom) CoUninitialize();
        return Napi::Boolean::New(env, applied);
#else
        return Napi::Boolean::New(env, false);
#endif
    }

    Napi::Value SetWindowIdentityTitle(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
            Napi::TypeError::New(env, "Expected pid and title").ThrowAsJavaScriptException();
            return env.Null();
        }

#ifdef _WIN32
        const DWORD pid = static_cast<DWORD>(info[0].As<Napi::Number>().Uint32Value());
        const std::string titleUtf8 = info[1].As<Napi::String>().Utf8Value();
        const int required = MultiByteToWideChar(CP_UTF8, 0, titleUtf8.c_str(), -1, nullptr, 0);
        if (required <= 1) return Napi::Boolean::New(env, false);
        std::wstring title(static_cast<size_t>(required), L'\0');
        MultiByteToWideChar(CP_UTF8, 0, titleUtf8.c_str(), -1, title.data(), required);
        title.pop_back();

        bool applied = false;
        auto windows = FindWindowsByPid(pid);
        for (const auto& window : windows) {
            if (window.isExtension || !window.hwnd) continue;
            if (SetWindowTextW(window.hwnd, title.c_str())) {
                applied = true;
            }
        }
        return Napi::Boolean::New(env, applied);
#else
        return Napi::Boolean::New(env, false);
#endif
    }

    Napi::Value GetOrCreateMacOsCryptSecret(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        if (info.Length() < 1 || !info[0].IsBoolean()) {
            Napi::TypeError::New(env, "Expected hasExistingProfiles boolean").ThrowAsJavaScriptException();
            return env.Null();
        }

#ifdef __APPLE__
        const bool hasExistingProfiles = info[0].As<Napi::Boolean>().Value();
        std::lock_guard<std::mutex> lock(g_sharedOsCryptMutex);

        if (g_sharedOsCryptSecret.empty()) {
            auto shared = ReadGenericPassword(kSharedOsCryptService, kSharedOsCryptAccount);
            if (shared.status == errSecSuccess && !shared.value.empty()) {
                g_sharedOsCryptSecret = std::move(shared.value);
                g_sharedOsCryptSource = "shared-v1";
            } else if (IsKeychainAccessError(shared.status)) {
                Napi::Error::New(env, "Yunsen Power shared encryption key access was denied").ThrowAsJavaScriptException();
                return env.Null();
            } else {
                const struct {
                    const char* service;
                    const char* account;
                    const char* source;
                } legacyCandidates[] = {
                    {"Chromium Safe Storage", "Chromium", "legacy-chromium"},
                    {"Chrome Safe Storage", "Chrome", "legacy-chrome"},
                };

                for (const auto& candidate : legacyCandidates) {
                    auto legacy = ReadGenericPassword(candidate.service, candidate.account);
                    if (legacy.status == errSecSuccess && !legacy.value.empty()) {
                        g_sharedOsCryptSecret = std::move(legacy.value);
                        g_sharedOsCryptSource = candidate.source;
                        break;
                    }
                    if (IsKeychainAccessError(legacy.status)) {
                        Napi::Error::New(env, "Legacy Chromium encryption key access was denied").ThrowAsJavaScriptException();
                        return env.Null();
                    }
                }

                if (g_sharedOsCryptSecret.empty()) {
                    if (hasExistingProfiles) {
                        Napi::Error::New(
                            env,
                            "Existing browser profiles were found, but no compatible Safe Storage key could be imported"
                        ).ThrowAsJavaScriptException();
                        return env.Null();
                    }
                    g_sharedOsCryptSecret = GenerateChromiumCompatiblePassword();
                    g_sharedOsCryptSource = "generated";
                    if (g_sharedOsCryptSecret.empty()) {
                        Napi::Error::New(env, "Failed to generate shared encryption key").ThrowAsJavaScriptException();
                        return env.Null();
                    }
                }

                const OSStatus addStatus = AddGenericPassword(
                    kSharedOsCryptService,
                    kSharedOsCryptAccount,
                    g_sharedOsCryptSecret);
                if (addStatus == errSecDuplicateItem) {
                    auto persisted = ReadGenericPassword(kSharedOsCryptService, kSharedOsCryptAccount);
                    if (persisted.status == errSecSuccess && !persisted.value.empty()) {
                        std::fill(g_sharedOsCryptSecret.begin(), g_sharedOsCryptSecret.end(), 0);
                        g_sharedOsCryptSecret = std::move(persisted.value);
                        g_sharedOsCryptSource = "shared-v1";
                    } else {
                        std::fill(g_sharedOsCryptSecret.begin(), g_sharedOsCryptSecret.end(), 0);
                        g_sharedOsCryptSecret.clear();
                        Napi::Error::New(env, "A concurrent shared encryption key could not be read").ThrowAsJavaScriptException();
                        return env.Null();
                    }
                } else if (addStatus != errSecSuccess) {
                    std::fill(g_sharedOsCryptSecret.begin(), g_sharedOsCryptSecret.end(), 0);
                    g_sharedOsCryptSecret.clear();
                    Napi::Error::New(env, "Failed to store Yunsen Power shared encryption key").ThrowAsJavaScriptException();
                    return env.Null();
                }
            }
        }

        Napi::Object result = Napi::Object::New(env);
        result.Set("secret", Napi::Buffer<uint8_t>::Copy(
            env,
            g_sharedOsCryptSecret.data(),
            g_sharedOsCryptSecret.size()));
        result.Set("version", Napi::Number::New(env, 1));
        result.Set("source", Napi::String::New(env, g_sharedOsCryptSource));
        result.Set("keyId", Napi::String::New(env, SecretKeyId(g_sharedOsCryptSecret)));
        return result;
#else
        Napi::Error::New(env, "macOS shared encryption keys are not supported on this platform").ThrowAsJavaScriptException();
        return env.Null();
#endif
    }

    // Send mouse event with popup window matching
    // This finds and matches popup windows between master and slave processes
    Napi::Value SendMouseEventWithPopupMatching(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();

        if (info.Length() < 5) {
            Napi::TypeError::New(env, "Wrong number of arguments: masterPid, slavePid, x, y, eventType");
        }

        int masterPid = info[0].As<Napi::Number>().Int32Value();
        int slavePid = info[1].As<Napi::Number>().Int32Value();
        int x = info[2].As<Napi::Number>().Int32Value();
        int y = info[3].As<Napi::Number>().Int32Value();
        std::string eventType = info[4].As<Napi::String>().Utf8Value();

#ifdef _WIN32
        // Find main windows
        auto masterWindows = FindWindowsByPid(masterPid);
        auto slaveWindows = FindWindowsByPid(slavePid);

        if (masterWindows.empty() || slaveWindows.empty()) {
            return Napi::Boolean::New(env, false);
        }

        WindowInfo* masterMainWindow = nullptr;
        WindowInfo* slaveMainWindow = nullptr;

        for (auto& win : masterWindows) {
            if (!win.isExtension) {
                masterMainWindow = &win;
                break;
            }
        }

        for (auto& win : slaveWindows) {
            if (!win.isExtension) {
                slaveMainWindow = &win;
                break;
            }
        }

        if (!masterMainWindow || !slaveMainWindow) {
            return Napi::Boolean::New(env, false);
        }

        // Find popup windows
        std::vector<HWND> masterPopups = FindPopupWindows(masterPid);
        std::vector<HWND> slavePopups = FindPopupWindows(slavePid);

        // Debug: Log popup window counts
        char debugMsg[256];
        sprintf_s(debugMsg, "[C++] Found %zu master popups, %zu slave popups for event '%s'",
                 masterPopups.size(), slavePopups.size(), eventType.c_str());
        OutputDebugStringA(debugMsg);

        // Check if click is on a master popup window
        HWND masterClickedPopup = nullptr;
        for (HWND popup : masterPopups) {
            RECT popupRect;
            GetWindowRect(popup, &popupRect);

            if (x >= popupRect.left && x <= popupRect.right &&
                y >= popupRect.top && y <= popupRect.bottom) {
                masterClickedPopup = popup;
                sprintf_s(debugMsg, "[C++] Click on master popup at (%d, %d)", x, y);
                OutputDebugStringA(debugMsg);
                break;
            }
        }

        HWND targetWindow = slaveMainWindow->hwnd;
        int targetX = x;
        int targetY = y;

        // If clicked on a popup, find matching slave popup
        if (masterClickedPopup) {
            HWND matchingSlavePopup = FindMatchingPopup(
                masterMainWindow->hwnd, masterClickedPopup,
                slaveMainWindow->hwnd, slavePopups);

            if (matchingSlavePopup) {
                targetWindow = matchingSlavePopup;

                // Calculate coordinates relative to the popup window
                RECT masterPopupRect, slavePopupRect;
                GetWindowRect(masterClickedPopup, &masterPopupRect);
                GetWindowRect(matchingSlavePopup, &slavePopupRect);

                // Convert master coordinates to relative position within popup
                int relX = x - masterPopupRect.left;
                int relY = y - masterPopupRect.top;

                // Apply to slave popup
                targetX = slavePopupRect.left + relX;
                targetY = slavePopupRect.top + relY;
            }
        } else {
            // No popup clicked, calculate position for slave main window
            RECT masterMainRect, slaveMainRect;
            GetWindowRect(masterMainWindow->hwnd, &masterMainRect);
            GetWindowRect(slaveMainWindow->hwnd, &slaveMainRect);

            // Calculate relative position in master window
            double relX = (double)(x - masterMainRect.left) / (masterMainRect.right - masterMainRect.left);
            double relY = (double)(y - masterMainRect.top) / (masterMainRect.bottom - masterMainRect.top);

            // Apply to slave window
            targetX = slaveMainRect.left + (int)(relX * (slaveMainRect.right - slaveMainRect.left));
            targetY = slaveMainRect.top + (int)(relY * (slaveMainRect.bottom - slaveMainRect.top));
        }

        // Calculate client coordinates relative to target window
        RECT targetRect;
        GetWindowRect(targetWindow, &targetRect);
        int clientX = targetX - targetRect.left;
        int clientY = targetY - targetRect.top;
        LPARAM lParam = MAKELPARAM(clientX, clientY);

        // For right-click events, we need to move the cursor to ensure Chrome's GetCursorPos()
        // returns the correct position for context menu display
        // Strategy: For each window independently:
        // - Move cursor to target position
        // - Wait for system to recognize position
        // - Send message synchronously (SendMessage)
        // - Wait for Chrome to process and call GetCursorPos()
        // - Restore cursor to original position
        // This is called separately for each slave window
        bool isRightClick = (eventType == "rightdown" || eventType == "rightup");

        POINT originalCursorPos;
        if (isRightClick) {
            // Save current cursor position before any movement
            GetCursorPos(&originalCursorPos);

            // Move cursor to target position (screen coordinates)
            SetCursorPos(targetX, targetY);

            // Longer delay to ensure system and Chrome recognize the cursor position
            // Chrome calls GetCursorPos() when handling right-click events
            Sleep(15);

            sprintf_s(debugMsg, "[C++] Moved cursor from (%ld, %ld) to (%d, %d) for %s",
                     originalCursorPos.x, originalCursorPos.y, targetX, targetY, eventType.c_str());
            OutputDebugStringA(debugMsg);
        }

        // Send event - use SendMessage (synchronous) for right-click to ensure processing
        if (eventType == "mousemove") {
            PostMessage(targetWindow, WM_MOUSEMOVE, 0, lParam);
        } else if (eventType == "mousedown") {
            PostMessage(targetWindow, WM_LBUTTONDOWN, MK_LBUTTON, lParam);
        } else if (eventType == "mouseup") {
            PostMessage(targetWindow, WM_LBUTTONUP, 0, lParam);
        } else if (eventType == "rightdown") {
            // Use SendMessage (sync) to ensure message is processed before continuing
            SendMessage(targetWindow, WM_RBUTTONDOWN, MK_RBUTTON, lParam);

            // Wait a bit before restoring to ensure Chrome has time to process
            Sleep(10);
            SetCursorPos(originalCursorPos.x, originalCursorPos.y);

            sprintf_s(debugMsg, "[C++] Sent WM_RBUTTONDOWN, restored cursor to (%ld, %ld)",
                     originalCursorPos.x, originalCursorPos.y);
            OutputDebugStringA(debugMsg);
        } else if (eventType == "rightup") {
            // Use SendMessage (sync) to ensure message is processed
            SendMessage(targetWindow, WM_RBUTTONUP, 0, lParam);

            // Wait longer for context menu to be triggered before restoring cursor
            // Chrome needs time to process the right-click and call GetCursorPos()
            // The menu appears during rightup processing
            Sleep(50);

            SetCursorPos(originalCursorPos.x, originalCursorPos.y);

            sprintf_s(debugMsg, "[C++] Restored cursor to (%ld, %ld) after rightup + 50ms delay",
                     originalCursorPos.x, originalCursorPos.y);
            OutputDebugStringA(debugMsg);
        } else {
            return Napi::Boolean::New(env, false);
        }

#elif __APPLE__
        // TODO: Implement for macOS
        return Napi::Boolean::New(env, false);
#endif

        return Napi::Boolean::New(env, true);
    }
};

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    return WindowManager::Init(env, exports);
}

NODE_API_MODULE(window_addon, Init)
