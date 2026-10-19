package engine

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
)

type nativeGMSHardwareContext struct {
	Input           wamsysMaterialInput
	State           NativeState
	Fields          map[string]string
	Release         string
	SDK             int
	Model           string
	Display         string
	Device          string
	Brand           string
	Manufacturer    string
	BuildID         string
	BuildTimeMillis int64
	Fingerprint     string
	SecurityPatch   string
	SupportedABIs   []string
}

func nativeGMSHardwareHooks(ctx nativeGMSHardwareContext) map[string]any {
	return map[string]any{
		"systemProperties": nativePlayIntegritySystemProperties(ctx),
		"systemFeatures":   nativePlayIntegritySystemFeatures(),
		"settingsGlobal":   nativePlayIntegritySettingsGlobal(ctx),
		"settingsSecure":   nativePlayIntegritySettingsSecure(ctx),
		"settingsSystem":   nativePlayIntegritySettingsSystem(ctx),
		"linux":            nativePlayIntegrityLinux(ctx),
		"java":             nativePlayIntegrityJava(ctx),
		"cpu":              nativePlayIntegrityCPU(ctx),
		"filesystem":       nativePlayIntegrityFilesystem(ctx),
	}
}

func nativePlayIntegritySystemProperties(ctx nativeGMSHardwareContext) map[string]any {
	locale := nativePlayIntegrityLocale(ctx)
	timeZone := nativePlayIntegrityTimeZone(locale.Country)
	return map[string]any{
		"ro.product.brand":                ctx.Brand,
		"ro.product.manufacturer":         ctx.Manufacturer,
		"ro.product.model":                ctx.Model,
		"ro.product.name":                 ctx.Device,
		"ro.product.device":               ctx.Device,
		"ro.build.fingerprint":            ctx.Fingerprint,
		"ro.build.id":                     ctx.BuildID,
		"ro.build.display.id":             ctx.Display,
		"ro.build.version.release":        ctx.Release,
		"ro.build.version.sdk":            strconv.Itoa(ctx.SDK),
		"ro.build.version.security_patch": ctx.SecurityPatch,
		"ro.build.version.incremental":    ctx.BuildID,
		"ro.product.cpu.abi":              "arm64-v8a",
		"ro.product.cpu.abi2":             "armeabi-v7a",
		"ro.product.cpu.abilist":          strings.Join(ctx.SupportedABIs, ","),
		"ro.product.cpu.abilist64":        "arm64-v8a",
		"ro.product.first_api_level":      strconv.Itoa(nativePlayIntegrityInitialSDK(ctx.SDK)),
		"ro.board.first_api_level":        strconv.Itoa(nativePlayIntegrityInitialSDK(ctx.SDK)),
		"ro.vendor.api_level":             strconv.Itoa(nativePlayIntegrityInitialSDK(ctx.SDK)),
		"ro.hardware":                     ctx.Device,
		"ro.bootloader":                   "unknown",
		"ro.boot.verifiedbootstate":       "green",
		"ro.boot.flash.locked":            "1",
		"ro.boot.vbmeta.device_state":     "locked",
		"ro.boot.veritymode":              "enforcing",
		"ro.boot.warranty_bit":            "0",
		"ro.secure":                       "1",
		"ro.debuggable":                   "0",
		"ro.adb.secure":                   "1",
		"ro.kernel.qemu":                  "0",
		"service.adb.root":                "0",
		"persist.sys.locale":              locale.Tag,
		"persist.sys.timezone":            timeZone.ID,
		"dalvik.vm.isa.arm64.variant":     "generic",
		"dalvik.vm.isa.arm64.features":    "default",
	}
}

func nativePlayIntegritySystemFeatures() map[string]any {
	return map[string]any{
		"android.hardware.audio.output":         true,
		"android.hardware.bluetooth":            true,
		"android.hardware.camera":               true,
		"android.hardware.camera.autofocus":     true,
		"android.hardware.faketouch":            true,
		"android.hardware.fingerprint":          true,
		"android.hardware.location":             true,
		"android.hardware.location.gps":         true,
		"android.hardware.location.network":     true,
		"android.hardware.nfc":                  false,
		"android.hardware.ram.normal":           true,
		"android.hardware.sensor.accelerometer": true,
		"android.hardware.sensor.compass":       true,
		"android.hardware.sensor.gyroscope":     true,
		"android.hardware.telephony":            true,
		"android.hardware.touchscreen":          true,
		"android.hardware.usb.host":             true,
		"android.hardware.wifi":                 true,
		"android.software.device_admin":         true,
		"android.software.webview":              true,
	}
}

func nativePlayIntegritySettingsGlobal(ctx nativeGMSHardwareContext) map[string]any {
	return map[string]any{
		"adb_enabled":                  0,
		"airplane_mode_on":             nativePlayIntegrityIntField(ctx.Fields, "airplane_mode_on", 0),
		"development_settings_enabled": 0,
		"stay_on_while_plugged_in":     0,
		"wifi_on":                      1,
	}
}

func nativePlayIntegritySettingsSecure(ctx nativeGMSHardwareContext) map[string]any {
	return map[string]any{
		"android_id":                    nativeSyntheticAndroidID(ctx.State),
		"install_non_market_apps":       "0",
		"location_mode":                 "3",
		"mock_location":                 "0",
		"bluetooth_address":             nativePlayIntegrityBluetoothAddress(ctx.State),
		"bluetooth_name":                nativeDeviceDisplayName(ctx.State),
		"enabled_input_methods":         "com.google.android.inputmethod.latin/.LatinIME",
		"default_input_method":          "com.google.android.inputmethod.latin/.LatinIME",
		"selected_input_method_subtype": "0",
	}
}

func nativePlayIntegritySettingsSystem(ctx nativeGMSHardwareContext) map[string]any {
	_ = ctx
	return map[string]any{
		"accelerometer_rotation": "1",
		"screen_brightness":      "160",
		"screen_off_timeout":     "30000",
		"time_12_24":             "24",
	}
}

func nativePlayIntegrityLinux(ctx nativeGMSHardwareContext) map[string]any {
	now := nativeWamsysNow(ctx.Input)
	pid := nativePlayIntegrityProcessID(ctx)
	return map[string]any{
		"cwd":                  "/",
		"pid":                  pid,
		"tid":                  pid,
		"timeUnixSeconds":      now.Unix(),
		"elapsedRealtimeNanos": nativePlayIntegrityElapsedRealtimeNanos(ctx, now),
		"uname": map[string]any{
			"sysname":    "Linux",
			"nodename":   "localhost",
			"release":    nativePlayIntegrityKernelRelease(ctx.SDK),
			"version":    "#1 SMP PREEMPT",
			"machine":    "aarch64",
			"domainname": "(none)",
		},
	}
}

func nativePlayIntegrityJava(ctx nativeGMSHardwareContext) map[string]any {
	locale := nativePlayIntegrityLocale(ctx)
	timeZone := nativePlayIntegrityTimeZone(locale.Country)
	return map[string]any{
		"package":          nativePlayIntegrityPackage(ctx),
		"display":          nativePlayIntegrityDisplay(ctx),
		"displayCutout":    nativePlayIntegrityDisplayCutout(ctx),
		"sensor":           nativePlayIntegritySensor(ctx),
		"telephony":        nativePlayIntegrityTelephony(ctx),
		"battery":          nativePlayIntegrityBattery(ctx),
		"network":          nativePlayIntegrityNetwork(),
		"bluetooth":        nativePlayIntegrityBluetooth(ctx),
		"input":            nativePlayIntegrityInput(ctx),
		"account":          map[string]any{"accounts": []map[string]any{}},
		"location":         nativePlayIntegrityLocation(),
		"clipboard":        nativePlayIntegrityClipboard(),
		"mediaCodec":       nativePlayIntegrityMediaCodec(),
		"webView":          nativePlayIntegrityWebView(ctx),
		"locale":           locale.Map(),
		"timeZone":         timeZone.Map(),
		"storage":          nativePlayIntegrityStorage(),
		"packageInventory": nativePlayIntegrityPackageInventory(ctx),
		"intentResolution": nativePlayIntegrityIntentResolution(),
	}
}

func nativePlayIntegrityPackage(ctx nativeGMSHardwareContext) map[string]any {
	return map[string]any{
		"packageName":                           "com.google.android.gms",
		"installerPackageName":                  "com.android.vending",
		"processExe":                            "/system/bin/app_process64",
		"nativeMapsPath":                        "/data/app/com.google.android.gms/lib/arm64/libdroidguard.so",
		"cacheDir":                              "/data/user/0/com.google.android.gms/cache",
		"publicSourceDir":                       "/data/app/com.google.android.gms/base.apk",
		"deviceProtectedDataDir":                "/data/user_de/0/com.google.android.gms",
		"signingInfoHasMultipleSigners":         false,
		"signingInfoHasPastSigningCertificates": false,
		"hasSigningCertificate":                 false,
	}
}

func nativePlayIntegrityDisplay(ctx nativeGMSHardwareContext) map[string]any {
	width := 1080 + nativePlayIntegrityStableInt(ctx.State, "display-width-step", 0, 2)*360
	height := 2400 + nativePlayIntegrityStableInt(ctx.State, "display-height-step", 0, 3)*180
	density := 420 + nativePlayIntegrityStableInt(ctx.State, "display-density-step", 0, 3)*40
	return map[string]any{
		"widthPixels":  width,
		"heightPixels": height,
		"densityDpi":   density,
		"rotation":     0,
	}
}

func nativePlayIntegrityDisplayCutout(ctx nativeGMSHardwareContext) map[string]any {
	_ = ctx
	return map[string]any{
		"present":         false,
		"safeInsetTop":    0,
		"safeInsetBottom": 0,
		"safeInsetLeft":   0,
		"safeInsetRight":  0,
		"boundingRects":   []map[string]any{},
	}
}

func nativePlayIntegritySensor(ctx nativeGMSHardwareContext) map[string]any {
	names := []string{"BMI160 accelerometer", "ICM426xx accelerometer", "LSM6DSO accelerometer"}
	vendors := []string{"Bosch", "TDK", "STMicroelectronics"}
	index := nativePlayIntegrityStableInt(ctx.State, "sensor-profile", 0, len(names))
	return map[string]any{
		"name":         names[index],
		"vendor":       vendors[index],
		"version":      1,
		"type":         1,
		"maximumRange": 78.4532,
		"resolution":   0.0023956299,
		"power":        0.18,
		"minDelay":     5000,
	}
}

func nativePlayIntegrityTelephony(ctx nativeGMSHardwareContext) map[string]any {
	networkCountry := strings.ToLower(nativePlayIntegrityLocale(ctx).Country)
	networkOperator := nativePlayIntegrityOperator(ctx.Fields, "mcc", "mnc")
	simOperator := nativePlayIntegrityOperator(ctx.Fields, "sim_mcc", "sim_mnc")
	operatorName := shared.FirstNonEmpty(ctx.Fields["network_operator_name"], ctx.Fields["sim_operator_name"])
	return map[string]any{
		"phoneType":           1,
		"phoneCount":          1,
		"networkCountryIso":   networkCountry,
		"simCountryIso":       networkCountry,
		"networkOperator":     networkOperator,
		"simOperator":         simOperator,
		"networkOperatorName": operatorName,
		"simOperatorName":     shared.FirstNonEmpty(ctx.Fields["sim_operator_name"], operatorName),
	}
}

func nativePlayIntegrityBattery(ctx nativeGMSHardwareContext) map[string]any {
	level := nativePlayIntegrityStableInt(ctx.State, "battery-level", 52, 47)
	return map[string]any{
		"charging":       true,
		"capacity":       100,
		"chargeCounter":  level * 35000,
		"currentNow":     -120000,
		"currentAverage": -80000,
		"energyCounter":  int64(12000000000),
		"status":         2,
		"plugged":        1,
		"health":         2,
		"level":          level,
		"scale":          100,
		"voltage":        3900 + nativePlayIntegrityStableInt(ctx.State, "battery-voltage", 0, 500),
		"temperature":    290 + nativePlayIntegrityStableInt(ctx.State, "battery-temp", 0, 35),
		"technology":     "Li-ion",
		"present":        true,
	}
}

func nativePlayIntegrityNetwork() map[string]any {
	return map[string]any{
		"connected":      true,
		"available":      true,
		"metered":        false,
		"roaming":        false,
		"failover":       false,
		"type":           1,
		"subtype":        0,
		"typeName":       "WIFI",
		"subtypeName":    "",
		"extraInfo":      "",
		"interfaceName":  "wlan0",
		"transports":     []int{1},
		"capabilities":   []int{12, 13, 14, 15, 16, 18},
		"downstreamKbps": 100000,
		"upstreamKbps":   50000,
	}
}

func nativePlayIntegrityBluetooth(ctx nativeGMSHardwareContext) map[string]any {
	return map[string]any{
		"enabled":       false,
		"state":         10,
		"scanMode":      20,
		"address":       nativePlayIntegrityBluetoothAddress(ctx.State),
		"name":          nativeDeviceDisplayName(ctx.State),
		"bondedDevices": []map[string]any{},
	}
}

func nativePlayIntegrityInput(ctx nativeGMSHardwareContext) map[string]any {
	return map[string]any{"devices": []map[string]any{{
		"id":           1,
		"name":         "gpio-keys",
		"descriptor":   "safe-gpio-keys-" + shared.StableID(ctx.Device),
		"sources":      0x00000101,
		"keyboardType": 1,
		"vendorId":     0,
		"productId":    0,
		"external":     false,
		"virtual":      false,
		"enabled":      true,
		"vibrator":     false,
	}}}
}

func nativePlayIntegrityLocation() map[string]any {
	return map[string]any{
		"enabled":            false,
		"providers":          []string{"gps", "network"},
		"lastKnownLocations": map[string]any{},
	}
}

func nativePlayIntegrityClipboard() map[string]any {
	return map[string]any{
		"hasPrimaryClip": false,
		"text":           "",
		"label":          "",
		"mimeTypes":      []string{"text/plain"},
	}
}

func nativePlayIntegrityMediaCodec() map[string]any {
	return map[string]any{"codecs": []map[string]any{{
		"name":                "c2.android.avc.decoder",
		"encoder":             false,
		"types":               []string{"video/avc"},
		"hardwareAccelerated": false,
		"softwareOnly":        true,
		"vendor":              false,
		"alias":               false,
	}}}
}

func nativePlayIntegrityWebView(ctx nativeGMSHardwareContext) map[string]any {
	return map[string]any{
		"packageName":             "com.google.android.webview",
		"versionCode":             125000000 + nativePlayIntegrityStableInt(ctx.State, "webview-version", 0, 9000000),
		"versionName":             "125.0." + strconv.Itoa(6400+nativePlayIntegrityStableInt(ctx.State, "webview-build", 0, 300)) + ".0",
		"userAgent":               "Mozilla/5.0 (Linux; Android " + ctx.Release + ") AppleWebKit/537.36 Mobile Safari/537.36",
		"acceptCookie":            true,
		"acceptThirdPartyCookies": false,
	}
}

func nativePlayIntegrityStorage() map[string]any {
	return map[string]any{"volumes": []map[string]any{{
		"uuid":                 "",
		"state":                "mounted",
		"path":                 "/storage/emulated/0",
		"directory":            "/storage/emulated/0",
		"description":          "Internal shared storage",
		"mediaStoreVolumeName": "external_primary",
		"primary":              true,
		"emulated":             true,
		"removable":            false,
	}}}
}

func nativePlayIntegrityPackageInventory(ctx nativeGMSHardwareContext) map[string]any {
	waVersion := NativeAppVersion(ctx.Input.AppVersion)
	waSourceDir := nativeStableGPIASourceDir(ctx.State)
	return map[string]any{"packages": []map[string]any{
		{
			"packageName":      "com.google.android.gms",
			"versionCode":      262433035,
			"versionName":      "26.24.33",
			"uid":              10123,
			"enabled":          true,
			"flags":            1,
			"firstInstallTime": ctx.BuildTimeMillis,
			"lastUpdateTime":   ctx.BuildTimeMillis,
			"publicSourceDir":  "/data/app/com.google.android.gms/base.apk",
			"sourceDir":        "/data/app/com.google.android.gms/base.apk",
		},
		{
			"packageName":      "com.android.vending",
			"versionCode":      84611300,
			"versionName":      "46.1.13-31",
			"uid":              10109,
			"enabled":          true,
			"flags":            1,
			"firstInstallTime": ctx.BuildTimeMillis,
			"lastUpdateTime":   ctx.BuildTimeMillis,
			"publicSourceDir":  "/data/app/com.android.vending/base.apk",
			"sourceDir":        "/data/app/com.android.vending/base.apk",
		},
		{
			"packageName":      nativeGPIAPackageName,
			"versionCode":      nativeWAAppVersionCode(ctx.Input.AppVersion),
			"versionName":      waVersion,
			"uid":              10234,
			"enabled":          true,
			"flags":            1,
			"firstInstallTime": ctx.BuildTimeMillis,
			"lastUpdateTime":   nativeWamsysNow(ctx.Input).UnixMilli(),
			"publicSourceDir":  waSourceDir,
			"sourceDir":        waSourceDir,
		},
	}}
}

func nativePlayIntegrityIntentResolution() map[string]any {
	return map[string]any{
		"activities": []map[string]any{{
			"packageName": "com.android.vending",
			"name":        "com.google.android.finsky.activities.MainActivity",
			"label":       "Play Store",
			"priority":    0,
			"match":       0,
			"default":     true,
			"enabled":     true,
			"exported":    true,
		}},
		"services":  []map[string]any{},
		"receivers": []map[string]any{},
	}
}

func nativePlayIntegrityCPU(ctx nativeGMSHardwareContext) map[string]any {
	maxFreq := 2200000 + nativePlayIntegrityStableInt(ctx.State, "cpu-max-freq", 0, 600000)
	curFreq := maxFreq - nativePlayIntegrityStableInt(ctx.State, "cpu-cur-delta", 120000, 500000)
	return map[string]any{
		"online":         "0-7",
		"possible":       "0-7",
		"present":        "0-7",
		"implementer":    "0x51",
		"architecture":   "8",
		"variant":        "0x1",
		"part":           "0xd0c",
		"revision":       "0",
		"scalingCurFreq": curFreq,
		"scalingMaxFreq": maxFreq,
		"scalingMinFreq": 300000,
	}
}

func nativePlayIntegrityFilesystem(ctx nativeGMSHardwareContext) map[string]any {
	cpu := nativePlayIntegrityCPU(ctx)
	memTotalKB := nativePlayIntegrityMemoryTotalKB(ctx)
	waSourceDir := nativeStableGPIASourceDir(ctx.State)
	return map[string]any{
		"pathExists": map[string]any{
			waSourceDir: true,
			"/data/app/com.google.android.gms/base.apk": true,
			"/data/app/com.android.vending/base.apk":    true,
			"/system/bin/su":                            false,
			"/system/xbin/su":                           false,
			"/sbin/su":                                  false,
			"/su/bin/su":                                false,
			"/system/app/Superuser.apk":                 false,
			"/data/adb/magisk":                          false,
			"/system/bin/magisk":                        false,
			"/proc/tty/drivers":                         true,
			"/sys/module/kvm":                           false,
			"/sys/module/vboxguest":                     false,
			"/sys/module/vmw_pvscsi":                    false,
		},
		"linkTargets": map[string]any{
			"/proc/self/exe": "/system/bin/app_process64",
		},
		"directories": []string{
			"/data",
			"/data/app",
			"/data/user/0/com.google.android.gms",
			"/data/user/0/com.whatsapp",
			"/proc",
			"/sys",
			"/system",
			"/vendor",
		},
		"files": map[string]any{
			"/proc/cpuinfo":                                         map[string]any{"text": nativePlayIntegrityCPUInfo(cpu)},
			"/proc/meminfo":                                         map[string]any{"text": nativePlayIntegrityMemInfo(memTotalKB)},
			"/proc/sys/kernel/random/boot_id":                       map[string]any{"text": nativeStableWamsysBootID(ctx.State) + "\n"},
			"/proc/self/cmdline":                                    map[string]any{"text": "com.google.android.gms"},
			"/proc/self/status":                                     map[string]any{"text": nativePlayIntegrityProcStatus(ctx)},
			"/sys/devices/system/cpu/online":                        map[string]any{"text": "0-7\n"},
			"/sys/devices/system/cpu/possible":                      map[string]any{"text": "0-7\n"},
			"/sys/devices/system/cpu/present":                       map[string]any{"text": "0-7\n"},
			"/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq": map[string]any{"text": fmt.Sprintf("%v\n", cpu["scalingCurFreq"])},
			"/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq": map[string]any{"text": fmt.Sprintf("%v\n", cpu["scalingMaxFreq"])},
			"/sys/devices/system/cpu/cpu0/cpufreq/scaling_min_freq": map[string]any{"text": "300000\n"},
			"/sys/class/power_supply/battery/capacity":              map[string]any{"text": fmt.Sprintf("%d\n", nativePlayIntegrityStableInt(ctx.State, "battery-level", 52, 47))},
		},
	}
}

type nativePlayIntegrityLocaleProfile struct {
	Language string
	Country  string
	Tag      string
	Display  string
}

func (p nativePlayIntegrityLocaleProfile) Map() map[string]any {
	return map[string]any{
		"language":    p.Language,
		"country":     p.Country,
		"variant":     "",
		"script":      "",
		"languageTag": p.Tag,
		"displayName": p.Display,
	}
}

func nativePlayIntegrityLocale(ctx nativeGMSHardwareContext) nativePlayIntegrityLocaleProfile {
	country := registrationDeviceCountryISO(ctx.Input.Phone)
	tag := "en-" + country
	display := "English (" + country + ")"
	if country == "US" {
		display = "English (United States)"
	}
	return nativePlayIntegrityLocaleProfile{Language: "en", Country: country, Tag: tag, Display: display}
}

type nativePlayIntegrityTimeZoneProfile struct {
	ID              string
	DisplayName     string
	RawOffset       int
	DstSavings      int
	UseDaylightTime bool
}

func (p nativePlayIntegrityTimeZoneProfile) Map() map[string]any {
	return map[string]any{
		"id":              p.ID,
		"displayName":     p.DisplayName,
		"rawOffset":       p.RawOffset,
		"dstSavings":      p.DstSavings,
		"useDaylightTime": p.UseDaylightTime,
		"inDaylightTime":  false,
	}
}

func nativePlayIntegrityTimeZone(country string) nativePlayIntegrityTimeZoneProfile {
	switch strings.ToUpper(strings.TrimSpace(country)) {
	case "CN":
		return nativePlayIntegrityTimeZoneProfile{ID: "Asia/Shanghai", DisplayName: "China Standard Time", RawOffset: 28800000}
	case "GB":
		return nativePlayIntegrityTimeZoneProfile{ID: "Europe/London", DisplayName: "Greenwich Mean Time", RawOffset: 0, DstSavings: 3600000, UseDaylightTime: true}
	case "IN":
		return nativePlayIntegrityTimeZoneProfile{ID: "Asia/Kolkata", DisplayName: "India Standard Time", RawOffset: 19800000}
	case "BR":
		return nativePlayIntegrityTimeZoneProfile{ID: "America/Sao_Paulo", DisplayName: "Brasilia Time", RawOffset: -10800000}
	case "ID":
		return nativePlayIntegrityTimeZoneProfile{ID: "Asia/Jakarta", DisplayName: "Western Indonesia Time", RawOffset: 25200000}
	case "US":
		fallthrough
	default:
		return nativePlayIntegrityTimeZoneProfile{ID: "America/New_York", DisplayName: "Eastern Time", RawOffset: -18000000, DstSavings: 3600000, UseDaylightTime: true}
	}
}

func nativePlayIntegritySecurityPatch(sdk int) string {
	switch {
	case sdk >= 36:
		return "2026-05-05"
	case sdk >= 35:
		return "2026-04-05"
	case sdk >= 34:
		return "2026-03-05"
	case sdk >= 33:
		return "2025-12-05"
	default:
		return "2025-09-05"
	}
}

func nativePlayIntegrityInitialSDK(sdk int) int {
	switch {
	case sdk >= 36:
		return 34
	case sdk >= 35:
		return 33
	case sdk >= 34:
		return 31
	case sdk >= 33:
		return 30
	default:
		return sdk
	}
}

func nativePlayIntegrityKernelRelease(sdk int) string {
	if sdk >= 35 {
		return "6.1.0-android14"
	}
	if sdk >= 33 {
		return "5.15.0-android13"
	}
	return "5.10.0-android"
}

func nativePlayIntegrityProcessID(ctx nativeGMSHardwareContext) int {
	value, err := strconv.Atoi(nativeRuntimeProcessID(ctx.State))
	if err == nil && value > 0 {
		return value
	}
	return nativePlayIntegrityStableInt(ctx.State, "pid", 2000, 28000)
}

func nativePlayIntegrityElapsedRealtimeNanos(ctx nativeGMSHardwareContext, now time.Time) int64 {
	createdUnix := nativeWamsysStateCreatedUnix(ctx.State)
	ageSeconds := int64(300)
	if createdUnix > 0 && now.Unix() > createdUnix {
		ageSeconds = now.Unix() - createdUnix
	}
	ageSeconds += int64(nativePlayIntegrityStableInt(ctx.State, "elapsed-extra", 30, 270))
	return ageSeconds * int64(time.Second)
}

func nativePlayIntegrityOperator(fields map[string]string, mccKey string, mncKey string) string {
	mcc := strings.TrimSpace(fields[mccKey])
	mnc := strings.TrimSpace(fields[mncKey])
	if mcc == "" {
		mcc = "000"
	}
	if mnc == "" {
		mnc = "000"
	}
	return mcc + mnc
}

func nativePlayIntegrityIntField(fields map[string]string, key string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(fields[key]))
	if err != nil {
		return fallback
	}
	return value
}

func nativePlayIntegrityMemoryTotalKB(ctx nativeGMSHardwareContext) int {
	ramGiB, err := strconv.ParseFloat(shared.FirstNonEmpty(ctx.Fields["device_ram"], nativeDefaultDeviceRAMGiB), 64)
	if err != nil || ramGiB <= 0 {
		ramGiB = 6.58
	}
	return int(ramGiB * 1024 * 1024)
}

func nativePlayIntegrityCPUInfo(cpu map[string]any) string {
	var b strings.Builder
	for i := 0; i < 8; i++ {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString("processor\t: ")
		b.WriteString(strconv.Itoa(i))
		b.WriteString("\nBogoMIPS\t: 38.40\nFeatures\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics\nCPU implementer\t: ")
		b.WriteString(fmt.Sprintf("%v", cpu["implementer"]))
		b.WriteString("\nCPU architecture: ")
		b.WriteString(fmt.Sprintf("%v", cpu["architecture"]))
		b.WriteString("\nCPU variant\t: ")
		b.WriteString(fmt.Sprintf("%v", cpu["variant"]))
		b.WriteString("\nCPU part\t: ")
		b.WriteString(fmt.Sprintf("%v", cpu["part"]))
		b.WriteString("\nCPU revision\t: ")
		b.WriteString(fmt.Sprintf("%v", cpu["revision"]))
		b.WriteByte('\n')
	}
	return b.String()
}

func nativePlayIntegrityMemInfo(totalKB int) string {
	available := totalKB * 62 / 100
	free := totalKB * 24 / 100
	return fmt.Sprintf("MemTotal:       %8d kB\nMemFree:        %8d kB\nMemAvailable:   %8d kB\nBuffers:          124000 kB\nCached:          1824000 kB\nSwapCached:            0 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n", totalKB, free, available)
}

func nativePlayIntegrityProcStatus(ctx nativeGMSHardwareContext) string {
	pid := nativePlayIntegrityProcessID(ctx)
	ppid := pid - 1
	if ppid < 1 {
		ppid = 1
	}
	return fmt.Sprintf("Name:\troid.gms.unstable\nUmask:\t0077\nState:\tS (sleeping)\nTgid:\t%d\nPid:\t%d\nPPid:\t%d\nTracerPid:\t0\nUid:\t10123\t10123\t10123\t10123\nGid:\t10123\t10123\t10123\t10123\n", pid, pid, ppid)
}

func nativePlayIntegrityBluetoothAddress(state NativeState) string {
	sum := sha256.Sum256([]byte(nativeStableRuntimeSeed(state, "bluetooth-address")))
	raw := []byte{0x02, sum[0], sum[1], sum[2], sum[3], sum[4]}
	parts := make([]string, 0, len(raw))
	for _, value := range raw {
		parts = append(parts, fmt.Sprintf("%02X", value))
	}
	return strings.Join(parts, ":")
}

func nativePlayIntegrityStableInt(state NativeState, label string, min int, spread int) int {
	if spread <= 0 {
		return min
	}
	sum := sha256.Sum256([]byte(nativeStableRuntimeSeed(state, label)))
	return min + int(binary.BigEndian.Uint64(sum[:8])%uint64(spread))
}
